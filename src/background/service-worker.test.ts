import { renderMessage } from '../shared/i18n';
import { TEST_PROFILE } from '../test-utils/provider';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Result, RuntimeRequest } from '../shared/messages';
import {
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
  type TranslationProfile,
} from '../shared/settings';
import type { ActiveTranslator } from '../shared/translation-engines';
import { contentEvent, STREAM_END, completionResponse } from '../test-utils/sse';

type MessageListener = (
  request: RuntimeRequest,
  sender: chrome.runtime.MessageSender,
  respond: (result: Result<unknown>) => void,
) => void;

describe('background document lifecycle', () => {
  let message: MessageListener;
  let committed: (details: { tabId: number; frameId: number; documentId: string }) => void;
  let documentId: string;
  let session: Record<string, unknown>;
  let fetchMock: ReturnType<typeof vi.fn<(_url: string, init: RequestInit) => Promise<Response>>>;
  let holdSessionRead: (() => Promise<void>) | undefined;
  let holdSettings: (() => Promise<void>) | undefined;
  let translationRetryCount: number;
  let activeProfile: TranslationProfile;
  let activeTranslator: ActiveTranslator;
  let activeTabs: chrome.tabs.Tab[];
  let menuStatus: unknown;
  const sender = (id: string): chrome.runtime.MessageSender => ({
    tab: { id: 18, url: 'https://news.ycombinator.com/news' } as chrome.tabs.Tab,
    documentId: id,
    frameId: 0,
    url: 'https://news.ycombinator.com/news',
  });
  const send = (request: RuntimeRequest, id = documentId) =>
    new Promise<Result<unknown>>((resolve) => message(request, sender(id), resolve));

  beforeEach(async () => {
    vi.resetModules();
    documentId = 'old-document';
    activeTabs = [];
    menuStatus = undefined;
    session = {};
    holdSettings = undefined;
    translationRetryCount = 1;
    holdSessionRead = undefined;
    activeProfile = { ...TEST_PROFILE, model: 'test-model' };
    activeTranslator = { kind: 'ai', profileId: activeProfile.id };
    const settings = {
      ...DEFAULT_SETTINGS,
      profiles: [activeProfile],
    };
    const event = () => ({ addListener: vi.fn() });
    fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason as Error));
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('chrome', {
      i18n: { getUILanguage: () => 'zh-CN' },
      action: { setTitle: vi.fn().mockResolvedValue(undefined) },
      storage: {
        onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
        local: {
          setAccessLevel: vi.fn(),
          get: async () => {
            await holdSettings?.();
            return {
              [SETTINGS_STORAGE_KEY]: { ...settings, activeTranslator, translationRetryCount },
            };
          },
          set: vi.fn(),
        },
        session: {
          setAccessLevel: vi.fn(),
          get: async (key: string | null) => {
            const value = structuredClone(key === null ? session : { [key]: session[key] });
            await holdSessionRead?.();
            return value;
          },
          set: (entries: Record<string, unknown>) => {
            Object.assign(session, structuredClone(entries));
            return Promise.resolve();
          },
          remove: (keys: string | string[]) => {
            for (const key of Array.isArray(keys) ? keys : [keys]) delete session[key];
            return Promise.resolve();
          },
        },
      },
      runtime: {
        getPlatformInfo: vi.fn().mockResolvedValue({ os: 'mac' }),
        id: 'test-extension',
        onInstalled: event(),
        onStartup: event(),
        onMessage: {
          addListener: (listener: MessageListener) => {
            message = listener;
          },
        },
      },
      alarms: { get: () => Promise.resolve({ name: 'cleanup' }), onAlarm: event() },
      contextMenus: {
        update: vi.fn().mockResolvedValue(undefined),
        removeAll: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
        create: vi.fn((_properties, callback: () => void) => {
          callback();
        }),
        onClicked: event(),
      },
      commands: { onCommand: event() },
      windows: { onFocusChanged: event() },
      tabs: {
        onRemoved: event(),
        onActivated: event(),
        onUpdated: event(),
        query: vi.fn(() => Promise.resolve(activeTabs)),
        sendMessage: vi.fn(() => Promise.resolve(menuStatus)),
      },
      webNavigation: {
        getFrame: () => Promise.resolve({ documentId, frameId: 0 }),
        onCommitted: {
          addListener: (listener: typeof committed) => {
            committed = listener;
          },
        },
      },
    });
    await import('./service-worker');
  });

  afterEach(() => vi.unstubAllGlobals());

  it('requeues only never-sent offscreen batches and preserves admitted HTTP', async () => {
    await send({
      type: 'BEGIN_TRANSLATION_SESSION',
      translator: { kind: 'ai', profileId: activeProfile.id },
      sessionId: 'viewport',
      mode: 'segmented',
    });
    const jobs = Array.from({ length: 8 }, (_, index) =>
      send({
        type: 'TRANSLATE_BATCH',
        sessionId: 'viewport',
        batchId: `job-${index}`,
        priority: 'visible',
        segments: [
          { requestId: `p${index}`, unitId: `p${index}`, partIndex: 0, text: `Paragraph ${index}` },
        ],
      }),
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(6));
    const signals = fetchMock.mock.calls.map(([, init]) => init.signal!);
    await send({
      type: 'UPDATE_TRANSLATION_PRIORITIES',
      sessionId: 'viewport',
      revision: 1,
      batches: Array.from({ length: 8 }, (_, index) => ({
        batchId: `job-${index}`,
        priority: 'background',
      })),
      requeueUnsent: true,
    });
    expect(await jobs[6]).toEqual({ ok: true, data: { deferred: true } });
    expect(await jobs[7]).toEqual({ ok: true, data: { deferred: true } });
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
    await send({ type: 'CANCEL_TRANSLATION_REQUESTS', sessionId: 'viewport' });
    await Promise.all(jobs);
  });

  it('returns work still awaiting session lookup without ever submitting HTTP', async () => {
    await send({
      type: 'BEGIN_TRANSLATION_SESSION',
      translator: { kind: 'ai', profileId: activeProfile.id },
      sessionId: 'preflight',
      mode: 'segmented',
    });
    let release!: () => void;
    holdSessionRead = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    const work = send({
      type: 'TRANSLATE_BATCH',
      sessionId: 'preflight',
      batchId: 'waiting',
      priority: 'background',
      segments: [{ requestId: 'a', unitId: 'a', partIndex: 0, text: 'Paragraph' }],
    });
    await vi.waitFor(() => expect(release).toBeDefined());
    holdSessionRead = undefined;
    await send({
      type: 'UPDATE_TRANSLATION_PRIORITIES',
      sessionId: 'preflight',
      revision: 1,
      batches: [{ batchId: 'waiting', priority: 'background' }],
      requeueUnsent: true,
    });
    release();
    expect(await work).toEqual({ ok: true, data: { deferred: true } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ignores late priority snapshots and keeps the strict rate window when reordering', async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockImplementation((_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as { messages: { content: string }[] };
        const input = JSON.parse(body.messages[1].content) as { segments: { id: string }[] };
        return Promise.resolve(
          completionResponse(input.segments.map(({ id }) => ({ id, text: '译文' }))),
        );
      });
      await send({
        type: 'BEGIN_TRANSLATION_SESSION',
        translator: { kind: 'ai', profileId: activeProfile.id },
        sessionId: 'order',
        mode: 'segmented',
      });
      const jobs = Array.from({ length: 8 }, (_, index) =>
        send({
          type: 'TRANSLATE_BATCH',
          sessionId: 'order',
          batchId: `job-${index}`,
          priority: index === 6 ? 'visible' : 'background',
          segments: [
            {
              requestId: `p${index}`,
              unitId: `p${index}`,
              partIndex: 0,
              text: `Paragraph ${index}`,
            },
          ],
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(6);
      await send({
        type: 'UPDATE_TRANSLATION_PRIORITIES',
        sessionId: 'order',
        revision: 2,
        batches: [
          { batchId: 'job-6', priority: 'background' },
          { batchId: 'job-7', priority: 'visible' },
        ],
        requeueUnsent: false,
      });
      await send({
        type: 'UPDATE_TRANSLATION_PRIORITIES',
        sessionId: 'order',
        revision: 1,
        batches: [
          { batchId: 'job-6', priority: 'visible' },
          { batchId: 'job-7', priority: 'background' },
        ],
        requeueUnsent: true,
      });
      await vi.advanceTimersByTimeAsync(999);
      expect(fetchMock).toHaveBeenCalledTimes(6);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchMock.mock.calls[6][1].body).toContain('Paragraph 7');
      expect(fetchMock.mock.calls[7][1].body).toContain('Paragraph 6');
      expect((await Promise.all(jobs)).every((result) => result.ok)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('executes selection requests through the real queue without creating page sessions', async () => {
    fetchMock.mockResolvedValue(completionResponse([{ id: 'selection', text: '选区译文' }]));
    const response = await send({
      type: 'TRANSLATE_SELECTION',
      requestId: 'selected',
      text: 'Only this paragraph',
      translator: activeTranslator,
    });
    expect(response).toEqual({
      ok: true,
      data: {
        text: '选区译文',
        targetLanguage: DEFAULT_SETTINGS.targetLanguage,
        translatorName: activeProfile.name,
      },
    });
    expect(Object.keys(session)).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as {
      messages: { content: string }[];
    };
    expect(JSON.parse(body.messages[1].content)).toEqual({
      segments: [{ id: 'selection', group: 'selection', part: 0, text: 'Only this paragraph' }],
    });
  });

  it('translates without an API profile through the selected Google free engine', async () => {
    activeTranslator = { kind: 'builtin', engine: 'google-free' };
    activeProfile.model = '';
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ sentences: [{ trans: '你好 [[JT_KEEP_0]]' }] }), {
        status: 200,
      }),
    );

    await expect(
      send({
        type: 'TRANSLATE_SELECTION',
        requestId: 'free-selection',
        text: 'Hello [[JT_KEEP_0]]',
        translator: activeTranslator,
      }),
    ).resolves.toEqual({
      ok: true,
      data: {
        text: '你好 [[JT_KEEP_0]]',
        targetLanguage: 'Simplified Chinese',
        translatorName: 'Google',
      },
    });
    expect(String(fetchMock.mock.calls[0][0])).toContain('translate.googleapis.com');

    fetchMock.mockClear();
    const begin = await send({
      type: 'BEGIN_TRANSLATION_SESSION',
      translator: activeTranslator,
      sessionId: 'free-page',
      mode: 'segmented',
    });
    expect(begin).toMatchObject({
      ok: true,
      data: {
        context: { translator: activeTranslator, targetLanguage: 'Simplified Chinese' },
        maxConcurrency: 2,
        batchProfiles: { visible: { maxCharacters: 1_000, maxItems: 1 } },
      },
    });
    await expect(
      send({
        type: 'BEGIN_TRANSLATION_SESSION',
        translator: activeTranslator,
        sessionId: 'free-full',
        mode: 'full-document',
      }),
    ).resolves.toMatchObject({ ok: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('dispatches an ordinary page batch through the snapshotted Google free engine', async () => {
    activeTranslator = { kind: 'builtin', engine: 'google-free' };
    activeProfile.model = '';
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ sentences: [{ trans: '页面译文' }] }), { status: 200 }),
    );
    await send({
      type: 'BEGIN_TRANSLATION_SESSION',
      translator: activeTranslator,
      sessionId: 'google-page',
      mode: 'segmented',
    });

    await expect(
      send({
        type: 'TRANSLATE_BATCH',
        sessionId: 'google-page',
        batchId: 'google-batch',
        priority: 'background',
        segments: [{ requestId: 'p:0', unitId: 'p', partIndex: 0, text: 'Page text' }],
      }),
    ).resolves.toEqual({
      ok: true,
      data: { translations: { 'p:0': '页面译文' }, failures: {} },
    });
    expect(String(fetchMock.mock.calls[0][0])).toContain('translate.googleapis.com');
  });

  it('translates a selection through the current Bing page-token flow', async () => {
    activeTranslator = { kind: 'builtin', engine: 'microsoft-free' };
    activeProfile.model = '';
    const auth = new Response(
      '<script>var params_AbusePreventionHelper=[1720000000000,"token",3600000];var _G={IG:"0123456789ABCDEF0123456789ABCDEF"};</script><div id="rich_tta" data-iid="translator.5028.1"></div>',
      { status: 200 },
    );
    Object.defineProperty(auth, 'url', { value: 'https://www.bing.com/translator' });
    fetchMock.mockResolvedValueOnce(auth).mockResolvedValueOnce(
      new Response(JSON.stringify([{ translations: [{ text: 'Bing 译文', to: 'zh-Hans' }] }]), {
        status: 200,
      }),
    );

    await expect(
      send({
        type: 'TRANSLATE_SELECTION',
        requestId: 'bing-selection',
        text: 'Selected text',
        translator: activeTranslator,
      }),
    ).resolves.toEqual({
      ok: true,
      data: {
        text: 'Bing 译文',
        targetLanguage: 'Simplified Chinese',
        translatorName: 'Microsoft',
      },
    });
    expect(String(fetchMock.mock.calls[1][0])).toContain('www.bing.com/ttranslatev3');
  });

  it('rejects a stale engine selection before storing a session or issuing HTTP', async () => {
    activeTranslator = { kind: 'builtin', engine: 'google-free' };
    await expect(
      send({
        type: 'BEGIN_TRANSLATION_SESSION',
        translator: { kind: 'builtin', engine: 'microsoft-free' },
        sessionId: 'stale-engine',
        mode: 'segmented',
      }),
    ).resolves.toEqual({
      ok: false,
      error: { key: '翻译设置已改变，请重新开始翻译' },
    });
    expect(Object.keys(session)).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a stale menu-bound selection recipient before issuing HTTP', async () => {
    activeTranslator = { kind: 'builtin', engine: 'google-free' };

    await expect(
      send({
        type: 'TRANSLATE_SELECTION',
        requestId: 'stale-selection',
        text: 'Selected text',
        translator: { kind: 'builtin', engine: 'microsoft-free' },
      }),
    ).resolves.toEqual({
      ok: false,
      error: { key: '翻译设置已改变，请重新开始翻译' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('closing a selection does not cancel concurrent page translation', async () => {
    await send({
      type: 'BEGIN_TRANSLATION_SESSION',
      translator: { kind: 'ai', profileId: activeProfile.id },
      sessionId: 'page',
      mode: 'segmented',
    });
    const page = send({
      type: 'TRANSLATE_BATCH',
      sessionId: 'page',
      batchId: 'batch',
      priority: 'visible',
      segments: [{ requestId: 'p:0', unitId: 'p', partIndex: 0, text: 'Page paragraph' }],
    });
    const selection = send({
      type: 'TRANSLATE_SELECTION',
      requestId: 'selected',
      text: 'Selected paragraph',
      translator: activeTranslator,
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await send({ type: 'CANCEL_SELECTION_TRANSLATION', requestId: 'selected' });
    expect(await selection).toMatchObject({ ok: false });
    const pageInit = fetchMock.mock.calls.find(([, init]) =>
      (init.body as string).includes('Page paragraph'),
    )![1];
    expect(pageInit.signal!.aborted).toBe(false);
    await send({ type: 'CANCEL_TRANSLATION_REQUESTS', sessionId: 'page' });
    await page;
  });

  it('snapshots thinking for requests and changes configuration identity for the next session', async () => {
    activeProfile.provider = 'mimo';
    activeProfile.apiUrl = 'https://api.xiaomimimo.com/v1';
    activeProfile.model = 'mimo-v2.5';
    activeProfile.thinkingEnabled = false;
    const begin = (sessionId: string) =>
      send({
        type: 'BEGIN_TRANSLATION_SESSION',
        mode: 'segmented',
        translator: { kind: 'ai', profileId: activeProfile.id },
        sessionId,
      });
    const first = await begin('thinking-off');
    activeProfile.thinkingEnabled = true;
    const second = await begin('thinking-on');
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(first).not.toEqual(second);
    fetchMock
      .mockResolvedValueOnce(completionResponse([{ id: 'a:0', text: '你好' }]))
      .mockResolvedValueOnce(completionResponse([{ id: 'a:0', text: '你好' }]));
    for (const sessionId of ['thinking-off', 'thinking-on']) {
      expect(
        (
          await send({
            type: 'TRANSLATE_BATCH',
            sessionId,
            batchId: 'batch',
            priority: 'visible',
            segments: [{ requestId: 'a:0', unitId: 'a', partIndex: 0, text: 'Hello' }],
          })
        ).ok,
      ).toBe(true);
    }
    expect(
      fetchMock.mock.calls.map((call) => {
        const init = call[1];
        const body = JSON.parse(init.body as string) as { thinking: { type: string } };
        return body.thinking.type;
      }),
    ).toEqual(['disabled', 'enabled']);
  });

  it.each([0, 3, 5])(
    'snapshots retry count %i at session start and enforces it for HTTP failures',
    async (count) => {
      translationRetryCount = count;
      await send({
        type: 'BEGIN_TRANSLATION_SESSION',
        mode: 'segmented',
        translator: { kind: 'ai', profileId: activeProfile.id },
        sessionId: 'retry-budget',
      });
      translationRetryCount = count === 0 ? 5 : 0;
      fetchMock.mockResolvedValue(new Response(null, { status: 500 }));
      vi.useFakeTimers();
      try {
        const work = send({
          type: 'TRANSLATE_BATCH',
          sessionId: 'retry-budget',
          batchId: 'batch',
          priority: 'visible',
          segments: [{ requestId: 'a:0', unitId: 'a', partIndex: 0, text: 'First paragraph' }],
        });
        await vi.advanceTimersByTimeAsync(5000);
        expect((await work).ok).toBe(false);
        expect(fetchMock).toHaveBeenCalledTimes(count + 1);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('registers context-specific translation menus once on worker evaluation without repeating it for startup events', async () => {
    for (const event of [chrome.runtime.onInstalled, chrome.runtime.onStartup]) {
      const listener = vi.mocked(event).addListener.mock.calls[0][0];
      (listener as () => void)();
    }
    await vi.waitFor(() => expect(chrome.contextMenus.create).toHaveBeenCalledTimes(2));
    expect(chrome.contextMenus.removeAll).toHaveBeenCalledOnce();
  });

  it('creates retry only for failures and removes it on recovery and tab/window changes', async () => {
    await vi.waitFor(() => expect(chrome.contextMenus.create).toHaveBeenCalledTimes(2));
    expect(chrome.contextMenus.remove).not.toHaveBeenCalled();
    activeTabs = [{ id: 18 }] as chrome.tabs.Tab[];
    for (const event of [
      undefined,
      chrome.tabs.onActivated,
      chrome.tabs.onUpdated,
      chrome.windows.onFocusChanged,
    ]) {
      menuStatus = { mode: 'segmented', failed: 2 };
      await send({ type: 'PAGE_RETRY_STATE_CHANGED' });
      expect(chrome.tabs.sendMessage).toHaveBeenLastCalledWith(
        18,
        { type: 'GET_PAGE_STATUS' },
        { frameId: 0 },
      );
      expect(chrome.contextMenus.create).toHaveBeenLastCalledWith(
        {
          id: 'just-translate-retry-failed',
          title: '重试全部失败',
          contexts: ['all'],
          documentUrlPatterns: ['http://*/*', 'https://*/*'],
        },
        expect.any(Function),
      );
      const count = vi.mocked(chrome.contextMenus.create).mock.calls.length;
      await send({ type: 'PAGE_RETRY_STATE_CHANGED' });
      expect(chrome.contextMenus.create).toHaveBeenCalledTimes(count);
      vi.mocked(chrome.contextMenus.remove).mockClear();
      menuStatus = { mode: 'segmented', failed: 0 };
      if (event) {
        const listener = vi.mocked(event).addListener.mock.calls[0][0];
        (listener as (...args: unknown[]) => void)(18, { status: 'loading' });
      } else {
        await send({ type: 'PAGE_RETRY_STATE_CHANGED' });
      }
      await vi.waitFor(() =>
        expect(chrome.contextMenus.remove).toHaveBeenCalledWith('just-translate-retry-failed'),
      );
    }
  });

  it('rejects settings mutations from a web content script', async () => {
    await expect(send({ type: 'UPDATE_UI_LANGUAGE', uiLanguage: 'ar' })).resolves.toEqual({
      ok: false,
      error: { key: '设置只能由扩展页面修改' },
    });
    await expect(
      send({ type: 'UPDATE_READING_PREFERENCES', patch: { targetLanguage: 'Japanese' } }),
    ).resolves.toEqual({ ok: false, error: { key: '设置只能由扩展页面修改' } });
  });

  it('executes a full-document session once without partial publication or access to paragraph cache commands', async () => {
    fetchMock.mockResolvedValue(
      completionResponse([
        { id: 'a', text: '第一段' },
        { id: 'b', text: '第二段' },
      ]),
    );
    await send({
      type: 'BEGIN_TRANSLATION_SESSION',
      mode: 'full-document',
      translator: { kind: 'ai', profileId: activeProfile.id },
      sessionId: 'full',
    });
    expect(Object.values(session)[0]).toMatchObject({ mode: 'full-document' });
    await expect(
      send({
        type: 'TRANSLATE_FULL_DOCUMENT',
        sessionId: 'full',
        units: [
          { id: 'a', text: 'First' },
          { id: 'b', text: 'Second' },
        ],
      }),
    ).resolves.toEqual({ ok: true, data: { a: '第一段', b: '第二段' } });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
    await expect(
      send({ type: 'RESOLVE_TRANSLATION_CANDIDATES', sessionId: 'full', candidates: [] }),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      send({ type: 'STORE_TRANSLATION_CACHE', sessionId: 'full', entries: [] }),
    ).resolves.toMatchObject({ ok: false });
  });

  it('cancels a full-document request on navigation and never retries it', async () => {
    await send({
      type: 'BEGIN_TRANSLATION_SESSION',
      mode: 'full-document',
      translator: { kind: 'ai', profileId: activeProfile.id },
      sessionId: 'full',
    });
    const work = send({
      type: 'TRANSLATE_FULL_DOCUMENT',
      sessionId: 'full',
      units: [{ id: 'a', text: 'First' }],
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    documentId = 'next-document';
    committed({ tabId: 18, frameId: 0, documentId });
    expect((await work).ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('cancels a full request while its document preflight is still waiting', async () => {
    await send({
      type: 'BEGIN_TRANSLATION_SESSION',
      mode: 'full-document',
      translator: { kind: 'ai', profileId: activeProfile.id },
      sessionId: 'full',
    });
    let release!: () => void;
    holdSessionRead = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const work = send({
      type: 'TRANSLATE_FULL_DOCUMENT',
      sessionId: 'full',
      units: [{ id: 'a', text: 'First' }],
    });
    await vi.waitFor(() => expect(release).toBeDefined());
    await send({ type: 'CANCEL_TRANSLATION_REQUESTS', sessionId: 'full' });
    release();
    expect((await work).ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses a 120 second first-output deadline for full-document mode without retrying', async () => {
    translationRetryCount = 5;
    vi.useFakeTimers();
    try {
      await send({
        type: 'BEGIN_TRANSLATION_SESSION',
        mode: 'full-document',
        translator: { kind: 'ai', profileId: activeProfile.id },
        sessionId: 'deadline',
      });
      let settled = false;
      const work = send({
        type: 'TRANSLATE_FULL_DOCUMENT',
        sessionId: 'deadline',
        units: [{ id: 'a', text: 'First' }],
      }).then((result) => {
        settled = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(119_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const result = await work;
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('Expected timeout');
      expect(renderMessage(result.error)).toContain('超时');
      expect(renderMessage(result.error)).toContain('首次');
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns an explicit error for an unsupported runtime command', async () => {
    const request = JSON.parse('{"type":"UNSUPPORTED_COMMAND"}') as RuntimeRequest;
    await expect(send(request)).resolves.toEqual({
      ok: false,
      error: { key: '扩展页面与后台消息不一致，请重新加载扩展并重新打开页面' },
    });
  });

  it('accepts a trusted options page even when Chrome supplies sender.tab', async () => {
    const result = await new Promise<Result<unknown>>((resolve) =>
      message(
        { type: 'SET_SITE_AUTO_TRANSLATE', hostname: 'example.com', enabled: false },
        {
          id: 'test-extension',
          url: 'chrome-extension://test-extension/src/options/index.html',
          tab: { id: 12 } as chrome.tabs.Tab,
        },
        resolve,
      ),
    );
    expect(result.ok).toBe(true);
  });

  it('publishes stream progress to the original document before the final response', async () => {
    let source!: ReadableStreamDefaultController<Uint8Array>;
    fetchMock.mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          start(value) {
            source = value;
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
    );
    await send({
      type: 'BEGIN_TRANSLATION_SESSION',
      mode: 'segmented',
      translator: { kind: 'ai', profileId: activeProfile.id },
      sessionId: 'stream',
    });
    const work = send({
      type: 'TRANSLATE_BATCH',
      sessionId: 'stream',
      batchId: 'batch',
      priority: 'visible',
      segments: [
        { requestId: 'a:0', unitId: 'a', partIndex: 0, text: 'First' },
        { requestId: 'b:0', unitId: 'b', partIndex: 0, text: 'Second' },
      ],
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    source.enqueue(
      new TextEncoder().encode(contentEvent('{"translations":[{"id":"a:0","text":"第一段"},')),
    );
    try {
      await vi.waitFor(() =>
        expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
          18,
          expect.objectContaining({
            sessionId: 'stream',
            batchId: 'batch',
            translations: { 'a:0': '第一段' },
          }),
          { documentId: 'old-document' },
        ),
      );
    } finally {
      source.enqueue(
        new TextEncoder().encode(contentEvent('{"id":"b:0","text":"第二段"}]}') + STREAM_END),
      );
      source.close();
    }
    expect(await work).toMatchObject({
      ok: true,
      data: { translations: { 'a:0': '第一段', 'b:0': '第二段' }, failures: {} },
    });
  });

  it('cancels old HTTP on same-origin navigation, keeps the new session and rejects late old-document messages', async () => {
    expect(
      (
        await send({
          type: 'BEGIN_TRANSLATION_SESSION',
          mode: 'segmented',
          translator: { kind: 'ai', profileId: activeProfile.id },
          sessionId: 'old',
        })
      ).ok,
    ).toBe(true);
    const work = send({
      type: 'TRANSLATE_BATCH',
      sessionId: 'old',
      batchId: 'batch',
      priority: 'visible',
      segments: [{ requestId: 'a', unitId: 'a', partIndex: 0, text: 'Original page text.' }],
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    documentId = 'new-document';
    await send({
      type: 'BEGIN_TRANSLATION_SESSION',
      mode: 'segmented',
      translator: { kind: 'ai', profileId: activeProfile.id },
      sessionId: 'new',
    });
    committed({ tabId: 18, frameId: 0, documentId });
    expect((await work).ok).toBe(false);
    await vi.waitFor(() => expect(Object.values(session)).toHaveLength(1));
    expect(Object.values(session)[0]).toMatchObject({ sessionId: 'new', documentId });
    expect(
      (
        await send(
          {
            type: 'BEGIN_TRANSLATION_SESSION',
            mode: 'segmented',
            translator: { kind: 'ai', profileId: activeProfile.id },
            sessionId: 'late',
          },
          'old-document',
        )
      ).ok,
    ).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a BEGIN which finishes reading settings after its page has navigated away', async () => {
    let release!: () => void;
    holdSettings = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    const work = send({
      type: 'BEGIN_TRANSLATION_SESSION',
      mode: 'segmented',
      translator: { kind: 'ai', profileId: activeProfile.id },
      sessionId: 'late',
    });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    documentId = 'new-document';
    committed({ tabId: 18, frameId: 0, documentId });
    release();
    expect((await work).ok).toBe(false);
    expect(Object.values(session)).toHaveLength(0);
  });
});
