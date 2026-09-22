import { afterEach, expect, it, vi } from 'vitest';
import { synchronizeInterfaceLanguage } from './ui-language';
import {
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
  type TranslatorSettings,
} from '../shared/settings';
import { updateUiLanguage } from './configuration-service';

afterEach(() => vi.unstubAllGlobals());
it('changes only the UI preference and rejects invalid writes', async () => {
  let settings = { ...DEFAULT_SETTINGS, targetLanguage: 'German' };
  const set = vi.fn((value: Record<string, TranslatorSettings>) => {
    settings = value[SETTINGS_STORAGE_KEY];
    return Promise.resolve();
  });
  vi.stubGlobal('chrome', {
    storage: { local: { get: () => Promise.resolve({ [SETTINGS_STORAGE_KEY]: settings }), set } },
  });
  const result = await updateUiLanguage('ar');
  expect(result.uiLanguage).toBe('ar');
  expect(settings).toEqual({ ...DEFAULT_SETTINGS, targetLanguage: 'German', uiLanguage: 'ar' });
  // @ts-expect-error validate untrusted runtime payloads
  await expect(updateUiLanguage('xx')).rejects.toThrow();
  expect(set).toHaveBeenCalledTimes(1);
});
it('updates titles without creating or removing retry menus and broadcasts no private settings', async () => {
  const update = vi.fn(async () => {});
  const send = vi.fn(async () => {});
  const setTitle = vi.fn(async () => {});
  vi.stubGlobal('chrome', {
    contextMenus: { update },
    action: { setTitle },
    tabs: { query: () => Promise.resolve([{ id: 7 }, { id: 8 }]), sendMessage: send },
  });
  await synchronizeInterfaceLanguage('fr');
  expect(update).toHaveBeenCalledWith('just-translate-page', { title: 'Traduire maintenant' });
  expect(update).toHaveBeenCalledWith(
    'just-translate-retry-failed',
    expect.objectContaining({ title: 'Réessayer tous les paragraphes en échec' }),
  );
  expect(send.mock.calls).toEqual([
    [7, { type: 'UI_LANGUAGE_CHANGED', locale: 'fr' }],
    [8, { type: 'UI_LANGUAGE_CHANGED', locale: 'fr' }],
  ]);
  expect(setTitle).toHaveBeenCalledWith({ title: 'Just Translate' });
});

it('restores the saved locale when a background worker starts again', async () => {
  const { initializeBackgroundLanguage } = await import('./ui-language');
  const { getUiLocale, setUiLanguage } = await import('../shared/i18n');
  const update = vi.fn(() => Promise.resolve());
  const sendMessage = vi.fn(() => Promise.resolve());
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: () =>
          Promise.resolve({ [SETTINGS_STORAGE_KEY]: { ...DEFAULT_SETTINGS, uiLanguage: 'fr' } }),
      },
      onChanged: { addListener: vi.fn() },
    },
    contextMenus: { update },
    action: { setTitle: () => Promise.resolve() },
    tabs: { query: () => Promise.resolve([{ id: 7 }]), sendMessage },
  });
  for (let startup = 0; startup < 2; startup += 1) {
    setUiLanguage('zh-CN');
    initializeBackgroundLanguage(Promise.resolve());
    await vi.waitFor(() => expect(getUiLocale()).toBe('fr'));
  }
  expect(sendMessage).toHaveBeenLastCalledWith(7, { type: 'UI_LANGUAGE_CHANGED', locale: 'fr' });
});
