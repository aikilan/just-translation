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
vi.mock('../content/quick-translation-loader.iife.ts?script&iife', () => ({
  default: 'quick-loader.js',
}));
vi.mock('../content/quick-translation-entry.ts?script&module', () => ({
  default: 'assets/quick-translation-entry.js',
}));
const MAIN_FRAME = { frameId: 0 };
const publicSettings = (
  uiLanguage: PublicTranslatorSettings['uiLanguage'],
): PublicTranslatorSettings => {
  const { profiles, ...settings } = READY_SETTINGS;
  return {
    ...settings,
    uiLanguage,
    profiles: profiles.map(({ id, name, model }) => ({
      id,
      name,
      configured: Boolean(model),
      supportsImageInput: false,
    })),
    ready: true,
    supportsFullDocument: true,
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

describe('popup status summary', () => {
  it.each(['bilingual', 'translation'] as const)(
    'shows translation actions without idle guidance in %s mode',
    async (displayMode) => {
      mockExtension({ ...READY_SETTINGS, displayMode }, { ...IDLE_STATUS, displayMode });
      view = await mount(<PopupApp />);

      expect(view.container.textContent).not.toContain('准备翻译');
      expect(view.container.textContent).not.toContain('译文将显示在原文下方。');
      const region = view.container.querySelector('[aria-label="网页翻译状态"]')!;
      expect(region.querySelector('h1, [role="status"]')).toBeNull();
      expect(button(view.container, '翻译此网页').disabled).toBe(false);
      expect(button(view.container, '全文完整翻译').disabled).toBe(false);
      expect(button(view.container, '快捷翻译').disabled).toBe(false);
    },
  );

  it('shows translation progress and removes the summary after restoring the page', async () => {
    const { tabSend } = mockExtension();
    view = await mount(<PopupApp />);
    tabSend.mockResolvedValueOnce({
      ...IDLE_STATUS,
      phase: 'translating',
      total: 2,
      translated: 1,
    });

    await click(view.container, '翻译此网页');
    expect(view.container.querySelector('h1')?.textContent).toBe('正在翻译');
    expect(view.container.querySelector('[role="status"]')?.textContent).toContain('1 / 2');
    expect(
      view.container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow'),
    ).toBe('1');

    await click(view.container, '恢复原文');
    expect(tabSend).toHaveBeenCalledWith(7, { type: 'RESTORE_PAGE' }, MAIN_FRAME);
    expect(view.container.querySelector('h1, [role="status"], [role="progressbar"]')).toBeNull();
    expect(button(view.container, '翻译此网页').disabled).toBe(false);
  });

  it('keeps actionable restart guidance even when the page phase is idle', async () => {
    mockExtension(READY_SETTINGS, { ...IDLE_STATUS, needsRestart: true });
    view = await mount(<PopupApp />);

    expect(view.container.querySelector('h1')?.textContent).toBe('新设置已就绪');
    expect(view.container.querySelector('[role="status"]')?.textContent).toContain(
      '重新翻译后应用新设置',
    );
    expect(button(view.container, '用新设置重新翻译').disabled).toBe(false);
  });
});

describe('quick translation entry', () => {
  it('opens in the main page once and closes the popup only after acknowledgement', async () => {
    const { executeScript } = mockExtension();
    const close = vi.spyOn(window, 'close').mockImplementation(() => {});
    view = await mount(<PopupApp />);
    const loading = deferred<chrome.scripting.InjectionResult<unknown>[]>();
    const opening = deferred<chrome.scripting.InjectionResult<unknown>[]>();
    executeScript.mockReturnValueOnce(loading.promise).mockReturnValueOnce(opening.promise);
    act(() => {
      button(view.container, '快捷翻译').click();
      button(view.container, '快捷翻译').click();
    });
    expect(executeScript).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        target: { tabId: 7, frameIds: [0] },
        world: 'ISOLATED',
      }),
    );
    expect(close).not.toHaveBeenCalled();
    await act(async () => {
      await Promise.resolve();
      loading.resolve([{ frameId: 0, documentId: 'page', result: undefined }]);
    });
    expect(executeScript).toHaveBeenCalledTimes(2);
    expect(close).not.toHaveBeenCalled();
    await act(async () => {
      await Promise.resolve();
      opening.resolve([{ frameId: 0, documentId: 'page', result: { ok: true } }]);
    });
    expect(close).toHaveBeenCalledOnce();
  });
  it('leaves the popup open and reports a failed open', async () => {
    const { executeScript } = mockExtension();
    const close = vi.spyOn(window, 'close').mockImplementation(() => {});
    view = await mount(<PopupApp />);
    executeScript.mockResolvedValueOnce([{ frameId: 0, documentId: 'page', result: undefined }]);
    executeScript.mockResolvedValueOnce([
      {
        frameId: 0,
        documentId: 'page',
        result: {
          ok: false,
          error: { text: 'Cannot open dialog' },
        },
      },
    ]);
    await click(view.container, '快捷翻译');
    expect(view.container.textContent).toContain('Cannot open dialog');
    expect(view.container.querySelector('.popup-notice [role="alert"]')?.textContent).toContain(
      'Cannot open dialog',
    );
    expect(close).not.toHaveBeenCalled();
    expect(button(view.container, '快捷翻译').disabled).toBe(false);
  });
  it.each(['no receiver', 'invalid status'])(
    'opens independently when the page has %s',
    async (reason) => {
      const { tabSend, executeScript } = mockExtension();
      if (reason === 'no receiver')
        tabSend.mockRejectedValue(new Error('Receiving end does not exist'));
      else tabSend.mockResolvedValue(undefined);
      const close = vi.spyOn(window, 'close').mockImplementation(() => {});
      view = await mount(<PopupApp />);
      expect(view.container.textContent).toContain('请刷新页面重新连接插件');
      expect(button(view.container, '快捷翻译').disabled).toBe(false);
      expect(executeScript).not.toHaveBeenCalled();
      await click(view.container, '快捷翻译');
      expect(executeScript).toHaveBeenCalledTimes(2);
      expect(
        tabSend.mock.calls.every(
          ([, command]) => (command as { type: string }).type === 'GET_PAGE_STATUS',
        ),
      ).toBe(true);
      expect(close).toHaveBeenCalledOnce();
    },
  );
  it('keeps injection errors retryable while the page remains disconnected', async () => {
    const { tabSend, executeScript } = mockExtension();
    tabSend.mockRejectedValue(new Error('No page listener'));
    executeScript.mockRejectedValueOnce(new Error('Cannot access this page'));
    const close = vi.spyOn(window, 'close').mockImplementation(() => {});
    view = await mount(<PopupApp />);
    await click(view.container, '快捷翻译');
    expect(view.container.textContent).toContain('Cannot access this page');
    expect(close).not.toHaveBeenCalled();
    expect(button(view.container, '快捷翻译').disabled).toBe(false);
    await click(view.container, '快捷翻译');
    expect(executeScript).toHaveBeenCalledTimes(3);
    expect(close).toHaveBeenCalledOnce();
  });
  it('remains available on an excluded site even when the selected AI is unconfigured', async () => {
    mockExtension({
      ...READY_SETTINGS,
      excludedSites: ['news.example.com'],
      profiles: READY_SETTINGS.profiles.map((p) => ({ ...p, model: '' })),
    });
    view = await mount(<PopupApp />);
    expect(button(view.container, '快捷翻译').disabled).toBe(false);
  });
  it('shows a disabled entry on a browser page that cannot host the dialog', async () => {
    const { executeScript } = mockExtension(READY_SETTINGS, IDLE_STATUS, 'chrome://extensions/');
    view = await mount(<PopupApp />);
    expect(button(view.container, '快捷翻译').disabled).toBe(true);
    await click(view.container, '快捷翻译');
    expect(executeScript).not.toHaveBeenCalled();
  });
});

describe('popup notices', () => {
  it.each<[string, typeof READY_SETTINGS, string, string]>([
    ['restricted page', READY_SETTINGS, 'chrome://extensions/', '此页面无法翻译，请切换到普通网页'],
    [
      'excluded site',
      { ...READY_SETTINGS, excludedSites: ['news.example.com'] },
      'https://news.example.com/article',
      '此站已排除',
    ],
    [
      'unconfigured AI',
      { ...READY_SETTINGS, profiles: READY_SETTINGS.profiles.map((p) => ({ ...p, model: '' })) },
      'https://news.example.com/article',
      '当前翻译配置不存在',
    ],
    [
      'unsupported free-channel language',
      { ...DEFAULT_SETTINGS, targetLanguage: 'Klingon' },
      'https://news.example.com/article',
      '免费翻译通道不支持当前目标语言',
    ],
  ])('shows one compact message for %s', async (_name, settings, url, text) => {
    mockExtension(settings, IDLE_STATUS, url);
    view = await mount(<PopupApp />);

    const notice = view.container.querySelector('.popup-notice')!;
    expect(notice.querySelectorAll('p')).toHaveLength(1);
    expect(notice.querySelector('p')?.textContent).toBe(text);
    expect(notice.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(notice.querySelector('h1, h2')).toBeNull();
    expect(view.container.textContent).not.toContain('请切换到普通网页后使用快捷翻译。');
  });

  it('keeps the settings error and reload action without a separate heading', async () => {
    const { send } = mockExtension();
    send.mockRejectedValueOnce(new Error('设置读取失败'));
    view = await mount(<PopupApp />);

    const notice = view.container.querySelector('.popup-notice')!;
    expect(notice.querySelectorAll('p')).toHaveLength(1);
    expect(notice.querySelector('[role="alert"]')?.textContent).toBe('设置读取失败');
    expect(notice.querySelector('h1, h2')).toBeNull();
    expect(button(view.container, '重新加载').disabled).toBe(false);
  });
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
    const notice = view.container.querySelector('[role="status"]');
    expect(notice?.textContent).toBe('请刷新页面重新连接插件');
    expect(notice?.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(view.container.querySelector('h1')).toBeNull();
    expect(view.container.textContent).not.toContain('请刷新网页后重新打开插件。');
    expect(view.container.textContent).not.toContain('全文完整翻译');
  });

  it('localizes the compact page reconnection guidance', async () => {
    const { tabSend } = mockExtension({ ...READY_SETTINGS, uiLanguage: 'en' });
    tabSend.mockResolvedValueOnce(undefined);
    view = await mount(<PopupApp />);

    expect(view.container.querySelector('[role="status"]')?.textContent).toBe(
      'Refresh the page to reconnect the extension',
    );
    expect(view.container.querySelector('h1')).toBeNull();
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

    expect(view.container.textContent).toContain('请刷新页面重新连接插件');
    expect(view.container.textContent).not.toContain('尚未连接到当前网页');
    expect(view.container.textContent).not.toContain('翻译此网页');
  });

  it('shows the page connection guidance before AI setup', async () => {
    const { tabSend } = mockExtension(DEFAULT_SETTINGS);
    tabSend.mockResolvedValueOnce(undefined);
    view = await mount(<PopupApp />);

    expect(view.container.textContent).toContain('请刷新页面重新连接插件');
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

    expect(view.container.textContent).toContain('请刷新页面重新连接插件');
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
      if (phase === 'error') {
        expect(view.container.textContent).toContain('全文请求失败，未应用译文；共 6 个阅读单元');
        expect(view.container.textContent).not.toContain('6 个失败');
      }
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
    expect(view.container.querySelector('[aria-label="翻译引擎"]')).not.toBeNull();
    expect(view.container.querySelector('[aria-label="翻译为"]')).not.toBeNull();
    expect(button(view.container, '恢复原文').disabled).toBe(true);
    await click(view.container, '打开设置');
    expect(openOptionsPage).toHaveBeenCalledOnce();
  });

  it('offers zero-configuration engines with disclosure and switches them explicitly', async () => {
    const { send } = mockExtension(DEFAULT_SETTINGS);
    view = await mount(<PopupApp />);
    const engine = view.container.querySelector<HTMLSelectElement>('[aria-label="翻译引擎"]')!;
    expect(Array.from(engine.options, (option) => option.textContent)).toEqual([
      'Google 翻译（非官方免费通道）',
      'Microsoft 翻译（非官方免费通道）',
      '默认配置（待配置）',
    ]);
    expect(view.container.textContent).toContain('网页文本会发送给 Google');
    expect(view.container.textContent).toContain('可用性不受保证');
    expect(button(view.container, '全文完整翻译').disabled).toBe(true);
    expect(button(view.container, '全文完整翻译').title).toBe('仅支持 AI 配置');
    expect(view.container.textContent).toContain('仅支持 AI 配置');
    expect(button(view.container, '全文完整翻译').getAttribute('aria-describedby')).toBe(
      'full-document-ai-only',
    );
    expect(
      view.container.querySelector<HTMLOptionElement>(
        '[aria-label="翻译为"] option[value="__custom__"]',
      )?.disabled,
    ).toBe(true);

    await input(view.container, '翻译引擎', 'builtin:microsoft-free');
    expect(send).toHaveBeenCalledWith({
      type: 'SET_ACTIVE_TRANSLATOR',
      translator: { kind: 'builtin', engine: 'microsoft-free' },
    });
    expect(view.container.textContent).toContain('网页文本会发送给 Microsoft');
  });

  it('keeps engine and language controls available when a free channel has a custom target', async () => {
    mockExtension({ ...DEFAULT_SETTINGS, targetLanguage: 'Klingon' });
    view = await mount(<PopupApp />);
    expect(view.container.textContent).toContain('免费翻译通道不支持当前目标语言');
    expect(view.container.querySelector('[aria-label="翻译引擎"]')).not.toBeNull();
    expect(view.container.querySelector('[aria-label="翻译为"]')).not.toBeNull();
    expect(
      view.container.querySelector<HTMLOptionElement>(
        '[aria-label="翻译为"] option[value="__custom__"]',
      )?.disabled,
    ).toBe(true);
    expect(
      view.container.querySelector<HTMLInputElement>('[aria-label="自定义目标语言"]')?.disabled,
    ).toBe(true);
    expect(view.container.textContent).toContain('自定义目标语言仅支持 AI 配置');
    expect(view.container.textContent).not.toContain('检查 AI 配置');
  });

  it('keeps custom target-language entry available for AI profiles', async () => {
    mockExtension(READY_SETTINGS);
    view = await mount(<PopupApp />);
    expect(
      view.container.querySelector<HTMLOptionElement>(
        '[aria-label="翻译为"] option[value="__custom__"]',
      )?.disabled,
    ).toBe(false);
    expect(view.container.textContent).not.toContain('自定义目标语言仅支持 AI 配置');
  });

  it('keeps free-channel runtime errors on manual retry or engine-switch recovery', async () => {
    mockExtension(DEFAULT_SETTINGS, {
      ...IDLE_STATUS,
      phase: 'error',
      total: 1,
      failed: 1,
      error: { text: '免费翻译通道暂时不可用，请稍后手动重试或切换引擎' },
    });
    view = await mount(<PopupApp />);

    expect(view.container.textContent).toContain('免费翻译通道暂时不可用');
    expect(view.container.querySelector('[aria-label="翻译引擎"]')).not.toBeNull();
    expect(view.container.textContent).not.toContain('检查 AI 配置');
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
      context: {
        translator: { kind: 'ai', profileId: 'second' },
        targetLanguage: 'Japanese',
      },
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
          translator: READY_SETTINGS.activeTranslator,
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
    await input(view.container, '翻译引擎', 'ai:second');
    expect(view.container.querySelector<HTMLSelectElement>('[aria-label="翻译引擎"]')?.value).toBe(
      'ai:profile-default',
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
    expect(button(view.container, '翻译此网页')).toBeDefined();
    expect(view.container.querySelector<HTMLSelectElement>('[aria-label="翻译引擎"]')?.value).toBe(
      'builtin:google-free',
    );
    expect(button(view.container, '全文完整翻译').disabled).toBe(true);
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
    expect(tabSend).toHaveBeenLastCalledWith(7, { type: 'RETRY_FAILED_TRANSLATIONS' }, MAIN_FRAME);
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
    expect(tabSend).toHaveBeenLastCalledWith(7, { type: 'RETRY_FAILED_TRANSLATIONS' }, MAIN_FRAME);
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
  expect(tabSend).toHaveBeenCalledWith(7, { type: 'RETRY_FAILED_TRANSLATIONS' }, MAIN_FRAME);
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
