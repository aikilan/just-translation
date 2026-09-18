import { TEST_PROFILE } from '../test-utils/provider';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Result, RuntimeRequest } from '../shared/messages';
import {
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
  type TranslationProfile,
} from '../shared/settings';
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
  let fetchMock: ReturnType<typeof vi.fn>;
  let holdSessionRead: (() => Promise<void>) | undefined;
  let holdSettings: (() => Promise<void>) | undefined;
  let translationRetryCount: number;
  let activeProfile: TranslationProfile;
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
      storage: {
        local: {
          setAccessLevel: vi.fn(),
          get: async () => {
            await holdSettings?.();
            return { [SETTINGS_STORAGE_KEY]: { ...settings, translationRetryCount } };
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

  it('executes selection requests through the real queue without creating page sessions', async () => {
    fetchMock.mockResolvedValue(completionResponse([{ id: 'selection', text: '选区译文' }]));
    const response = await send({
      type: 'TRANSLATE_SELECTION',
      requestId: 'selected',
      text: 'Only this paragraph',
    });
    expect(response).toEqual({
      ok: true,
      data: { text: '选区译文', targetLanguage: DEFAULT_SETTINGS.targetLanguage },
    });
    expect(Object.keys(session)).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string) as {
      messages: { content: string }[];
    };
    expect(JSON.parse(body.messages[1].content)).toEqual({
      segments: [{ id: 'selection', group: 'selection', part: 0, text: 'Only this paragraph' }],
    });
  });

  it('closing a selection does not cancel concurrent page translation', async () => {
    await send({
      type: 'BEGIN_TRANSLATION_SESSION',
      profileId: DEFAULT_SETTINGS.activeProfileId,
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
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await send({ type: 'CANCEL_SELECTION_TRANSLATION', requestId: 'selected' });
    expect(await selection).toMatchObject({ ok: false });
    const pageInit = fetchMock.mock.calls.find(([, init]) =>
      ((init as RequestInit).body as string).includes('Page paragraph'),
    )![1] as RequestInit;
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
        profileId: DEFAULT_SETTINGS.activeProfileId,
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
        const init = call[1] as RequestInit;
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
        profileId: DEFAULT_SETTINGS.activeProfileId,
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
    await expect(
      send({ type: 'UPDATE_READING_PREFERENCES', patch: { targetLanguage: 'Japanese' } }),
    ).resolves.toEqual({ ok: false, error: '设置只能由扩展页面修改' });
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
      profileId: DEFAULT_SETTINGS.activeProfileId,
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
      profileId: DEFAULT_SETTINGS.activeProfileId,
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
      profileId: DEFAULT_SETTINGS.activeProfileId,
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

  it('uses a 120 second HTTP deadline for full-document mode without retrying', async () => {
    translationRetryCount = 5;
    vi.useFakeTimers();
    try {
      await send({
        type: 'BEGIN_TRANSLATION_SESSION',
        mode: 'full-document',
        profileId: DEFAULT_SETTINGS.activeProfileId,
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
      expect(result.error).toContain('超时');
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns an explicit error for an unsupported runtime command', async () => {
    const request = JSON.parse('{"type":"UNSUPPORTED_COMMAND"}') as RuntimeRequest;
    await expect(send(request)).resolves.toEqual({
      ok: false,
      error: '扩展页面与后台消息不一致，请重新加载扩展并重新打开页面',
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
      profileId: DEFAULT_SETTINGS.activeProfileId,
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
          profileId: DEFAULT_SETTINGS.activeProfileId,
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
      profileId: DEFAULT_SETTINGS.activeProfileId,
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
            profileId: DEFAULT_SETTINGS.activeProfileId,
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
      profileId: DEFAULT_SETTINGS.activeProfileId,
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
