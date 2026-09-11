import type { PageCommand } from '../shared/messages';

export const PAGE_TRANSLATION_MENU_ID = 'just-translate-page';

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
  try {
    await api.update(PAGE_TRANSLATION_MENU_ID, PAGE_TRANSLATION_MENU_PROPERTIES);
  } catch {
    api.create({
      id: PAGE_TRANSLATION_MENU_ID,
      ...PAGE_TRANSLATION_MENU_PROPERTIES,
    });
  }
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
