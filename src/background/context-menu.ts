import type { PageCommand } from '../shared/messages';

export const PAGE_TRANSLATION_MENU_ID = 'just-translate-page';
export const FULL_DOCUMENT_TRANSLATION_MENU_ID = 'just-translate-full-document';

interface ContextMenuApi {
  update: (
    id: string,
    properties: Omit<chrome.contextMenus.CreateProperties, 'id'>,
  ) => Promise<void>;
  create: (properties: chrome.contextMenus.CreateProperties) => number | string;
}

type TabMessageSender = (tabId: number, command: PageCommand) => Promise<unknown>;

const PAGE_TRANSLATION_MENU_PROPERTIES: Omit<chrome.contextMenus.CreateProperties, 'id'> = {
  title: '使用「只是翻译」翻译此网页',
  contexts: ['all'],
  documentUrlPatterns: ['http://*/*', 'https://*/*'],
};

/** Updates the persistent menu or recreates it if Chrome lost it while the worker was stopped. */
export async function ensurePageTranslationMenu(api: ContextMenuApi): Promise<void> {
  for (const [id, title] of [
    [PAGE_TRANSLATION_MENU_ID, PAGE_TRANSLATION_MENU_PROPERTIES.title],
    [FULL_DOCUMENT_TRANSLATION_MENU_ID, '全文完整翻译（保留上下文）'],
  ] as const) {
    const properties = { ...PAGE_TRANSLATION_MENU_PROPERTIES, title };
    try {
      await api.update(id, properties);
    } catch {
      api.create({ id, ...properties });
    }
  }
}

/** Starts translation without using the toggle command, so repeated clicks never restore the page. */
export async function handlePageTranslationMenuClick(
  menuItemId: string | number,
  tabId: number | undefined,
  sendTabMessage: TabMessageSender,
): Promise<boolean> {
  if (
    ![PAGE_TRANSLATION_MENU_ID, FULL_DOCUMENT_TRANSLATION_MENU_ID].includes(String(menuItemId)) ||
    tabId === undefined
  )
    return false;

  try {
    await sendTabMessage(tabId, {
      type:
        menuItemId === FULL_DOCUMENT_TRANSLATION_MENU_ID
          ? 'START_FULL_DOCUMENT_TRANSLATION'
          : 'START_TRANSLATION',
    });
    return true;
  } catch {
    return false;
  }
}
