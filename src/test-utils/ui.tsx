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

export const READY_SETTINGS: TranslatorSettings = {
  ...DEFAULT_SETTINGS,
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
  const publicState = (): PublicTranslatorSettings => ({
    ...stored,
    profiles: stored.profiles.map(({ id, name, model }) => ({
      id,
      name,
      configured: Boolean(model),
    })),
    configured: Boolean(stored.profiles.find((p) => p.id === stored.activeProfileId)?.model),
  });
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
        case 'SET_ACTIVE_PROFILE':
          stored.activeProfileId = request.profileId;
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
  });
  return { send, tabSend, openOptionsPage, storageSet, storageAddListener };
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
