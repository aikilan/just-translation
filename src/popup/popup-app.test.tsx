// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PopupApp } from './popup-app';
import type { PublicTranslatorSettings } from '../shared/messages';
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
const MAIN_FRAME = { frameId: 0 };
const publicSettings = (
  uiLanguage: PublicTranslatorSettings['uiLanguage'],
): PublicTranslatorSettings => {
  const { profiles, ...settings } = READY_SETTINGS;
  return {
    ...settings,
    uiLanguage,
    profiles: profiles.map(({ id, name, model }) => ({ id, name, configured: Boolean(model) })),
    configured: true,
  };
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => {
  view?.unmount();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('popup settings synchronization', () => {
  it('retains a storage refresh received while the initial page status is still pending', async () => {
    const { send, tabSend, storageAddListener } = mockExtension({
      ...READY_SETTINGS,
      uiLanguage: 'en',
    });
    const initialStatus = deferred<typeof IDLE_STATUS>();
    tabSend.mockImplementationOnce(() => initialStatus.promise);
    view = await mount(<PopupApp />);
    await act(async () => {
      await Promise.resolve();
    });

    send.mockResolvedValue({ ok: true, data: publicSettings('fr') });
    const listeners = storageAddListener.mock.calls.map(([item]) => item);
    await act(async () => {
      for (const listener of listeners) listener({}, 'local');
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      initialStatus.resolve(IDLE_STATUS);
      await Promise.resolve();
    });
    expect(document.documentElement.lang).toBe('fr');
  });

  it('keeps the newest storage refresh when requests complete in reverse order', async () => {
    const { send, storageAddListener } = mockExtension({ ...READY_SETTINGS, uiLanguage: 'en' });
    view = await mount(<PopupApp />);
    const requests: Array<
      ReturnType<typeof deferred<{ ok: true; data: PublicTranslatorSettings }>>
    > = [];
    send.mockImplementation(() => {
      const request = deferred<{ ok: true; data: PublicTranslatorSettings }>();
      requests.push(request);
      return request.promise;
    });
    const listeners = storageAddListener.mock.calls.map(([item]) => item);

    act(() => {
      for (const listener of listeners) listener({}, 'local');
    });
    const first = requests.splice(0);
    act(() => {
      for (const listener of listeners) listener({}, 'local');
    });
    const second = requests.splice(0);
    await act(async () => {
      for (const request of second) request.resolve({ ok: true, data: publicSettings('ar') });
      await Promise.resolve();
    });
    expect(document.documentElement.lang).toBe('ar');
    await act(async () => {
      for (const request of first) request.resolve({ ok: true, data: publicSettings('fr') });
      await Promise.resolve();
    });
    expect(document.documentElement.lang).toBe('ar');
  });
});

it('offers Arabic instead of Traditional Chinese as a preset target language', async () => {
  mockExtension();
  view = await mount(<PopupApp />);
  const options = view.container.querySelector<HTMLSelectElement>('[aria-label="翻译为"]')!;
  expect(Array.from(options.options, (option) => option.value)).toEqual([
    'Simplified Chinese',
    'English',
    'Japanese',
    'Korean',
    'French',
    'German',
    'Spanish',
    'Arabic',
    '__custom__',
  ]);
  expect(Array.from(options.options, (option) => option.textContent)).toContain('阿拉伯语');
});

describe('popup reading controls', () => {
  it.each(['idle', 'translating', 'complete'] as const)(
    'starts a full-document task from the popup while segmented mode is %s',
    async (phase) => {
      const { tabSend } = mockExtension(READY_SETTINGS, { ...IDLE_STATUS, phase });
      view = await mount(<PopupApp />);
      tabSend.mockResolvedValueOnce({
        ...IDLE_STATUS,
        mode: 'full-document',
        phase: 'translating',
        stage: 'collecting',
      });
      await click(view.container, '全文完整翻译');
      expect(tabSend).toHaveBeenCalledWith(
        7,
        { type: 'START_FULL_DOCUMENT_TRANSLATION' },
        MAIN_FRAME,
      );
      expect(view.container.textContent).toContain('收集全文');
      expect(button(view.container, '停止翻译')).toBeDefined();
      expect(view.container.textContent).not.toContain('全文完整翻译');
    },
  );

  it('shares the command lock with the main action and preserves full-mode retry after a messaging failure', async () => {
    const { tabSend } = mockExtension();
    view = await mount(<PopupApp />);
    let fail!: (reason: Error) => void;
    tabSend.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    );
    await act(async () => {
      await Promise.resolve();
      button(view.container, '全文完整翻译').click();
      button(view.container, '全文完整翻译').click();
      button(view.container, '翻译此网页').click();
    });
    expect(
      tabSend.mock.calls.filter(
        ([, command]) => (command as { type: string }).type !== 'GET_PAGE_STATUS',
      ),
    ).toEqual([[7, { type: 'START_FULL_DOCUMENT_TRANSLATION' }, MAIN_FRAME]]);
    expect(button(view.container, '全文完整翻译').disabled).toBe(true);
    await act(async () => {
      await Promise.resolve();
      fail(new Error('页面暂时未响应'));
    });
    expect(view.container.textContent).toContain('页面暂时未响应');
    expect(button(view.container, '全文完整翻译').disabled).toBe(false);
    await click(view.container, '全文完整翻译');
    expect(tabSend).toHaveBeenLastCalledWith(
      7,
      { type: 'START_FULL_DOCUMENT_TRANSLATION' },
      MAIN_FRAME,
    );
  });

  it('waits for preferences to save before allowing full-document translation', async () => {
    const { send } = mockExtension();
    view = await mount(<PopupApp />);
    let finish!: () => void;
    const savePreferences = send.getMockImplementation()!;
    send.mockImplementationOnce(async (request) => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return savePreferences(request);
    });
    await input(view.container, '翻译为', 'English');
    expect(button(view.container, '全文完整翻译').disabled).toBe(true);
    await act(async () => {
      await Promise.resolve();
      finish();
    });
    expect(button(view.container, '全文完整翻译').disabled).toBe(false);
  });

  it('does not expose full-document translation when the page cannot be reached', async () => {
    const { tabSend } = mockExtension();
    tabSend.mockRejectedValueOnce(new Error('Receiving end does not exist'));
    view = await mount(<PopupApp />);
    expect(view.container.textContent).toContain('尚未连接到当前网页');
    expect(view.container.textContent).toContain('请刷新网页后重新打开插件。');
    expect(view.container.textContent).not.toContain('全文完整翻译');
  });

  it('queries only the main frame before exposing page controls', async () => {
    const { tabSend } = mockExtension();
    view = await mount(<PopupApp />);

    expect(tabSend).toHaveBeenCalledWith(7, { type: 'GET_PAGE_STATUS' }, MAIN_FRAME);
    expect(button(view.container, '翻译此网页')).toBeDefined();
  });

  it.each([
    ['undefined response', undefined],
    ['null response', null],
    ['missing fields', {}],
    ['unknown phase', { ...IDLE_STATUS, phase: 'ready' }],
    ['negative count', { ...IDLE_STATUS, total: -1 }],
    ['legacy error', { ...IDLE_STATUS, phase: 'error', error: '旧版错误' }],
  ])('treats %s as a disconnected page', async (_label, response) => {
    const { tabSend } = mockExtension();
    tabSend.mockResolvedValueOnce(response);
    view = await mount(<PopupApp />);

    expect(view.container.textContent).toContain('尚未连接到当前网页');
    expect(view.container.textContent).toContain('请刷新网页后重新打开插件。');
    expect(view.container.textContent).not.toContain('翻译此网页');
  });

  it('shows the page connection guidance before AI setup', async () => {
    const { tabSend } = mockExtension(DEFAULT_SETTINGS);
    tabSend.mockResolvedValueOnce(undefined);
    view = await mount(<PopupApp />);

    expect(view.container.textContent).toContain('尚未连接到当前网页');
    expect(view.container.textContent).not.toContain('连接你的 AI');
  });

  it('switches to the connection guidance when status polling receives an invalid response', async () => {
    vi.useFakeTimers();
    const { tabSend } = mockExtension();
    view = await mount(<PopupApp />);
    tabSend.mockResolvedValueOnce({ ...IDLE_STATUS, displayMode: 'legacy' });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(view.container.textContent).toContain('尚未连接到当前网页');
    expect(view.container.textContent).not.toContain('翻译此网页');
  });

  it.each([
    ['translating', 'collecting', '收集全文', '停止翻译', 'STOP_TRANSLATION'],
    ['translating', 'requesting', '全文翻译中', '停止翻译', 'STOP_TRANSLATION'],
    ['translating', 'applying', '回填译文', '停止翻译', 'STOP_TRANSLATION'],
    ['stopped', undefined, '已停止', '重新全文翻译', 'START_FULL_DOCUMENT_TRANSLATION'],
    ['error', undefined, '全文翻译失败', '重新全文翻译', 'START_FULL_DOCUMENT_TRANSLATION'],
    ['complete', undefined, '翻译完成', '重新全文翻译', 'START_FULL_DOCUMENT_TRANSLATION'],
  ] as const)(
    'shows full-document %s/%s with a full retry',
    async (phase, stage, title, action, command) => {
      const { tabSend } = mockExtension(READY_SETTINGS, {
        ...IDLE_STATUS,
        mode: 'full-document',
        phase,
        stage,
        total: 6,
        failed: phase === 'error' ? 6 : 0,
      });
      view = await mount(<PopupApp />);
      expect(view.container.textContent).toContain(title);
      expect(view.container.textContent).not.toContain('部分段落未完成');
      expect(view.container.textContent).not.toContain('重试全部失败');
      expect(view.container.textContent).not.toContain('全文完整翻译');
      await click(view.container, action);
      expect(tabSend).toHaveBeenCalledWith(7, { type: command }, MAIN_FRAME);
    },
  );

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
    expect(tabSend).toHaveBeenCalledWith(7, { type: command }, MAIN_FRAME);
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
    expect(tabSend).not.toHaveBeenCalledWith(7, { type: 'RESTART_TRANSLATION' }, MAIN_FRAME);
    await click(view.container, '用新设置重新翻译');
    expect(tabSend).toHaveBeenCalledWith(7, { type: 'RESTART_TRANSLATION' }, MAIN_FRAME);
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
    expect(tabSend).not.toHaveBeenCalledWith(
      7,
      {
        type: 'SET_DISPLAY_MODE',
        displayMode: 'translation',
      },
      MAIN_FRAME,
    );
    expect(view.container.textContent).toContain('保存失败');
    expect(button(view.container, '翻译此网页')).toBeDefined();
    await click(view.container, '重试保存');
    expect(tabSend).toHaveBeenCalledWith(
      7,
      {
        type: 'SET_DISPLAY_MODE',
        displayMode: 'translation',
      },
      MAIN_FRAME,
    );
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
    expect(view.container.textContent).not.toContain('全文完整翻译');
    view.unmount();
    mockExtension({ ...READY_SETTINGS, excludedSites: ['*.example.com'] });
    view = await mount(<PopupApp />);
    expect(view.container.textContent).toContain('此站已排除');
    expect(button(view.container, '管理站点规则')).toBeDefined();
    expect(view.container.textContent).not.toContain('全文完整翻译');
    view.unmount();
    const { tabSend } = mockExtension(READY_SETTINGS, IDLE_STATUS, 'chrome://extensions');
    view = await mount(<PopupApp />);
    expect(view.container.textContent).toContain('此页面无法翻译');
    expect(view.container.textContent).not.toContain('全文完整翻译');
    expect(tabSend).not.toHaveBeenCalled();
    view.unmount();
    mockExtension(READY_SETTINGS, { ...IDLE_STATUS, phase: 'complete' });
    view = await mount(<PopupApp />);
    expect(view.container.textContent).toContain('未发现需要翻译的内容');
  });
  it('retries all failed paragraphs from the popup and preserves progress', async () => {
    const close = vi.spyOn(window, 'close').mockImplementation(() => {});
    const { tabSend } = mockExtension(READY_SETTINGS, {
      ...IDLE_STATUS,
      phase: 'error',
      total: 3,
      translated: 2,
      failed: 1,
      error: { text: 'API 缺少 choices' },
    });
    view = await mount(<PopupApp />);
    expect(view.container.textContent).toContain('API 缺少 choices');
    expect(view.container.textContent).toContain('已翻译 2');
    tabSend.mockResolvedValueOnce({
      ...IDLE_STATUS,
      phase: 'translating',
      total: 3,
      translated: 2,
    });
    await click(view.container, '重试全部失败');
    expect(tabSend).toHaveBeenLastCalledWith(
      7,
      { type: 'RETRY_FAILED_TRANSLATIONS' },
      MAIN_FRAME,
    );
    expect(close).not.toHaveBeenCalled();
    expect(button(view.container, '停止翻译')).toBeDefined();
    expect(view.container.textContent).toContain('已翻译 2');
  });
  it('locks bulk retry commands and allows retry after a messaging failure', async () => {
    const { tabSend } = mockExtension(READY_SETTINGS, {
      ...IDLE_STATUS,
      phase: 'error',
      total: 2,
      translated: 1,
      failed: 1,
    });
    view = await mount(<PopupApp />);
    let reject!: (error: Error) => void;
    tabSend.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    await act(async () => {
      await Promise.resolve();
      button(view.container, '重试全部失败').click();
      button(view.container, '重试全部失败').click();
      button(view.container, '全文完整翻译').click();
    });
    expect(
      tabSend.mock.calls.filter(
        ([, command]) => (command as { type: string }).type !== 'GET_PAGE_STATUS',
      ),
    ).toEqual([[7, { type: 'RETRY_FAILED_TRANSLATIONS' }, MAIN_FRAME]]);
    expect(button(view.container, '重试全部失败').disabled).toBe(true);
    await act(async () => {
      await Promise.resolve();
      reject(new Error('网页未响应'));
    });
    expect(view.container.textContent).toContain('网页未响应');
    expect(button(view.container, '重试全部失败').disabled).toBe(false);
    await click(view.container, '重试全部失败');
    expect(tabSend).toHaveBeenLastCalledWith(
      7,
      { type: 'RETRY_FAILED_TRANSLATIONS' },
      MAIN_FRAME,
    );
  });
});

it('shows incremental full-mode progress and retries only failed additions', async () => {
  const { tabSend } = mockExtension(READY_SETTINGS, {
    ...IDLE_STATUS,
    mode: 'full-document',
    phase: 'error',
    stage: 'incremental',
    total: 7,
    translated: 6,
    failed: 1,
  });
  view = await mount(<PopupApp />);
  expect(view.container.textContent).toContain('部分段落未完成');
  expect(button(view.container, '重新全文翻译')).toBeDefined();
  await click(view.container, '重试全部失败');
  expect(tabSend).toHaveBeenCalledWith(
    7,
    { type: 'RETRY_FAILED_TRANSLATIONS' },
    MAIN_FRAME,
  );
});

it('labels full-mode incremental work separately from the first full request', async () => {
  mockExtension(READY_SETTINGS, {
    ...IDLE_STATUS,
    mode: 'full-document',
    phase: 'translating',
    stage: 'incremental',
    total: 7,
    translated: 6,
  });
  view = await mount(<PopupApp />);
  expect(view.container.textContent).toContain('正在补译新内容');
  expect(view.container.textContent).not.toContain('全文完成后统一显示译文');
});
