import type { PageCommand } from '../shared/messages';

export const PAGE_TRANSLATION_MENU_ID = 'just-translate-page';
export const SELECTION_TRANSLATION_MENU_ID = 'just-translate-selection';
export const RETRY_FAILED_MENU_ID = 'just-translate-retry-failed';

interface ContextMenuApi {
  removeAll: () => Promise<void>;
  create: (properties: chrome.contextMenus.CreateProperties) => Promise<void>;
}

type TabMessageSender = (
  tabId: number,
  command: PageCommand,
  options: { frameId: number } | { documentId: string },
) => Promise<unknown>;

const PAGE_TRANSLATION_MENU_PROPERTIES: Omit<chrome.contextMenus.CreateProperties, 'id'> = {
  title: '立即翻译',
  contexts: ['page'],
  documentUrlPatterns: ['http://*/*', 'https://*/*'],
};

export const RETRY_FAILED_MENU_PROPERTIES: chrome.contextMenus.CreateProperties = {
  id: RETRY_FAILED_MENU_ID,
  ...PAGE_TRANSLATION_MENU_PROPERTIES,
  title: '重试全部失败',
  contexts: ['all'],
};

/** Native page/selection contexts are exclusive, so only the matching translation action appears. */
export async function ensurePageTranslationMenu(api: ContextMenuApi): Promise<void> {
  await api.removeAll();
  await api.create({ id: PAGE_TRANSLATION_MENU_ID, ...PAGE_TRANSLATION_MENU_PROPERTIES });
  await api.create({
    ...PAGE_TRANSLATION_MENU_PROPERTIES,
    id: SELECTION_TRANSLATION_MENU_ID,
    title: '翻译已选内容',
    contexts: ['selection'],
  });
}

/** Starts translation without using the toggle command, so repeated clicks never restore the page. */
export async function handlePageTranslationMenuClick(
  info: Pick<chrome.contextMenus.OnClickData, 'menuItemId' | 'selectionText' | 'frameId'>,
  tabId: number | undefined,
  sendTabMessage: TabMessageSender,
  resolveDocument: (tabId: number, frameId: number) => Promise<string | undefined>,
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
    if (info.menuItemId === SELECTION_TRANSLATION_MENU_ID) {
      if (typeof info.selectionText !== 'string' || !info.selectionText.trim()) return false;
      const documentId = await resolveDocument(tabId, info.frameId ?? 0);
      if (!documentId) return false;
      await sendTabMessage(
        tabId,
        { type: 'START_SELECTION_TRANSLATION', text: info.selectionText },
        { documentId },
      );
    } else {
      await sendTabMessage(tabId, { type: 'START_TRANSLATION' }, { frameId: 0 });
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
