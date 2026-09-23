import { t } from '../shared/i18n';
import type { PageCommand } from '../shared/messages';
import type { ActiveTranslator } from '../shared/translation-engines';

export const PAGE_TRANSLATION_MENU_ID = 'just-translate-page';
export const SELECTION_TRANSLATION_MENU_ID = 'just-translate-selection';
export const RETRY_FAILED_MENU_ID = 'just-translate-retry-failed';

interface ContextMenuApi {
  removeAll: () => Promise<void>;
  create: (properties: chrome.contextMenus.CreateProperties) => Promise<void>;
}
interface ContextMenuTitleApi {
  update: (
    id: string,
    properties: Pick<chrome.contextMenus.CreateProperties, 'title'>,
  ) => Promise<void>;
}

type TabMessageSender = (
  tabId: number,
  command: PageCommand,
  options: { frameId: number } | { documentId: string },
) => Promise<unknown>;

const titled = (title: string, translatorName: string): string =>
  translatorName ? `${title} · ${translatorName}` : title;

const pageTranslationMenuProperties = (
  translatorName = '',
): Omit<chrome.contextMenus.CreateProperties, 'id'> => ({
  title: titled(t('立即翻译'), translatorName),
  contexts: ['page'],
  documentUrlPatterns: ['http://*/*', 'https://*/*'],
});

export const retryFailedMenuProperties = (): chrome.contextMenus.CreateProperties => ({
  id: RETRY_FAILED_MENU_ID,
  ...pageTranslationMenuProperties(),
  title: t('重试全部失败'),
  contexts: ['all'],
});

/** Native page/selection contexts are exclusive, so only the matching translation action appears. */
export async function ensurePageTranslationMenu(
  api: ContextMenuApi,
  translatorName: string,
): Promise<void> {
  await api.removeAll();
  await api.create({
    id: PAGE_TRANSLATION_MENU_ID,
    ...pageTranslationMenuProperties(translatorName),
  });
  await api.create({
    ...pageTranslationMenuProperties(translatorName),
    id: SELECTION_TRANSLATION_MENU_ID,
    title: titled(t('翻译已选内容'), translatorName),
    contexts: ['selection'],
  });
}

/** Refreshes the two data-sending actions after a user explicitly changes the recipient. */
export async function updatePageTranslationMenuTitles(
  api: ContextMenuTitleApi,
  translatorName: string,
): Promise<void> {
  await api.update(PAGE_TRANSLATION_MENU_ID, {
    title: titled(t('立即翻译'), translatorName),
  });
  await api.update(SELECTION_TRANSLATION_MENU_ID, {
    title: titled(t('翻译已选内容'), translatorName),
  });
}

/** Starts translation without using the toggle command, so repeated clicks never restore the page. */
export async function handlePageTranslationMenuClick(
  info: Pick<chrome.contextMenus.OnClickData, 'menuItemId' | 'selectionText' | 'frameId'>,
  tabId: number | undefined,
  sendTabMessage: TabMessageSender,
  resolveDocument: (tabId: number, frameId: number) => Promise<string | undefined>,
  resolveDisplayedTranslator: () => ActiveTranslator | undefined,
): Promise<boolean> {
  if (
    ![PAGE_TRANSLATION_MENU_ID, SELECTION_TRANSLATION_MENU_ID, RETRY_FAILED_MENU_ID].includes(
      String(info.menuItemId),
    ) ||
    tabId === undefined
  )
    return false;

  try {
    if (info.menuItemId === RETRY_FAILED_MENU_ID) {
      // Retry belongs to the top document, even when the context menu was opened in an iframe.
      const documentId = await resolveDocument(tabId, 0);
      if (!documentId) return false;
      const status = await sendTabMessage(tabId, { type: 'GET_PAGE_STATUS' }, { documentId });
      if (!hasRetryableFailures(status)) return false;
      await sendTabMessage(tabId, { type: 'RETRY_FAILED_TRANSLATIONS' }, { documentId });
      return true;
    }
    // The command carries the recipient that Chrome actually disclosed when the menu was drawn.
    const translator = resolveDisplayedTranslator();
    if (!translator) return false;
    if (info.menuItemId === SELECTION_TRANSLATION_MENU_ID) {
      if (typeof info.selectionText !== 'string' || !info.selectionText.trim()) return false;
      const documentId = await resolveDocument(tabId, info.frameId ?? 0);
      if (!documentId) return false;
      await sendTabMessage(
        tabId,
        { type: 'START_SELECTION_TRANSLATION', text: info.selectionText, translator },
        { documentId },
      );
    } else {
      await sendTabMessage(tabId, { type: 'START_TRANSLATION', translator }, { frameId: 0 });
    }
    return true;
  } catch {
    return false;
  }
}

/** Treat unconnected documents and full-document failures as ineligible for paragraph retry. */
export function hasRetryableFailures(status: unknown): boolean {
  return (
    typeof status === 'object' &&
    status !== null &&
    'mode' in status &&
    status.mode === 'segmented' &&
    'failed' in status &&
    typeof status.failed === 'number' &&
    status.failed > 0
  );
}

/** Chrome menu registration is global: discard stale tab reads and serialize asynchronous writes. */
export class RetryMenuRegistration {
  private registered = false;
  private generation = 0;
  private write: Promise<void> = Promise.resolve();

  constructor(
    private readonly readActiveStatus: () => Promise<unknown>,
    private readonly updateRegistration: (registered: boolean) => Promise<void>,
  ) {}

  async refresh(): Promise<void> {
    const generation = ++this.generation;
    const status = await this.readActiveStatus().catch(() => undefined);
    const write = this.write.then(async () => {
      if (generation !== this.generation) return;
      const registered = hasRetryableFailures(status);
      if (registered === this.registered) return;
      // Commit state only after Chrome succeeds, so failed creates/removes can be retried.
      await this.updateRegistration(registered);
      this.registered = registered;
    });
    // A transient menu API error must not poison later registration updates.
    this.write = write.catch(() => {});
    await write;
  }
}
