import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Result, RuntimeRequest } from '../shared/messages';
import { DEFAULT_SETTINGS, SETTINGS_STORAGE_KEY } from '../shared/settings';
import { contentEvent, STREAM_END } from '../test-utils/sse';

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
  let holdSettings: (() => Promise<void>) | undefined;
  const sender = (id: string): chrome.runtime.MessageSender => ({
    tab: { id: 18, url: 'https://news.ycombinator.com/news' } as chrome.tabs.Tab,
    documentId: id,
    frameId: 0,
  });
  const send = (request: RuntimeRequest, id = documentId) =>
    new Promise<Result<unknown>>((resolve) => message(request, sender(id), resolve));

  beforeEach(async () => {
    vi.resetModules();
    documentId = 'old-document';
    session = {};
    holdSettings = undefined;
    const settings = {
      ...DEFAULT_SETTINGS,
      profiles: DEFAULT_SETTINGS.profiles.map((profile) => ({ ...profile, model: 'test-model' })),
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
            return { [SETTINGS_STORAGE_KEY]: settings };
          },
          set: vi.fn(),
        },
        session: {
          setAccessLevel: vi.fn(),
          get: (key: string | null) =>
            Promise.resolve(structuredClone(key === null ? session : { [key]: session[key] })),
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
      contextMenus: { update: vi.fn().mockResolvedValue(undefined), onClicked: event() },
      commands: { onCommand: event() },
      tabs: { onRemoved: event(), sendMessage: vi.fn().mockResolvedValue(undefined) },
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

  it('rejects settings mutations from a web content script', async () => {
    await expect(
      send({ type: 'UPDATE_READING_PREFERENCES', patch: { targetLanguage: 'Japanese' } }),
    ).resolves.toEqual({ ok: false, error: '设置只能由扩展页面修改' });
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
