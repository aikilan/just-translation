import { TEST_PROFILE } from './provider';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { vi } from 'vitest';
import {
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
  type TranslatorSettings,
} from '../shared/settings';
import type {
  PageTranslationStatus,
  PublicTranslatorSettings,
  Result,
  RuntimeRequest,
} from '../shared/messages';
import { resolveBuiltinTargetLanguage } from '../shared/translation-engines';
import { message } from '../shared/i18n';

export const READY_SETTINGS: TranslatorSettings = {
  ...DEFAULT_SETTINGS,
  activeTranslator: { kind: 'ai', profileId: TEST_PROFILE.id },
  profiles: [
    { ...TEST_PROFILE, model: 'test-model', apiKey: 'test-secret' },
    { ...TEST_PROFILE, id: 'second', name: '备用配置', model: 'second-model' },
  ],
};
export const IDLE_STATUS: PageTranslationStatus = {
  mode: 'segmented',
  phase: 'idle',
  total: 0,
  translated: 0,
  failed: 0,
  displayMode: 'bilingual',
};
export function mockExtension(
  settings = READY_SETTINGS,
  status = IDLE_STATUS,
  url = 'https://news.example.com/article',
) {
  let stored = structuredClone(settings);
  const publicState = (): PublicTranslatorSettings => {
    const translator = stored.activeTranslator;
    const ready =
      translator.kind === 'builtin'
        ? Boolean(resolveBuiltinTargetLanguage(translator.engine, stored.targetLanguage))
        : Boolean(stored.profiles.find((p) => p.id === translator.profileId)?.model);
    return {
      ...stored,
      profiles: stored.profiles.map(({ id, name, model }) => ({
        id,
        name,
        configured: Boolean(model),
      })),
      ready,
      supportsFullDocument: translator.kind === 'ai' && ready,
      configurationError: ready
        ? undefined
        : translator.kind === 'builtin'
          ? message('免费翻译通道不支持当前目标语言')
          : message('当前翻译配置不存在'),
    };
  };
  const send = vi.fn<(request: RuntimeRequest) => Promise<Result<PublicTranslatorSettings>>>(
    async (request) => {
      await Promise.resolve();
      switch (request.type) {
        case 'SAVE_TRANSLATION_PROFILE':
          stored.profiles = stored.profiles.some((p) => p.id === request.profile.id)
            ? stored.profiles.map((p) => (p.id === request.profile.id ? request.profile : p))
            : [...stored.profiles, request.profile];
          break;
        case 'DELETE_TRANSLATION_PROFILE':
          stored.profiles = stored.profiles.filter((p) => p.id !== request.profileId);
          break;
        case 'SET_ACTIVE_TRANSLATOR':
          stored.activeTranslator = request.translator;
          break;
        case 'UPDATE_UI_LANGUAGE':
          stored = { ...stored, uiLanguage: request.uiLanguage };
          break;
        case 'UPDATE_READING_PREFERENCES':
          stored = { ...stored, ...request.patch };
          break;
        case 'SET_SITE_AUTO_TRANSLATE':
          stored.autoTranslateSites = request.enabled
            ? [...stored.autoTranslateSites, request.hostname]
            : stored.autoTranslateSites.filter((h) => h !== request.hostname);
          break;
        case 'UPDATE_SITE_RULE':
          stored[request.rule.list] = request.rule.enabled
            ? [...stored[request.rule.list], request.rule.hostname]
            : stored[request.rule.list].filter((h) => h !== request.rule.hostname);
          break;
      }
      return { ok: true as const, data: publicState() };
    },
  );
  const tabSend = vi
    .fn<
      (
        tabId: number,
        command: unknown,
        options?: chrome.tabs.MessageSendOptions,
      ) => Promise<unknown>
    >()
    .mockResolvedValue(status);
  const openOptionsPage = vi.fn(async () => {});
  const storageSet = vi.fn(async () => {});
  const executeScript = vi
    .fn<
      (
        injection: chrome.scripting.ScriptInjection<[string], unknown>,
      ) => Promise<chrome.scripting.InjectionResult<unknown>[]>
    >()
    .mockResolvedValue([{ frameId: 0, documentId: 'page', result: { ok: true } }]);
  type StorageChangedListener = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ) => void;
  const storageAddListener = vi.fn<(listener: StorageChangedListener) => void>();
  const storageRemoveListener = vi.fn<(listener: StorageChangedListener) => void>();
  vi.stubGlobal('chrome', {
    i18n: { getUILanguage: () => 'zh-CN' },
    runtime: {
      sendMessage: send,
      openOptionsPage,
      getURL: (p: string) => `chrome-extension://test/${p}`,
    },
    storage: {
      local: {
        get: vi.fn(() => Promise.resolve({ [SETTINGS_STORAGE_KEY]: structuredClone(stored) })),
        set: storageSet,
      },
      onChanged: { addListener: storageAddListener, removeListener: storageRemoveListener },
    },
    tabs: {
      query: vi.fn(() => Promise.resolve([{ id: 7, url }])),
      sendMessage: tabSend,
      create: vi.fn(async () => {}),
    },
    scripting: { executeScript },
  });
  return { send, tabSend, openOptionsPage, storageSet, storageAddListener, executeScript };
}
export async function mount(node: ReactNode) {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    await Promise.resolve();
    root.render(node);
  });
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}
export function button(container: HTMLElement, name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(
    (b) => b.getAttribute('aria-label') === name || b.textContent?.trim() === name,
  );
  if (!found) throw new Error(`Missing button: ${name}`);
  return found;
}
export async function click(container: HTMLElement, name: string) {
  await act(async () => {
    await Promise.resolve();
    button(container, name).click();
  });
}
export async function input(container: HTMLElement, label: string, value: string) {
  await act(async () => {
    await Promise.resolve();
    const el = container.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
      `[aria-label="${label}"]`,
    );
    if (!el) throw new Error(`Missing input: ${label}`);
    const prototype =
      el instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(
      new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }),
    );
  });
}
