import { resolveUiLocale, setUiLanguage, t, type UiLanguage } from '../shared/i18n';
import { getSettings } from '../shared/settings-store';
import { SETTINGS_STORAGE_KEY, mergeSettings } from '../shared/settings';
import {
  PAGE_TRANSLATION_MENU_ID,
  SELECTION_TRANSLATION_MENU_ID,
  RETRY_FAILED_MENU_ID,
} from './context-menu';

/** Updates existing menu registrations, preserving the retry menu's visibility/ownership state. */
export async function synchronizeInterfaceLanguage(preference: UiLanguage): Promise<void> {
  const locale = resolveUiLocale(preference);
  setUiLanguage(locale);
  await Promise.all([
    chrome.contextMenus.update(PAGE_TRANSLATION_MENU_ID, { title: t('立即翻译') }),
    chrome.contextMenus.update(SELECTION_TRANSLATION_MENU_ID, { title: t('翻译已选内容') }),
    // The retry menu deliberately does not exist when the active tab has no failed paragraphs.
    chrome.contextMenus.update(RETRY_FAILED_MENU_ID, { title: t('重试全部失败') }).catch(() => {}),
    chrome.action.setTitle({ title: t('只是翻译') }),
  ]);
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  await Promise.all(
    tabs
      .filter((tab) => tab.id !== undefined)
      .map((tab) =>
        chrome.tabs.sendMessage(tab.id!, { type: 'UI_LANGUAGE_CHANGED', locale }).catch(() => {}),
      ),
  );
}

/** Serialize updates and read after menu initialization. The latest durable setting always wins. */
export function initializeBackgroundLanguage(menuReady: Promise<void>): void {
  let writes = Promise.resolve();
  const refresh = () => {
    writes = writes
      .catch(() => {})
      .then(async () => {
        await menuReady;
        await synchronizeInterfaceLanguage((await getSettings()).uiLanguage);
      })
      .catch((error: unknown) => {
        console.error('Interface language synchronization failed', error);
      });
  };
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[SETTINGS_STORAGE_KEY]) return;
    const change = changes[SETTINGS_STORAGE_KEY];
    if (mergeSettings(change.oldValue).uiLanguage !== mergeSettings(change.newValue).uiLanguage)
      refresh();
  });
  refresh();
}
