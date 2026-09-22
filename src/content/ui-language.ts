import { UI_LOCALES } from '../shared/locales';
import { sendRuntimeMessage } from '../shared/chrome-api';
import { getUiLocale, isUiLanguage, setUiLanguage, subscribeUiLanguage, t } from '../shared/i18n';
import type { PageCommand, PublicTranslatorSettings } from '../shared/messages';

let initialized = false;

/** Relabels only extension status controls. Host content and completed translations remain untouched. */
export function refreshTranslationLabels(): void {
  const locale = getUiLocale();
  for (const element of document.querySelectorAll<HTMLElement>(
    '[data-justranslate-translation][data-justranslate-state="pending"], [data-justranslate-translation][data-justranslate-state="error"]',
  )) {
    if (!element.hasAttribute('aria-label')) continue; // Inline interface translations have no retry UI.
    const pending = element.dataset.justranslateState === 'pending';
    const full = element.dataset.justranslateFullStatus === 'true';
    const label = pending
      ? full
        ? t('正在翻译全文')
        : t('正在翻译')
      : full
        ? t('全文翻译失败 · 重试全文')
        : t('翻译失败 · 重试');
    element.lang = locale;
    element.dir = locale === 'ar' ? 'rtl' : 'ltr';
    element.setAttribute('aria-label', label);
    if (!pending) element.textContent = label;
  }
}

/** Register before reading settings, so a later broadcast wins over an older initial response. */
export function initializeContentLanguage(): void {
  if (initialized) return;
  initialized = true;
  let revision = 0;
  const refresh = () => {
    const request = ++revision;
    void sendRuntimeMessage<PublicTranslatorSettings>({ type: 'GET_PUBLIC_SETTINGS' })
      .then((result) => {
        if (revision === request && result.ok && isUiLanguage(result.data?.uiLanguage))
          setUiLanguage(result.data.uiLanguage);
      })
      .catch(() => {});
  };
  chrome.runtime.onMessage.addListener((command: PageCommand) => {
    if (
      command.type !== 'UI_LANGUAGE_CHANGED' ||
      !UI_LOCALES.some((locale) => locale === command.locale)
    )
      return;
    revision += 1;
    setUiLanguage(command.locale);
  });
  subscribeUiLanguage(refreshTranslationLabels);
  window.addEventListener('pageshow', (event) => {
    // BFCache resumes the same script instance, so reconcile against durable settings.
    if (event.persisted) refresh();
  });
  refresh();
}
