import type { PageCommand } from '../shared/messages';

export const PAGE_TRANSLATION_MENU_ID = 'just-translate-page';

interface ContextMenuApi {
  removeAll: () => Promise<void>;
  create: (properties: chrome.contextMenus.CreateProperties) => Promise<void>;
}

type TabMessageSender = (tabId: number, command: PageCommand) => Promise<unknown>;

const PAGE_TRANSLATION_MENU_PROPERTIES: Omit<chrome.contextMenus.CreateProperties, 'id'> = {
  title: '使用「只是翻译」翻译此网页',
  contexts: ['all'],
  documentUrlPatterns: ['http://*/*', 'https://*/*'],
};

/** Replace this extension's persistent menu set so Chrome displays one direct action. */
export async function ensurePageTranslationMenu(api: ContextMenuApi): Promise<void> {
  await api.removeAll();
  await api.create({ id: PAGE_TRANSLATION_MENU_ID, ...PAGE_TRANSLATION_MENU_PROPERTIES });
}

/** Starts translation without using the toggle command, so repeated clicks never restore the page. */
export async function handlePageTranslationMenuClick(
  menuItemId: string | number,
  tabId: number | undefined,
  sendTabMessage: TabMessageSender,
): Promise<boolean> {
  if (menuItemId !== PAGE_TRANSLATION_MENU_ID || tabId === undefined) return false;

  try {
    await sendTabMessage(tabId, { type: 'START_TRANSLATION' });
    return true;
  } catch {
    return false;
  }
}
