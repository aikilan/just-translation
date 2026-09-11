// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PageTranslationStatus, PublicTranslatorSettings } from '../shared/messages';
import { PopupApp } from './popup-app';

const PUBLIC_SETTINGS: PublicTranslatorSettings = {
  configured: true,
  activeProfileId: 'profile-one',
  profiles: [
    { id: 'profile-one', name: '配置一', configured: true },
    { id: 'profile-two', name: '配置二', configured: true },
  ],
  targetLanguage: 'Simplified Chinese',
  displayMode: 'bilingual',
  translateDynamicContent: true,
  excludedSites: [],
  autoTranslateSites: [],
};

const IDLE_STATUS: PageTranslationStatus = {
  phase: 'idle',
  translated: 0,
  failed: 0,
  total: 0,
  displayMode: 'bilingual',
};

describe('PopupApp', () => {
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

  it('renders the real brand, working header actions, and expanded settings by default', async () => {
    const { openOptionsPage } = stubChrome({ status: IDLE_STATUS });
    const closeWindow = vi.spyOn(window, 'close').mockImplementation(() => undefined);

    await renderPopup(root);

    expect(container.querySelector<HTMLImageElement>('.popup-logo')?.getAttribute('src')).toBe(
      '/icons/icon.svg',
    );
    expect(container.textContent).toContain('BYO AI · 不经过中转服务');
    expect(container.textContent).not.toContain('需要帮助');

    const moreSettings = getButton(container, '更多设置');
    expect(moreSettings.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.popup-advanced-content')).not.toBeNull();

    await act(async () => {
      moreSettings.click();
      await Promise.resolve();
    });
    expect(moreSettings.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('.popup-advanced-content')).toBeNull();

    await act(async () => {
      getButton(container, '打开设置').click();
      await Promise.resolve();
      getButton(container, '关闭弹窗').click();
    });
    expect(openOptionsPage).toHaveBeenCalledOnce();
    expect(closeWindow).toHaveBeenCalledOnce();
  });

  it('shows only configuration names and preserves profile and site-auto commands', async () => {
    const { runtimeSend, tabSend } = stubChrome({ status: IDLE_STATUS });

    await renderPopup(root);

    const profileSelect = container.querySelector<HTMLSelectElement>('[aria-label="翻译模型"]')!;
    expect(Array.from(profileSelect.options).map((option) => option.textContent)).toEqual([
      '配置一',
      '配置二',
    ]);

    await act(async () => {
      setSelectValue(profileSelect, 'profile-two');
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(runtimeSend).toHaveBeenCalledWith({
      type: 'SET_ACTIVE_PROFILE',
      profileId: 'profile-two',
    });

    const autoToggle = container.querySelector<HTMLInputElement>('[aria-label="此站自动翻译"]')!;
    await act(async () => {
      autoToggle.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(runtimeSend).toHaveBeenCalledWith({
      type: 'SET_SITE_AUTO_TRANSLATE',
      hostname: 'news.ycombinator.com',
      enabled: true,
    });
    expect(tabSend).toHaveBeenCalledWith(7, { type: 'START_TRANSLATION' });
  });

  it.each([
    {
      phase: 'idle' as const,
      status: IDLE_STATUS,
      title: '准备翻译',
      action: '翻译此网页',
      command: 'START_TRANSLATION',
    },
    {
      phase: 'translating' as const,
      status: { ...IDLE_STATUS, phase: 'translating' as const, total: 8, translated: 3 },
      title: '正在翻译',
      action: '停止翻译',
      command: 'STOP_TRANSLATION',
    },
    {
      phase: 'complete' as const,
      status: { ...IDLE_STATUS, phase: 'complete' as const, total: 8, translated: 8 },
      title: '翻译完成',
      action: '翻译新内容',
      command: 'START_TRANSLATION',
    },
    {
      phase: 'stopped' as const,
      status: { ...IDLE_STATUS, phase: 'stopped' as const, total: 8, translated: 3 },
      title: '已停止',
      action: '继续翻译',
      command: 'START_TRANSLATION',
    },
  ])('maps $phase to its real status action', async ({ status, title, action, command }) => {
    const { tabSend } = stubChrome({ status });

    await renderPopup(root);

    expect(container.querySelector('.translation-status-card')?.textContent).toContain(title);
    await act(async () => {
      getButton(container, action).click();
      await Promise.resolve();
    });
    expect(tabSend).toHaveBeenCalledWith(7, { type: command });
  });

  it('guides node-only retry, exposes the provider error, and returns to the page for details', async () => {
    const closeWindow = vi.spyOn(window, 'close').mockImplementation(() => undefined);
    const status: PageTranslationStatus = {
      phase: 'error',
      translated: 2,
      failed: 1,
      total: 3,
      error: 'API 返回中缺少 choices',
      displayMode: 'bilingual',
    };
    const { openOptionsPage } = stubChrome({ status });

    await renderPopup(root);

    expect(container.textContent).toContain('翻译中断');
    expect(container.textContent).toContain('1 个段落翻译失败');
    expect(container.textContent).toContain('API 返回中缺少 choices');
    expect(container.textContent).not.toContain('全局重试');
    expect(
      Array.from(container.querySelectorAll('button')).map((button) => button.textContent),
    ).not.toContain('重试');

    await act(async () => {
      getButton(container, '查看详情').click();
      getButton(container, '检查 API 配置').click();
      await Promise.resolve();
    });
    expect(closeWindow).toHaveBeenCalledOnce();
    expect(openOptionsPage).toHaveBeenCalledOnce();
  });

  it('changes display mode and restores the page from the fixed footer', async () => {
    const status: PageTranslationStatus = {
      phase: 'complete',
      translated: 2,
      failed: 0,
      total: 2,
      displayMode: 'bilingual',
    };
    const { tabSend } = stubChrome({ status });

    await renderPopup(root);

    const displayMode = container.querySelector<HTMLSelectElement>('[aria-label="显示设置"]')!;
    await act(async () => {
      setSelectValue(displayMode, 'translation');
      await Promise.resolve();
      getButton(container, '恢复原始网页').click();
      await Promise.resolve();
    });
    expect(tabSend).toHaveBeenCalledWith(7, {
      type: 'SET_DISPLAY_MODE',
      displayMode: 'translation',
    });
    expect(tabSend).toHaveBeenCalledWith(7, { type: 'RESTORE_PAGE' });
  });

  it('keeps the restore footer visible but disabled before translation starts', async () => {
    stubChrome({ status: IDLE_STATUS });

    await renderPopup(root);

    expect(getButton(container, '恢复原始网页').disabled).toBe(true);
    expect(container.textContent).toContain('Alt + T 快速切换');
    expect(container.textContent).toContain('v0.3.27');
  });

  it('shows load, setup, and unavailable states inside the redesigned shell', async () => {
    const openOptionsPage = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: vi.fn().mockRejectedValue(new Error('service worker unavailable')),
        openOptionsPage,
      },
      tabs: { query: vi.fn().mockResolvedValue([{ id: 1 }]), sendMessage: vi.fn() },
    });

    await renderPopup(root);
    expect(container.querySelector('.popup-header')).not.toBeNull();
    expect(container.textContent).toContain('无法读取插件状态');
    expect(container.textContent).toContain('service worker unavailable');

    act(() => root.unmount());
    root = createRoot(container);
    stubChrome({
      settings: {
        ...PUBLIC_SETTINGS,
        configured: false,
        configurationError: '请填写模型名称',
      },
      status: null,
      tab: undefined,
    });
    await renderPopup(root);
    expect(container.textContent).toContain('先连接你的 AI');
    expect(container.textContent).toContain('配置未生效：请填写模型名称');

    act(() => root.unmount());
    root = createRoot(container);
    stubChrome({ status: null, tab: undefined });
    await renderPopup(root);
    expect(container.textContent).toContain('这个页面无法翻译');
    expect(container.querySelector('.popup-footer')).not.toBeNull();
  });
});

interface ChromeStubOptions {
  settings?: PublicTranslatorSettings;
  status: PageTranslationStatus | null;
  tab?: { id: number; url: string };
}

function stubChrome({
  settings = PUBLIC_SETTINGS,
  status,
  tab = { id: 7, url: 'https://news.ycombinator.com/news?p=2' },
}: ChromeStubOptions) {
  const openOptionsPage = vi.fn().mockResolvedValue(undefined);
  const runtimeSend = vi.fn(
    (request: { type: string; profileId?: string; hostname?: string; enabled?: boolean }) => {
      if (request.type === 'SET_ACTIVE_PROFILE') {
        return Promise.resolve({
          ok: true,
          data: { ...settings, activeProfileId: request.profileId },
        });
      }
      if (request.type === 'SET_SITE_AUTO_TRANSLATE') {
        return Promise.resolve({
          ok: true,
          data: {
            ...settings,
            autoTranslateSites: request.enabled ? [request.hostname!] : [],
          },
        });
      }
      return Promise.resolve({ ok: true, data: settings });
    },
  );
  const tabSend = vi.fn().mockResolvedValue(status ?? IDLE_STATUS);
  vi.stubGlobal('chrome', {
    runtime: { sendMessage: runtimeSend, openOptionsPage },
    tabs: {
      query: vi.fn().mockResolvedValue(tab ? [tab] : []),
      sendMessage:
        status === null ? vi.fn().mockRejectedValue(new Error('page unavailable')) : tabSend,
    },
  });
  return { openOptionsPage, runtimeSend, tabSend };
}

async function renderPopup(root: Root): Promise<void> {
  await act(async () => {
    root.render(<PopupApp />);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function getButton(container: HTMLElement, name: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
    (candidate) =>
      candidate.getAttribute('aria-label') === name || candidate.textContent?.includes(name),
  );
  if (!button) throw new Error(`找不到按钮：${name}`);
  return button;
}

function setSelectValue(select: HTMLSelectElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, value);
  select.dispatchEvent(new Event('change', { bubbles: true }));
}
