// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { OptionsApp } from './options-app';
import { mount, mockExtension, input, click, READY_SETTINGS } from '../test-utils/ui';
import { setUiLanguage } from '../shared/i18n';

let view: Awaited<ReturnType<typeof mount>>;
afterEach(() => {
  view?.unmount();
  setUiLanguage('zh-CN');
  vi.unstubAllGlobals();
});

it('switches UI language after persistence without discarding an AI draft or changing its target language', async () => {
  const { send } = mockExtension({ ...READY_SETTINGS, uiLanguage: 'zh-CN' });
  view = await mount(<OptionsApp />);
  await input(view.container, '模型', 'unsaved-model');
  await input(view.container, '界面语言', 'ar');
  expect(send).toHaveBeenCalledWith({ type: 'UPDATE_UI_LANGUAGE', uiLanguage: 'ar' });
  expect(document.documentElement.dir).toBe('rtl');
  expect(document.documentElement.lang).toBe('ar');
  expect(view.container.querySelector<HTMLInputElement>('input[list]')?.value).toBe(
    'unsaved-model',
  );
  expect(view.container.textContent).toContain('Just Translate');
  expect(send).not.toHaveBeenCalledWith(
    expect.objectContaining({ type: 'UPDATE_READING_PREFERENCES' }),
  );
});

it('retains a failed language choice and switches only after a successful retry', async () => {
  const { send } = mockExtension({ ...READY_SETTINGS, uiLanguage: 'zh-CN' });
  view = await mount(<OptionsApp />);
  send.mockRejectedValueOnce(new Error('Disk full'));
  await input(view.container, '界面语言', 'fr');
  expect(document.documentElement.lang).toBe('zh-CN');
  expect(view.container.querySelector<HTMLSelectElement>('[aria-label="界面语言"]')?.value).toBe(
    'fr',
  );
  expect(view.container.textContent).toContain('Disk full');
  await click(view.container, '重试保存');
  expect(document.documentElement.lang).toBe('fr');
  expect(view.container.textContent).not.toContain('Disk full');
});

it('returns to the browser language and resolves existing validation errors in the new language', async () => {
  mockExtension({ ...READY_SETTINGS, uiLanguage: 'zh-CN' });
  vi.stubGlobal('chrome', { ...chrome, i18n: { getUILanguage: () => 'de-AT' } });
  view = await mount(<OptionsApp />);
  await input(view.container, '模型', '');
  await click(view.container, '保存配置');
  expect(view.container.textContent).toContain('请填写模型名称');
  await input(view.container, '界面语言', 'system');
  expect(document.documentElement.lang).toBe('de');
  expect(view.container.textContent).toContain('Geben Sie einen Modellnamen ein');
});
