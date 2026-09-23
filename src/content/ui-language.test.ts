// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { message, setUiLanguage, t } from '../shared/i18n';
import { SelectionTranslationView } from './selection-translation-view';
import {
  renderTranslationError,
  renderTranslationPending,
  getElementSourceText,
  renderTranslation,
} from './dom-translator';
import { refreshTranslationLabels } from './ui-language';

afterEach(() => {
  document.body.innerHTML = '';
  setUiLanguage('zh-CN');
});
it('restores automatic text direction when an Arabic UI placeholder becomes an English translation', () => {
  document.body.innerHTML = '<p>Original text</p>';
  const source = document.querySelector('p')!;
  setUiLanguage('ar');
  renderTranslationPending(source, 'one');
  const translated = renderTranslation(source, 'English translation');
  expect(translated.dir).toBe('auto');
  expect(translated.hasAttribute('lang')).toBe(false);
});
it('updates extension-owned retry labels without changing host language, direction or original text', () => {
  document.documentElement.lang = 'de';
  document.documentElement.dir = 'ltr';
  document.body.innerHTML = '<p>Original text</p><p>Another paragraph</p>';
  const original = document.querySelector('p')!;
  const error = renderTranslationError(original, 'one');
  const pending = renderTranslationPending(document.querySelectorAll('p')[1], 'two');
  setUiLanguage('ar');
  refreshTranslationLabels();
  expect(error.dir).toBe('rtl');
  expect(error.textContent).not.toContain('翻译');
  expect(pending.getAttribute('aria-label')).not.toContain('翻译');
  expect(getElementSourceText(original)).toBe('Original text');
  expect(document.documentElement.lang).toBe('de');
  expect(document.documentElement.dir).toBe('ltr');
});
it('relabels an existing selection error while retaining its original text and actions', () => {
  HTMLElement.prototype.showPopover = vi.fn();
  HTMLElement.prototype.hidePopover = vi.fn();
  const close = vi.fn();
  const retry = vi.fn();
  const view = new SelectionTranslationView({ close, retry });
  view.show('Original text', { getRect: () => ({ left: 20, right: 40, top: 20, bottom: 40 }) });
  view.error(message('请填写模型名称'));
  setUiLanguage('fr');
  const shadow = document.querySelector('[data-justranslate-selection]')!.shadowRoot!;
  expect(shadow.querySelector('.status')?.textContent).toBe('Saisissez un nom de modèle');
  expect(shadow.querySelector('.source')?.textContent).toBe('Original text');
  expect(shadow.querySelector('[data-action="retry"]')?.textContent).toBe('Réessayer');
  expect(close).not.toHaveBeenCalled();
  expect(retry).not.toHaveBeenCalled();
  view.destroy();
});

it('localizes a preset selection target after success and every later locale change', () => {
  HTMLElement.prototype.showPopover = vi.fn();
  HTMLElement.prototype.hidePopover = vi.fn();
  const view = new SelectionTranslationView({ close: vi.fn(), retry: vi.fn() });
  view.show('Original text', {
    getRect: () => ({ left: 20, right: 40, top: 20, bottom: 40 }),
  });
  setUiLanguage('fr');
  view.success({
    text: '译文',
    targetLanguage: 'Simplified Chinese',
    translatorName: 'Google',
  });
  const shadow = document.querySelector('[data-justranslate-selection]')!.shadowRoot!;
  expect(shadow.querySelector('.language')?.textContent).toBe(`Google · ${t('简体中文')}`);
  setUiLanguage('ar');
  expect(shadow.querySelector('.language')?.textContent).toBe(`Google · ${t('简体中文')}`);
  expect(shadow.querySelector('.result')?.textContent).toBe('译文');

  view.success({ text: '译文', targetLanguage: 'Klingon', translatorName: 'Google' });
  setUiLanguage('de');
  expect(shadow.querySelector('.language')?.textContent).toBe('Google · Klingon');
  view.destroy();
});

it('owns one listener and reconciles persisted BFCache pages without accepting stale reads', async () => {
  const { initializeContentLanguage } = await import('./ui-language');
  let receive!: (command: unknown) => void;
  const resolves: Array<(value: unknown) => void> = [];
  const addListener = vi.fn((listener: typeof receive) => {
    receive = listener;
  });
  const sendMessage = vi.fn(
    () =>
      new Promise((done) => {
        resolves.push(done);
      }),
  );
  vi.stubGlobal('chrome', {
    runtime: {
      onMessage: { addListener },
      sendMessage,
    },
  });
  initializeContentLanguage();
  initializeContentLanguage();
  expect(addListener).toHaveBeenCalledOnce();
  expect(sendMessage).toHaveBeenCalledOnce();

  receive({ type: 'UI_LANGUAGE_CHANGED', locale: 'ar' });
  resolves[0]({ ok: true, data: { uiLanguage: 'fr' } });
  await Promise.resolve();
  await Promise.resolve();
  const { getUiLocale } = await import('../shared/i18n');
  expect(getUiLocale()).toBe('ar');

  const restored = new Event('pageshow');
  Object.defineProperty(restored, 'persisted', { value: true });
  window.dispatchEvent(restored);
  expect(sendMessage).toHaveBeenCalledTimes(2);
  resolves[1]({ ok: true, data: { uiLanguage: 'fr' } });
  await Promise.resolve();
  await Promise.resolve();
  expect(getUiLocale()).toBe('fr');

  window.dispatchEvent(restored);
  receive({ type: 'UI_LANGUAGE_CHANGED', locale: 'de' });
  resolves[2]({ ok: true, data: { uiLanguage: 'ar' } });
  await Promise.resolve();
  await Promise.resolve();
  expect(getUiLocale()).toBe('de');

  window.dispatchEvent(new Event('pageshow'));
  expect(sendMessage).toHaveBeenCalledTimes(3);
  vi.unstubAllGlobals();
});
