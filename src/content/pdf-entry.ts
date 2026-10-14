import { getUiLocale, subscribeUiLanguage, t } from '../shared/i18n';

/** Chrome shows PDFs in a plugin document whose MIME type is still the PDF's. */
export function isBrowserPdfDocument(target: Document = document): boolean {
  if (target.contentType === 'application/pdf') return true;
  const body = target.body;
  return Boolean(
    body &&
    body.children.length === 1 &&
    body.firstElementChild?.matches('embed[type="application/pdf"]'),
  );
}

const STYLE = `
:host { all: initial; }
.entry {
  position: fixed;
  inset-block-end: 24px;
  inset-inline-end: 24px;
  z-index: 2147483646;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 3px;
  border-radius: 999px;
  background: #4f46e5;
  box-shadow: 0 6px 18px rgb(0 0 0 / 24%);
  font: 500 13px/1.2 -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
}
button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: #fff;
  font: inherit;
  cursor: pointer;
}
button:focus-visible { outline: 2px solid #fff; outline-offset: 1px; }
.translate { padding: 8px 12px; }
.translate:hover, .close:hover { background: rgb(255 255 255 / 16%); }
.close { width: 28px; height: 28px; justify-content: center; padding: 0; opacity: 0.85; }
svg { width: 16px; height: 16px; flex-shrink: 0; }
@media (prefers-color-scheme: dark) {
  .entry { background: #aaa3ff; }
  button { color: #201949; }
  button:focus-visible { outline-color: #201949; }
  .translate:hover, .close:hover { background: rgb(0 0 0 / 10%); }
}
`;

const LANGUAGE_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/></svg>';
const CLOSE_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';

/**
 * A small, dismissible entry over the browser's PDF viewer. It never opens the reader by itself;
 * the PDF is only fetched and translated after the user clicks it.
 */
export function mountPdfEntry(onTranslate: () => void, target: Document = document): () => void {
  const host = target.createElement('just-translate-pdf-entry');
  const root = host.attachShadow({ mode: 'closed' });
  const style = target.createElement('style');
  style.textContent = STYLE;
  const entry = target.createElement('div');
  entry.className = 'entry';
  const translate = target.createElement('button');
  translate.type = 'button';
  translate.className = 'translate';
  const close = target.createElement('button');
  close.type = 'button';
  close.className = 'close';
  entry.append(translate, close);
  root.append(style, entry);

  const label = () => {
    const locale = getUiLocale();
    entry.lang = locale;
    entry.dir = locale === 'ar' ? 'rtl' : 'ltr';
    translate.innerHTML = LANGUAGE_ICON;
    translate.append(t('翻译此 PDF'));
    close.innerHTML = CLOSE_ICON;
    close.setAttribute('aria-label', t('隐藏此按钮'));
    close.title = t('隐藏此按钮');
  };
  label();
  const unsubscribe = subscribeUiLanguage(label);
  const remove = () => {
    unsubscribe();
    host.remove();
  };
  translate.addEventListener('click', () => onTranslate());
  close.addEventListener('click', remove);
  (target.body ?? target.documentElement).append(host);
  return remove;
}
