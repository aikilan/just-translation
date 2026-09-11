// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_SETTINGS,
  DEFAULT_TRANSLATION_PROMPT,
  SETTINGS_STORAGE_KEY,
  type TranslatorSettings,
} from '../shared/settings';
import type { PublicTranslatorSettings, Result, RuntimeRequest } from '../shared/messages';
import { OptionsApp } from './options-app';
import { completionResponse } from '../test-utils/sse';

const PUBLIC_SETTINGS: PublicTranslatorSettings = {
  configured: true,
  activeProfileId: DEFAULT_SETTINGS.activeProfileId,
  profiles: DEFAULT_SETTINGS.profiles.map((profile) => ({
    id: profile.id,
    name: profile.name,
    configured: true,
  })),
  targetLanguage: DEFAULT_SETTINGS.targetLanguage,
  displayMode: DEFAULT_SETTINGS.displayMode,
  translateDynamicContent: DEFAULT_SETTINGS.translateDynamicContent,
  excludedSites: DEFAULT_SETTINGS.excludedSites,
  autoTranslateSites: DEFAULT_SETTINGS.autoTranslateSites,
};

describe('OptionsApp', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('opens the AI panel by default and preserves unsaved drafts while switching panels', async () => {
    stubChrome(vi.fn().mockResolvedValue({ ok: true, data: undefined }));

    await act(async () => {
      root.render(<OptionsApp />);
      await Promise.resolve();
    });

    const apiTab = getTab(container, 'AI 接口');
    const readingTab = getTab(container, '阅读体验');
    const sitesTab = getTab(container, '站点排除');

    expect(apiTab.getAttribute('aria-selected')).toBe('true');
    expect(container.querySelector('[role="tabpanel"]')?.textContent).toContain('当前配置');
    expect(container.querySelector('[role="tabpanel"]')?.textContent).not.toContain('动态内容翻译');

    await act(async () => {
      setInputValue(
        container.querySelector<HTMLInputElement>('[aria-label="配置名称"]')!,
        '尚未保存的草稿',
      );
      readingTab.click();
      await Promise.resolve();
    });
    expect(readingTab.getAttribute('aria-selected')).toBe('true');
    expect(container.querySelector('[role="tabpanel"]')?.textContent).toContain('动态内容翻译');
    expect(container.querySelector('[role="tabpanel"]')?.textContent).not.toContain('当前配置');

    await act(async () => {
      sitesTab.click();
      await Promise.resolve();
    });
    expect(container.querySelector('[role="tabpanel"]')?.textContent).toContain('排除站点');

    await act(async () => {
      apiTab.click();
      await Promise.resolve();
    });
    expect(container.querySelector<HTMLInputElement>('[aria-label="配置名称"]')?.value).toBe(
      '尚未保存的草稿',
    );
  });

  it('shows saved, testing, connected latency states and clears the result after editing', async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          }),
      ),
    );
    stubChrome(vi.fn().mockResolvedValue({ ok: true, data: undefined }));

    await act(async () => {
      root.render(<OptionsApp />);
      await Promise.resolve();
    });

    const status = container.querySelector<HTMLElement>('.connection-status');
    expect(status?.dataset.state).toBe('saved');
    expect(status?.textContent).toContain('已配置');

    vi.spyOn(performance, 'now').mockReturnValueOnce(100).mockReturnValue(520);
    const testButton = getButton(container, '测试连接');
    await act(async () => {
      testButton.click();
      await Promise.resolve();
    });
    expect(status?.dataset.state).toBe('testing');
    expect(status?.textContent).toContain('连接中');

    await act(async () => {
      resolveFetch!(createTranslationResponse('早上好。'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(status?.dataset.state).toBe('connected');
    expect(status?.textContent).toContain('已连接');
    expect(container.querySelector('.connection-feedback')?.textContent).toContain(
      '接口正常，响应格式有效，响应时间：420ms',
    );
    expect(container.querySelector('.connection-feedback')?.textContent).toContain(
      '测试译文：早上好。',
    );

    await act(async () => {
      setInputValue(container.querySelector<HTMLInputElement>('[aria-label="模型"]')!, 'new-model');
      await Promise.resolve();
    });
    expect(status?.dataset.state).toBe('saved');
    expect(status?.textContent).toContain('已配置');
    expect(container.querySelector('.connection-feedback')?.textContent).not.toContain('420ms');
  });

  it('prevents duplicate connection tests while one API request is pending', async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    const fetcher = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetcher);
    const sendMessage = vi.fn().mockResolvedValue({ ok: true, data: undefined });
    stubChrome(sendMessage);

    await act(async () => {
      root.render(<OptionsApp />);
      await Promise.resolve();
    });
    const testButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === '测试连接',
    );
    expect(testButton).toBeDefined();

    await act(async () => {
      testButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(testButton!.disabled).toBe(true);
    testButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(fetcher).toHaveBeenCalledOnce();
    expect(sendMessage).not.toHaveBeenCalled();

    await act(async () => {
      resolveFetch!(createTranslationResponse('早上好。'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(testButton!.disabled).toBe(false);
    expect(testButton!.closest('[role="tabpanel"]')?.textContent).toContain('接口正常');
  });

  it('tests the active profile even when another unsaved profile is incomplete', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(createTranslationResponse('早上好。'));
    vi.stubGlobal('fetch', fetcher);
    const storedSettings: TranslatorSettings = {
      ...DEFAULT_SETTINGS,
      profiles: [
        { ...DEFAULT_SETTINGS.profiles[0], model: 'active-model' },
        {
          ...DEFAULT_SETTINGS.profiles[0],
          id: 'incomplete-profile',
          name: '未完成配置',
          model: '',
        },
      ],
    };
    stubChrome(
      vi.fn().mockResolvedValue({ ok: true, data: undefined }),
      vi.fn().mockResolvedValue(undefined),
      storedSettings,
    );

    await act(async () => {
      root.render(<OptionsApp />);
      await Promise.resolve();
    });
    await act(async () => {
      getButton(container, '测试连接').click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetcher).toHaveBeenCalledOnce();
    expect(container.querySelector('.connection-feedback')?.textContent).toContain(
      '测试译文：早上好。',
    );
  });

  it('saves through the background and only reports success after it confirms configured state', async () => {
    const storageSet = vi.fn().mockResolvedValue(undefined);
    const sendMessage = vi.fn((request: RuntimeRequest): Promise<Result<unknown>> => {
      if (request.type === 'SAVE_SETTINGS') {
        return Promise.resolve({ ok: true, data: PUBLIC_SETTINGS });
      }
      return Promise.resolve({ ok: true, data: undefined });
    });
    stubChrome(sendMessage, storageSet);

    await act(async () => {
      root.render(<OptionsApp />);
      await Promise.resolve();
    });
    const saveButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === '保存并启用',
    );
    expect(saveButton).toBeDefined();
    expect(container.querySelector('.workspace-header')?.textContent).toContain('AI 接口');

    await act(async () => {
      saveButton!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'SAVE_SETTINGS' }));
    expect(storageSet).not.toHaveBeenCalled();
    expect(container.textContent).toContain('已保存，弹窗已可使用该 AI 配置。');
  });

  it('fills missing prompts in inactive stored profiles before saving the complete settings', async () => {
    let savedSettings: TranslatorSettings | undefined;
    const storedSettings = {
      ...DEFAULT_SETTINGS,
      profiles: [
        {
          ...DEFAULT_SETTINGS.profiles[0],
          id: 'deepseek',
          name: 'DeepSeek',
          model: 'deepseek-v4-flash',
        },
        {
          id: 'legacy-profile',
          name: '历史配置',
          apiUrl: 'https://legacy.example.com/v1',
          apiKey: '',
          model: 'legacy-model',
        },
      ],
      activeProfileId: 'deepseek',
    };
    const sendMessage = vi.fn((request: RuntimeRequest): Promise<Result<unknown>> => {
      if (request.type === 'SAVE_SETTINGS') {
        savedSettings = request.settings;
        return Promise.resolve({ ok: true, data: PUBLIC_SETTINGS });
      }
      return Promise.resolve({ ok: true, data: undefined });
    });
    stubChrome(sendMessage, vi.fn().mockResolvedValue(undefined), storedSettings);

    await act(async () => {
      root.render(<OptionsApp />);
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      getButton(container, '保存并启用').click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(savedSettings?.profiles).toHaveLength(2);
    expect(savedSettings?.profiles[1]?.translationPrompt).toBe(DEFAULT_TRANSLATION_PROMPT);
    expect(container.textContent).toContain('已保存，弹窗已可使用该 AI 配置。');
    expect(container.textContent).not.toContain('请填写翻译 Prompt');
  });

  it('toggles API key visibility without changing the configured value', async () => {
    stubChrome(vi.fn().mockResolvedValue({ ok: true, data: undefined }));

    await act(async () => {
      root.render(<OptionsApp />);
      await Promise.resolve();
    });

    const apiKey = container.querySelector<HTMLInputElement>('[aria-label="API Key"]')!;
    expect(apiKey.type).toBe('password');
    const originalValue = apiKey.value;

    await act(async () => {
      getButton(container, '显示').click();
      await Promise.resolve();
    });
    expect(apiKey.type).toBe('text');
    expect(apiKey.value).toBe(originalValue);
  });

  it('edits and restores a custom translation prompt for the active AI profile', async () => {
    let savedSettings: TranslatorSettings | undefined;
    const sendMessage = vi.fn((request: RuntimeRequest): Promise<Result<unknown>> => {
      if (request.type === 'SAVE_SETTINGS') {
        savedSettings = request.settings;
        return Promise.resolve({ ok: true, data: PUBLIC_SETTINGS });
      }
      return Promise.resolve({ ok: true, data: undefined });
    });
    stubChrome(sendMessage);

    await act(async () => {
      root.render(<OptionsApp />);
      await Promise.resolve();
    });

    const prompt = container.querySelector<HTMLTextAreaElement>('[aria-label="自定义翻译 Prompt"]');
    expect(prompt?.value).toBe(DEFAULT_TRANSLATION_PROMPT);
    expect(prompt?.closest('label')).toBeNull();
    expect(getButton(container, '恢复默认 Prompt').closest('label')).toBeNull();
    expect(container.textContent).toContain('{{targetLanguage}}');
    expect(container.textContent).toContain('固定追加');
    expect(prompt?.maxLength).toBeGreaterThan(0);
    expect(container.querySelector('.prompt-length')?.textContent).toContain(
      `${DEFAULT_TRANSLATION_PROMPT.length} /`,
    );

    await act(async () => {
      setTextareaValue(
        prompt!,
        'Translate into {{targetLanguage}} and keep product terms concise.',
      );
      await Promise.resolve();
    });
    expect(container.querySelector<HTMLElement>('.connection-status')?.dataset.state).toBe('saved');

    await act(async () => {
      getButton(container, '保存并启用').click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(savedSettings?.profiles[0]?.translationPrompt).toBe(
      'Translate into {{targetLanguage}} and keep product terms concise.',
    );

    await act(async () => {
      getButton(container, '恢复默认 Prompt').click();
      await Promise.resolve();
    });
    expect(prompt?.value).toBe(DEFAULT_TRANSLATION_PROMPT);
  });

  it('shows the real provider error returned by a direct connection test', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() =>
        Promise.resolve(
          new Response('{"error":{"message":"Invalid API key"}}', {
            status: 401,
            statusText: 'Unauthorized',
          }),
        ),
      ),
    );
    const sendMessage = vi.fn().mockResolvedValue({ ok: true, data: undefined });
    stubChrome(sendMessage);

    await act(async () => {
      root.render(<OptionsApp />);
      await Promise.resolve();
    });
    const testButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === '测试连接',
    )!;

    await act(async () => {
      testButton.click();
      // The connection UI stays in testing state until its one automatic retry finishes.
      await new Promise((resolve) => setTimeout(resolve, 500));
    });

    const connectionStatus = container.querySelector<HTMLElement>('.connection-feedback');
    expect(connectionStatus?.dataset.state).toBe('error');
    expect(connectionStatus?.textContent).toMatch(/401 Unauthorized.*Invalid API key/u);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('does not expose internal adaptive batching controls', async () => {
    let savedSettings: unknown;
    const sendMessage = vi.fn((request: RuntimeRequest): Promise<Result<unknown>> => {
      if (request.type === 'SAVE_SETTINGS') {
        savedSettings = request.settings;
        return Promise.resolve({ ok: true, data: PUBLIC_SETTINGS });
      }
      return Promise.resolve({ ok: true, data: undefined });
    });
    stubChrome(sendMessage);

    await act(async () => {
      root.render(<OptionsApp />);
      await Promise.resolve();
    });

    expect(container.textContent).not.toContain('高级请求设置');
    expect(container.textContent).not.toContain('单批最大字符数');
    expect(container.textContent).not.toContain('单批最大段落数');
    expect(container.textContent).not.toContain('并发批次数');

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(savedSettings).not.toHaveProperty('batchMaxCharacters');
    expect(savedSettings).not.toHaveProperty('batchMaxItems');
    expect(savedSettings).not.toHaveProperty('batchConcurrency');
  });

  it('saves complete settings from the reading and site panels with local feedback', async () => {
    const savedRequests: TranslatorSettings[] = [];
    const sendMessage = vi.fn((request: RuntimeRequest): Promise<Result<unknown>> => {
      if (request.type === 'SAVE_SETTINGS') {
        savedRequests.push(request.settings);
        return Promise.resolve({ ok: true, data: PUBLIC_SETTINGS });
      }
      return Promise.resolve({ ok: true, data: undefined });
    });
    stubChrome(sendMessage);

    await act(async () => {
      root.render(<OptionsApp />);
      await Promise.resolve();
    });
    await act(async () => {
      getTab(container, '阅读体验').click();
      await Promise.resolve();
    });

    await act(async () => {
      setInputValue(
        container.querySelector<HTMLInputElement>('[aria-label="目标语言"]')!,
        'Japanese',
      );
      setSelectValue(
        container.querySelector<HTMLSelectElement>('[aria-label="默认展示"]')!,
        'translation',
      );
      container.querySelector<HTMLInputElement>('[type="checkbox"]')!.click();
      getButton(container, '保存设置').click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(savedRequests[0]).toMatchObject({
      targetLanguage: 'Japanese',
      displayMode: 'translation',
      translateDynamicContent: false,
      profiles: [expect.objectContaining({ model: 'test-model' })],
    });
    expect(container.querySelector('[role="tabpanel"]')?.textContent).toContain('设置已保存');

    await act(async () => {
      getTab(container, '站点排除').click();
      await Promise.resolve();
      setTextareaValue(
        container.querySelector<HTMLTextAreaElement>('[aria-label="排除站点"]')!,
        'example.com\n*.internal.example.com',
      );
      getButton(container, '保存设置').click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(savedRequests[1]).toMatchObject({
      excludedSites: ['example.com', '*.internal.example.com'],
      targetLanguage: 'Japanese',
      profiles: [expect.objectContaining({ model: 'test-model' })],
    });
    expect(container.querySelector('[role="tabpanel"]')?.textContent).toContain('设置已保存');
  });

  it('adds a second named AI profile and saves it as the active profile', async () => {
    let savedSettings: unknown;
    const sendMessage = vi.fn((request: RuntimeRequest): Promise<Result<unknown>> => {
      if (request.type === 'SAVE_SETTINGS') {
        savedSettings = request.settings;
        return Promise.resolve({
          ok: true,
          data: {
            ...PUBLIC_SETTINGS,
            activeProfileId: request.settings.activeProfileId,
            profiles: request.settings.profiles.map((profile) => ({
              id: profile.id,
              name: profile.name,
              configured: true,
            })),
          },
        });
      }
      return Promise.resolve({ ok: true, data: undefined });
    });
    stubChrome(sendMessage);

    await act(async () => {
      root.render(<OptionsApp />);
      await Promise.resolve();
    });

    await act(async () => {
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === '新增配置')!
        .click();
      await Promise.resolve();
    });

    const profileSelect =
      container.querySelector<HTMLSelectElement>('[aria-label="当前 AI 配置"]')!;
    expect(profileSelect.options).toHaveLength(2);
    expect(profileSelect.value).not.toBe(DEFAULT_SETTINGS.activeProfileId);

    await act(async () => {
      const nameInput = container.querySelector<HTMLInputElement>('[aria-label="配置名称"]')!;
      setInputValue(nameInput, '本地 Qwen');
      const modelInput = container.querySelector<HTMLInputElement>('[aria-label="模型"]')!;
      setInputValue(modelInput, 'qwen3');
      await Promise.resolve();
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(savedSettings).toMatchObject({
      activeProfileId: profileSelect.value,
      profiles: [
        expect.objectContaining({ name: '默认配置' }),
        expect.objectContaining({ name: '本地 Qwen', model: 'qwen3' }),
      ],
    });
  });

  it('switches profiles and deletes only the selected non-final profile', async () => {
    stubChrome(vi.fn().mockResolvedValue({ ok: true, data: undefined }));

    await act(async () => {
      root.render(<OptionsApp />);
      await Promise.resolve();
    });
    await act(async () => {
      getButton(container, '新增配置').click();
      await Promise.resolve();
    });

    const profileSelect =
      container.querySelector<HTMLSelectElement>('[aria-label="当前 AI 配置"]')!;
    const addedProfileId = profileSelect.value;
    expect(addedProfileId).not.toBe(DEFAULT_SETTINGS.activeProfileId);

    await act(async () => {
      setSelectValue(profileSelect, DEFAULT_SETTINGS.activeProfileId);
      await Promise.resolve();
    });
    expect(container.querySelector<HTMLInputElement>('[aria-label="配置名称"]')?.value).toBe(
      '默认配置',
    );

    await act(async () => {
      setSelectValue(profileSelect, addedProfileId);
      await Promise.resolve();
    });
    await act(async () => {
      getButton(container, '删除配置').click();
      await Promise.resolve();
    });
    expect(profileSelect.options).toHaveLength(1);
    expect(profileSelect.value).toBe(DEFAULT_SETTINGS.activeProfileId);
    expect(getButton(container, '删除配置').disabled).toBe(true);
  });
});

function stubChrome(
  sendMessage: (request: RuntimeRequest) => Promise<Result<unknown>>,
  storageSet = vi.fn().mockResolvedValue(undefined),
  storedSettings: unknown = {
    ...DEFAULT_SETTINGS,
    profiles: DEFAULT_SETTINGS.profiles.map((profile) => ({
      ...profile,
      model: 'test-model',
    })),
  },
): void {
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn().mockResolvedValue({
          [SETTINGS_STORAGE_KEY]: storedSettings,
        }),
        set: storageSet,
      },
    },
    runtime: { sendMessage },
  });
}

function createTranslationResponse(translatedText: string): Response {
  return completionResponse([{ id: 'connection:0', text: translatedText }]);
}

function setInputValue(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
    textarea,
    value,
  );
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

function setSelectValue(select: HTMLSelectElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, value);
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

function getTab(container: HTMLElement, name: string): HTMLButtonElement {
  const tab = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(
    (button) => button.textContent?.includes(name),
  );
  if (!tab) throw new Error(`找不到设置导航：${name}`);
  return tab;
}

function getButton(container: HTMLElement, name: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
    (candidate) => candidate.textContent?.includes(name),
  );
  if (!button) throw new Error(`找不到按钮：${name}`);
  return button;
}
