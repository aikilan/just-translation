// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PopupApp } from './popup-app';
import { DEFAULT_SETTINGS } from '../shared/settings';
import {
  button,
  click,
  input,
  mount,
  mockExtension,
  IDLE_STATUS,
  READY_SETTINGS,
} from '../test-utils/ui';
let view: Awaited<ReturnType<typeof mount>>;
afterEach(() => {
  view?.unmount();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe('popup reading controls', () => {
  it('exposes the primary action and preferences without an accordion', async () => {
    const { openOptionsPage } = mockExtension();
    view = await mount(<PopupApp />);
    expect(view.container.textContent).toContain('news.example.com');
    expect(view.container.textContent).not.toContain('更多设置');
    expect(button(view.container, '翻译此网页')).toBeDefined();
    expect(view.container.querySelector('[aria-label="AI 配置"]')).not.toBeNull();
    expect(view.container.querySelector('[aria-label="翻译为"]')).not.toBeNull();
    expect(button(view.container, '恢复原文').disabled).toBe(true);
    await click(view.container, '打开设置');
    expect(openOptionsPage).toHaveBeenCalledOnce();
  });
  it.each([
    ['idle', 0, '翻译此网页', 'START_TRANSLATION'],
    ['translating', 8, '停止翻译', 'STOP_TRANSLATION'],
    ['stopped', 8, '继续翻译', 'START_TRANSLATION'],
    ['complete', 8, '翻译新内容', 'START_TRANSLATION'],
  ] as const)('maps %s to its command', async (phase, total, action, command) => {
    const { tabSend } = mockExtension(READY_SETTINGS, { ...IDLE_STATUS, phase, total });
    view = await mount(<PopupApp />);
    await click(view.container, action);
    expect(tabSend).toHaveBeenCalledWith(7, { type: command });
  });
  it('detects context differences on reopening and restarts only explicitly', async () => {
    const { send, tabSend } = mockExtension(READY_SETTINGS, {
      ...IDLE_STATUS,
      phase: 'complete',
      translated: 2,
      total: 2,
      context: { profileId: 'second', targetLanguage: 'Japanese' },
    });
    view = await mount(<PopupApp />);
    expect(button(view.container, '用新设置重新翻译')).toBeDefined();
    await input(view.container, '翻译为', 'English');
    expect(send).toHaveBeenCalledWith({
      type: 'UPDATE_READING_PREFERENCES',
      patch: { targetLanguage: 'English' },
    });
    expect(tabSend).not.toHaveBeenCalledWith(7, { type: 'RESTART_TRANSLATION' });
    await click(view.container, '用新设置重新翻译');
    expect(tabSend).toHaveBeenCalledWith(7, { type: 'RESTART_TRANSLATION' });
  });
  it('shows the current document mode when the default was changed elsewhere', async () => {
    mockExtension(
      { ...READY_SETTINGS, displayMode: 'translation' },
      {
        ...IDLE_STATUS,
        phase: 'complete',
        total: 2,
        translated: 2,
        context: {
          profileId: READY_SETTINGS.activeProfileId,
          targetLanguage: READY_SETTINGS.targetLanguage,
        },
      },
    );
    view = await mount(<PopupApp />);
    expect(button(view.container, '双语').getAttribute('aria-pressed')).toBe('true');
  });

  it('persists mode before applying it, retains the action on failure, and retries', async () => {
    const { send, tabSend } = mockExtension();
    view = await mount(<PopupApp />);
    send.mockRejectedValueOnce(new Error('保存失败'));
    await click(view.container, '仅译文');
    expect(tabSend).not.toHaveBeenCalledWith(7, {
      type: 'SET_DISPLAY_MODE',
      displayMode: 'translation',
    });
    expect(view.container.textContent).toContain('保存失败');
    expect(button(view.container, '翻译此网页')).toBeDefined();
    await click(view.container, '重试保存');
    expect(tabSend).toHaveBeenCalledWith(7, {
      type: 'SET_DISPLAY_MODE',
      displayMode: 'translation',
    });
  });
  it('leaves a failed profile selection unapplied and guards duplicate commands', async () => {
    const { send, tabSend } = mockExtension();
    view = await mount(<PopupApp />);
    send.mockRejectedValueOnce(new Error('写入失败'));
    await input(view.container, 'AI 配置', 'second');
    expect(view.container.querySelector<HTMLSelectElement>('[aria-label="AI 配置"]')?.value).toBe(
      READY_SETTINGS.activeProfileId,
    );
    let finish!: () => void;
    tabSend.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(IDLE_STATUS);
        }),
    );
    await act(async () => {
      await Promise.resolve();
      button(view.container, '翻译此网页').click();
      button(view.container, '翻译此网页').click();
    });
    expect(
      tabSend.mock.calls.filter(
        (call) => (call[1] as { type: string }).type === 'START_TRANSLATION',
      ),
    ).toHaveLength(1);
    await act(async () => {
      await Promise.resolve();
      finish();
    });
  });
  it('handles setup, exclusion, restricted pages and empty completion', async () => {
    mockExtension(DEFAULT_SETTINGS);
    view = await mount(<PopupApp />);
    expect(button(view.container, '连接你的 AI')).toBeDefined();
    expect(view.container.textContent).not.toContain('翻译此网页');
    view.unmount();
    mockExtension({ ...READY_SETTINGS, excludedSites: ['*.example.com'] });
    view = await mount(<PopupApp />);
    expect(view.container.textContent).toContain('此站已排除');
    expect(button(view.container, '管理站点规则')).toBeDefined();
    view.unmount();
    mockExtension(READY_SETTINGS, IDLE_STATUS, 'chrome://extensions');
    view = await mount(<PopupApp />);
    expect(view.container.textContent).toContain('此页面无法翻译');
    view.unmount();
    mockExtension(READY_SETTINGS, { ...IDLE_STATUS, phase: 'complete' });
    view = await mount(<PopupApp />);
    expect(view.container.textContent).toContain('未发现需要翻译的内容');
  });
  it('returns to the page for partial retry and displays the provider error', async () => {
    const close = vi.spyOn(window, 'close').mockImplementation(() => {});
    mockExtension(READY_SETTINGS, {
      ...IDLE_STATUS,
      phase: 'error',
      total: 3,
      translated: 2,
      failed: 1,
      error: 'API 缺少 choices',
    });
    view = await mount(<PopupApp />);
    expect(view.container.textContent).toContain('API 缺少 choices');
    expect(view.container.textContent).toContain('已翻译 2');
    await click(view.container, '返回网页重试');
    expect(close).toHaveBeenCalledOnce();
  });
});
