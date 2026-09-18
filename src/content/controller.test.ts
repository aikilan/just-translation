import { TEST_PROFILE } from '../test-utils/provider';
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Result, RuntimeRequest, TranslationBatchResult } from '../shared/messages';
import { TranslationController } from './controller';
import { translateBatch } from '../shared/translation-client';
import { completionResponse, contentEvent } from '../test-utils/sse';

const PUBLIC_SETTINGS = {
  configured: true,
  activeProfileId: 'profile-one',
  profiles: [{ id: 'profile-one', name: '默认配置', configured: true }],
  targetLanguage: 'Simplified Chinese',
  displayMode: 'bilingual' as const,
  translationConcurrency: 6,
  translateDynamicContent: true,
  excludedSites: [],
  autoTranslateSites: [],
};

describe('TranslationController', () => {
  it.each([true, false])(
    'keeps failed stream items pending during one automatic retry (success: %s)',
    async (retrySucceeds) => {
      // This protocol test requires both short sources in one batch; traversal budget has separate tests.
      vi.spyOn(performance, 'now').mockReturnValue(0);
      document.body.innerHTML = '<main><p>First source.</p><p>Second source.</p></main>';
      const instance = new TranslationController();
      const batches: Extract<RuntimeRequest, { type: 'TRANSLATE_BATCH' }>[] = [];
      const fetcher = vi.fn<typeof fetch>();
      let finishRetry!: (response: Response) => void;
      const sendMessage = vi.fn(async (request: RuntimeRequest): Promise<Result<unknown>> => {
        if (request.type === 'GET_PUBLIC_SETTINGS') return { ok: true, data: PUBLIC_SETTINGS };
        if (request.type !== 'TRANSLATE_BATCH') return controlResponse(request);
        batches.push(request);
        fetcher
          .mockResolvedValueOnce(
            completionResponse([
              { id: request.segments[0].requestId, text: '第一段译文' },
              { id: 'unknown-id', text: '错误映射' },
            ]),
          )
          .mockImplementationOnce(
            () =>
              new Promise((resolve) => {
                finishRetry = resolve;
              }),
          );
        return {
          ok: true,
          data: await translateBatch(
            { ...TEST_PROFILE, model: 'test', targetLanguage: 'Chinese' },
            request.segments,
            fetcher,
            undefined,
            {
              sleep: vi.fn().mockResolvedValue(undefined),
              onTranslations: (translations) =>
                instance.receiveBatchProgress({
                  type: 'TRANSLATION_BATCH_PROGRESS',
                  sessionId: request.sessionId,
                  batchId: request.batchId,
                  translations,
                }),
            },
          ),
        };
      });
      stubChrome(sendMessage);
      const work = instance.start();
      try {
        await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
        await vi.waitFor(() =>
          expect(instance.getStatus()).toMatchObject({
            phase: 'translating',
            translated: 1,
            failed: 0,
          }),
        );
        expect(document.querySelectorAll('[data-justranslate-state="pending"]')).toHaveLength(1);
        expect(document.querySelectorAll('[data-justranslate-state="error"]')).toHaveLength(0);
        const second = batches[0].segments[1];
        finishRetry(
          retrySucceeds
            ? completionResponse([{ id: second.requestId, text: '第二段译文' }])
            : new Response('provider failed again', { status: 500 }),
        );
        await work;
        expect(instance.getStatus()).toMatchObject(
          retrySucceeds
            ? { phase: 'complete', translated: 2, failed: 0 }
            : { phase: 'error', translated: 1, failed: 1 },
        );
        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(batches).toHaveLength(1);
      } finally {
        finishRetry?.(completionResponse([]));
        instance.restore();
        await work;
      }
    },
  );

  it('orders streamed paragraphs, caches only complete text and retries only the failed node', async () => {
    document.body.innerHTML =
      '<main><p>First source paragraph.</p><p>Second source paragraph.</p><p>Third source paragraph.</p></main>';
    const original = document.body.innerHTML;
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new Response(
      new ReadableStream<Uint8Array>({
        start(value) {
          source = value;
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
    const instance = new TranslationController();
    const cacheWrites = vi.fn<(request: CacheWriteRequest) => void>();
    const batches: Extract<RuntimeRequest, { type: 'TRANSLATE_BATCH' }>[] = [];
    const sendMessage = vi.fn(async (request: RuntimeRequest): Promise<Result<unknown>> => {
      if (request.type === 'GET_PUBLIC_SETTINGS') return { ok: true, data: PUBLIC_SETTINGS };
      if (request.type === 'TRANSLATE_BATCH') {
        batches.push(request);
        const response =
          batches.length === 1
            ? stream
            : completionResponse(
                request.segments.map(({ requestId }) => ({
                  id: requestId,
                  text: '第三段重试成功',
                })),
              );
        const result = await translateBatch(
          { ...TEST_PROFILE, model: 'test', targetLanguage: 'Chinese' },
          request.segments,
          vi.fn<typeof fetch>().mockResolvedValue(response),
          undefined,
          {
            maxRetries: 0,
            onTranslations: (translations) =>
              instance.receiveBatchProgress({
                type: 'TRANSLATION_BATCH_PROGRESS',
                sessionId: request.sessionId,
                batchId: request.batchId,
                translations,
              }),
          },
        );
        return { ok: true, data: result };
      }
      return controlResponse(request);
    });
    stubChrome(sendMessage, undefined, cacheWrites);
    const work = instance.start();
    await vi.waitFor(() => expect(batches).toHaveLength(1));
    const [a, b, c] = batches[0].segments;
    const push = (text: string) => source.enqueue(new TextEncoder().encode(contentEvent(text)));
    push(`{"translations":[${JSON.stringify({ id: b.requestId, text: '第二段' })},`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(document.querySelectorAll('[data-justranslate-state="translated"]')).toHaveLength(0);
    push(
      `${JSON.stringify({ id: a.requestId, text: '第一段' })},{"id":"${c.requestId}","text":"第三段尚未完整`,
    );
    try {
      await vi.waitFor(() =>
        expect(document.querySelectorAll('[data-justranslate-state="translated"]')).toHaveLength(2),
      );
      expect(
        [...document.querySelectorAll('[data-justranslate-state="translated"]')].map(
          (node) => node.textContent,
        ),
      ).toEqual(['第一段', '第二段']);
      expect(document.querySelectorAll('[data-justranslate-state="pending"]')).toHaveLength(1);
      expect(
        cacheWrites.mock.calls
          .flatMap(([request]) => request.entries)
          .map((entry) => entry.translatedText),
      ).toEqual(['第二段', '第一段']);
    } finally {
      source.close();
    }
    await work;
    expect(instance.getStatus()).toMatchObject({
      phase: 'error',
      total: 3,
      translated: 2,
      failed: 1,
    });
    await instance.retry(document.querySelectorAll('p')[2]);
    expect(batches).toHaveLength(2);
    expect(batches[1].segments.map(({ text }) => text)).toEqual(['Third source paragraph.']);
    expect(instance.getStatus()).toMatchObject({ phase: 'complete', translated: 3, failed: 0 });
    instance.restore();
    expect(document.body.innerHTML).toBe(original);
  });
  it('dispatches discovered paragraphs before measuring the final page candidates', async () => {
    document.body.innerHTML = `<main>${Array.from({ length: 60 }, (_, i) => `<p id="paragraph-${i}">Readable source paragraph ${i}.</p>`).join('')}</main>`;
    let tailMeasured = false;
    let firstRequestTailMeasured: boolean | undefined;
    vi.spyOn(document.querySelector('#paragraph-59')!, 'getBoundingClientRect').mockImplementation(
      () => {
        tailMeasured = true;
        return { top: 0, bottom: 10 } as DOMRect;
      },
    );
    const sendMessage = vi.fn((request: RuntimeRequest): Promise<Result<unknown>> => {
      if (request.type === 'GET_PUBLIC_SETTINGS')
        return Promise.resolve({ ok: true, data: PUBLIC_SETTINGS });
      if (request.type === 'TRANSLATE_BATCH') {
        firstRequestTailMeasured ??= tailMeasured;
        return Promise.resolve({
          ok: true,
          data: successfulBatchData(request.segments, (segment) => `译文 ${segment.text}`),
        });
      }
      return Promise.resolve(controlResponse(request));
    });
    stubChrome(sendMessage);
    const controller = new TranslationController();
    await controller.start();
    expect(firstRequestTailMeasured).toBe(false);
    expect(controller.getStatus()).toMatchObject({ translated: 60, failed: 0, total: 60 });
    expect(controller.getDiagnostics().stages.discovery?.count).toBeGreaterThan(1);
    controller.restore();
  });

  it('commits validated partial results before the final batch response and ignores foreign or stopped progress', async () => {
    // Force separate discovery slices; progress must address the actual batch, independent of CPU load.
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => (clock += 10));
    document.body.innerHTML =
      '<main><p>First successful paragraph.</p><p>Second missing paragraph.</p></main>';
    const batches: Array<{
      request: Extract<RuntimeRequest, { type: 'TRANSLATE_BATCH' }>;
      finish: (result: Result<TranslationBatchResult>) => void;
    }> = [];
    const sendMessage = vi.fn((request: RuntimeRequest): Promise<Result<unknown>> => {
      if (request.type === 'GET_PUBLIC_SETTINGS')
        return Promise.resolve({ ok: true, data: PUBLIC_SETTINGS });
      if (request.type === 'TRANSLATE_BATCH')
        return new Promise((resolve) => {
          batches.push({ request, finish: resolve });
        });
      return Promise.resolve(controlResponse(request));
    });
    stubChrome(sendMessage);
    const controller = new TranslationController();
    const work = controller.start();
    const settle = () => {
      for (const { request, finish } of batches)
        finish({ ok: true, data: successfulBatchData(request.segments, () => '最终结果') });
    };
    try {
      await vi.waitFor(() =>
        expect(batches.reduce((count, batch) => count + batch.request.segments.length, 0)).toBe(2),
      );
      const batch = batches.find(({ request }) =>
        request.segments.some((segment) => segment.text === 'First successful paragraph.'),
      )!.request;
      const segment = batch.segments.find(
        (segment) => segment.text === 'First successful paragraph.',
      )!;
      const progress = {
        type: 'TRANSLATION_BATCH_PROGRESS' as const,
        sessionId: batch.sessionId,
        batchId: batch.batchId,
        translations: { [segment.requestId]: '首段已经成功' },
      };
      controller.receiveBatchProgress({ ...progress, sessionId: 'foreign-session' });
      expect(document.querySelector('[data-justranslate-state="translated"]')).toBeNull();
      controller.receiveBatchProgress(progress);
      await vi.waitFor(() =>
        expect(document.querySelector('[data-justranslate-state="translated"]')?.textContent).toBe(
          '首段已经成功',
        ),
      );
      expect(document.querySelectorAll('[data-justranslate-state="pending"]')).toHaveLength(1);
      controller.stop();
      for (const { request } of batches)
        controller.receiveBatchProgress({
          type: 'TRANSLATION_BATCH_PROGRESS',
          sessionId: request.sessionId,
          batchId: request.batchId,
          translations: Object.fromEntries(
            request.segments.map((segment) => [segment.requestId, '迟到结果']),
          ),
        });
      settle();
      await work;
      expect(document.querySelectorAll('[data-justranslate-state="translated"]')).toHaveLength(1);
      expect(document.body.textContent).not.toContain('迟到结果');
    } finally {
      controller.stop();
      settle();
      await work;
      controller.restore();
    }
  });

  beforeEach(() => {
    document.body.innerHTML = '';
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue({ length: 1 } as DOMRectList);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('does not show a spinner before the background session is ready and exposes retry on failure', async () => {
    document.body.innerHTML = '<main><p>Session preflight must be visible.</p></main>';
    let resolveSession: ((result: Result<undefined>) => void) | undefined;
    const sendMessage = vi.fn((request: RuntimeRequest): Promise<Result<unknown>> => {
      if (request.type === 'GET_PUBLIC_SETTINGS') {
        return Promise.resolve({ ok: true, data: PUBLIC_SETTINGS });
      }
      if (request.type === 'BEGIN_TRANSLATION_SESSION') {
        return new Promise((resolve) => {
          resolveSession = resolve;
        });
      }
      return Promise.resolve(controlResponse(request));
    });
    stubChrome(sendMessage);
    const controller = new TranslationController();

    const translation = controller.start();
    await vi.waitFor(() => expect(resolveSession).toBeTypeOf('function'));
    const pendingBeforeSessionFailure = document.querySelectorAll(
      '[data-justranslate-state="pending"]',
    ).length;
    resolveSession!({ ok: false, error: '翻译会话创建失败' });
    await translation;

    expect(pendingBeforeSessionFailure).toBe(0);
    expect(document.querySelector('[data-justranslate-state="error"]')?.textContent).toBe(
      '翻译失败 · 重试',
    );
    expect(controller.getStatus()).toMatchObject({
      phase: 'error',
      failed: 1,
      total: 1,
      error: '翻译会话创建失败',
    });
    controller.restore();
  });

  it('turns invalid configuration preflight into visible node retry controls', async () => {
    document.body.innerHTML = '<main><p>Invalid configuration must be visible.</p></main>';
    const sendMessage = vi.fn((request: RuntimeRequest): Promise<Result<unknown>> => {
      if (request.type === 'GET_PUBLIC_SETTINGS') {
        return Promise.resolve({
          ok: true,
          data: { ...PUBLIC_SETTINGS, configured: false },
        });
      }
      return Promise.resolve(controlResponse(request));
    });
    stubChrome(sendMessage);
    const controller = new TranslationController();

    await controller.start();

    expect(document.querySelector('[data-justranslate-state="error"]')?.textContent).toBe(
      '翻译失败 · 重试',
    );
    expect(controller.getStatus()).toMatchObject({
      phase: 'error',
      failed: 1,
      total: 1,
      error: '请先在插件设置中补全当前翻译配置（包括翻译 Prompt）',
    });
    controller.restore();
  });

  it('does not show loading while preflight hangs and exposes retry after timeout', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<main><p>Silent background must time out.</p></main>';
    const sendMessage = vi.fn((request: RuntimeRequest): Promise<Result<unknown>> => {
      if (request.type === 'GET_PUBLIC_SETTINGS') {
        return new Promise(() => undefined);
      }
      return Promise.resolve(controlResponse(request));
    });
    stubChrome(sendMessage);
    const controller = new TranslationController();

    const translation = controller.start();
    expect(document.querySelector('[data-justranslate-state="pending"]')).toBeNull();
    await vi.advanceTimersByTimeAsync(5_000);
    await translation;

    expect(document.querySelector('[data-justranslate-state="error"]')?.textContent).toBe(
      '翻译失败 · 重试',
    );
    expect(controller.getStatus()).toMatchObject({
      phase: 'error',
      failed: 1,
      total: 1,
      error: '读取翻译配置超时，请确认插件后台运行正常',
    });
    controller.restore();
  });

  it('renders a pending state for every uncached node before the first request completes', async () => {
    document.body.innerHTML =
      '<main><p>First pending source.</p><p>Second pending source.</p></main>';
    let resolveBatch: ((result: Result<TranslationBatchResult>) => void) | undefined;
    let requestedSegments: Extract<RuntimeRequest, { type: 'TRANSLATE_BATCH' }>['segments'] = [];
    const sendMessage = vi.fn((request: RuntimeRequest): Promise<Result<unknown>> => {
      if (request.type === 'GET_PUBLIC_SETTINGS') {
        return Promise.resolve({ ok: true, data: PUBLIC_SETTINGS });
      }
      if (request.type === 'TRANSLATE_BATCH') {
        requestedSegments = request.segments;
        return new Promise((resolve) => {
          resolveBatch = resolve;
        });
      }
      return Promise.resolve(controlResponse(request));
    });
    stubChrome(sendMessage);
    const controller = new TranslationController();

    const translation = controller.start();
    await vi.waitFor(() => expect(resolveBatch).toBeTypeOf('function'));

    expect(document.querySelectorAll('[data-justranslate-state="pending"]')).toHaveLength(2);
    expect(controller.getStatus()).toMatchObject({
      phase: 'translating',
      translated: 0,
      failed: 0,
      total: 2,
    });

    resolveBatch!({
      ok: true,
      data: successfulBatchData(requestedSegments, (segment) => `译文 ${segment.unitId}`),
    });
    await translation;

    expect(document.querySelectorAll('[data-justranslate-state="translated"]')).toHaveLength(2);
    expect(document.querySelector('[data-justranslate-state="pending"]')).toBeNull();
    controller.restore();
  });

  it('waits for a cache miss before rendering the node spinner', async () => {
    document.body.innerHTML = '<main><p>Candidate lookup must be visible.</p></main>';
    let resolveCandidates:
      | ((value: {
          skippedIds: string[];
          cachedTranslations: Record<string, string>;
          missIds: string[];
        }) => void)
      | undefined;
    const sendMessage = vi.fn((request: RuntimeRequest): Promise<Result<unknown>> => {
      if (request.type === 'GET_PUBLIC_SETTINGS') {
        return Promise.resolve({ ok: true, data: PUBLIC_SETTINGS });
      }
      if (request.type === 'TRANSLATE_BATCH') {
        return Promise.resolve({
          ok: true,
          data: Object.fromEntries(
            request.segments.map((segment) => [segment.requestId, '候选解析后的译文']),
          ),
        });
      }
      return Promise.resolve(controlResponse(request));
    });
    stubChrome(
      sendMessage,
      () =>
        new Promise((resolve) => {
          resolveCandidates = resolve;
        }),
    );
    const controller = new TranslationController();

    const translation = controller.start();
    await vi.waitFor(() => expect(resolveCandidates).toBeTypeOf('function'));

    expect(document.querySelector('[data-justranslate-state="pending"]')).toBeNull();
    resolveCandidates!({
      skippedIds: [],
      cachedTranslations: {},
      missIds: ['candidate-0'],
    });
    await translation;
    expect(document.querySelector('[data-justranslate-state="translated"]')?.textContent).toBe(
      '候选解析后的译文',
    );
    controller.restore();
  });

  it('turns early candidate failures into visible node retry controls', async () => {
    document.body.innerHTML = '<main><p>Early provider configuration failure.</p></main>';
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: (request: RuntimeRequest): Promise<Result<unknown>> => {
          if (request.type === 'GET_PUBLIC_SETTINGS') {
            return Promise.resolve({ ok: true, data: PUBLIC_SETTINGS });
          }
          if (request.type === 'RESOLVE_TRANSLATION_CANDIDATES') {
            return Promise.resolve({ ok: false, error: '候选解析失败' });
          }
          return Promise.resolve(controlResponse(request));
        },
      },
    });
    const controller = new TranslationController();

    await controller.start();

    expect(controller.getStatus()).toMatchObject({ phase: 'error', failed: 1, total: 1 });
    expect(document.querySelector('[data-justranslate-state="error"]')?.textContent).toBe(
      '翻译失败 · 重试',
    );
    controller.restore();
  });

  it('binds candidate lookup, AI requests, and cache writes to one background session', async () => {
    document.body.innerHTML = '<main><p>Profile-scoped translation source.</p></main>';
    const observedRequests: Array<{ type: string; sessionId: string; profileId?: string }> = [];
    const sendMessage = vi.fn((request: RuntimeRequest): Promise<Result<unknown>> => {
      if (request.type === 'GET_PUBLIC_SETTINGS') {
        return Promise.resolve({ ok: true, data: PUBLIC_SETTINGS });
      }
      if (request.type === 'BEGIN_TRANSLATION_SESSION') {
        observedRequests.push({
          type: request.type,
          sessionId: request.sessionId,
          profileId: request.profileId,
        });
      }
      if (request.type === 'TRANSLATE_BATCH') {
        observedRequests.push({ type: request.type, sessionId: request.sessionId });
        return Promise.resolve({
          ok: true,
          data: Object.fromEntries(
            request.segments.map((segment) => [segment.requestId, '配置固定译文']),
          ),
        });
      }
      return Promise.resolve(controlResponse(request));
    });
    stubChrome(
      sendMessage,
      (request) => {
        observedRequests.push({ type: request.type, sessionId: request.sessionId });
        return Promise.resolve({
          skippedIds: [],
          cachedTranslations: {},
          missIds: request.candidates.map((candidate) => candidate.id),
        });
      },
      (request) => observedRequests.push({ type: request.type, sessionId: request.sessionId }),
    );
    const controller = new TranslationController();

    await controller.start();

    const endRequest = sendMessage.mock.calls
      .map(([request]) => request)
      .find((request) => request.type === 'END_TRANSLATION_SESSION');
    if (endRequest?.type === 'END_TRANSLATION_SESSION') {
      observedRequests.push({ type: endRequest.type, sessionId: endRequest.sessionId });
    }
    expect(observedRequests.map((request) => request.type)).toEqual([
      'BEGIN_TRANSLATION_SESSION',
      'RESOLVE_TRANSLATION_CANDIDATES',
      'TRANSLATE_BATCH',
      'STORE_TRANSLATION_CACHE',
      'END_TRANSLATION_SESSION',
    ]);
    expect(new Set(observedRequests.map((request) => request.sessionId)).size).toBe(1);
    expect(observedRequests[0]?.profileId).toBe('profile-one');
    controller.restore();
  });

  it('starts foreground AI work before background candidate resolution finishes', async () => {
    const viewportHeight = window.innerHeight || 768;
    document.body.innerHTML = `
      <main>
        <p id="visible" data-top="0">Visible foreground source.</p>
        <p id="ahead" data-top="${viewportHeight + 10}">Read-ahead source.</p>
        <p id="background" data-top="${viewportHeight * 3}">Background source.</p>
      </main>
    `;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      const top = Number(this.dataset.top ?? 0);
      return {
        x: 0,
        y: top,
        top,
        bottom: top + 20,
        left: 0,
        right: 100,
        width: 100,
        height: 20,
        toJSON: () => ({}),
      };
    });
    let resolveBackgroundCandidates:
      | ((value: {
          skippedIds: string[];
          cachedTranslations: Record<string, string>;
          missIds: string[];
        }) => void)
      | undefined;
    let backgroundCandidateId: string | undefined;
    const translatedSourceTexts: string[] = [];
    const sendMessage = vi.fn((request: RuntimeRequest): Promise<Result<unknown>> => {
      if (request.type === 'GET_PUBLIC_SETTINGS') {
        return Promise.resolve({ ok: true, data: PUBLIC_SETTINGS });
      }
      if (request.type === 'TRANSLATE_BATCH') {
        translatedSourceTexts.push(...request.segments.map((segment) => segment.text));
        return Promise.resolve({
          ok: true,
          data: Object.fromEntries(
            request.segments.map((segment) => [segment.requestId, `译文 ${segment.text}`]),
          ),
        });
      }
      return Promise.resolve(controlResponse(request));
    });
    stubChrome(sendMessage, (request) => {
      if (request.candidates.some((candidate) => candidate.text.includes('Background'))) {
        backgroundCandidateId = request.candidates[0]?.id;
        return new Promise((resolve) => {
          resolveBackgroundCandidates = resolve;
        });
      }
      return Promise.resolve({
        skippedIds: [],
        cachedTranslations: {},
        missIds: request.candidates.map((candidate) => candidate.id),
      });
    });
    const controller = new TranslationController();

    const translation = controller.start();
    await vi.waitFor(() => expect(resolveBackgroundCandidates).toBeTypeOf('function'));

    expect(translatedSourceTexts).toEqual(
      expect.arrayContaining(['Visible foreground source.', 'Read-ahead source.']),
    );
    expect(translatedSourceTexts).not.toContain('Background source.');
    expect(
      document.querySelector('#visible [data-justranslate-state="translated"]'),
    ).not.toBeNull();
    expect(document.querySelector('#background [data-justranslate-translation]')).toBeNull();

    resolveBackgroundCandidates!({
      skippedIds: [],
      cachedTranslations: {},
      missIds: [backgroundCandidateId!],
    });
    await translation;

    expect(translatedSourceTexts).toContain('Background source.');
    controller.restore();
  });

  it('dispatches the first visible chunk without waiting for later candidate lookups', async () => {
    document.body.innerHTML = `<main>${Array.from(
      { length: 30 },
      (_, index) => `<p>Visible article number ${index} needs translation.</p>`,
    ).join('')}</main>`;
    const lookups: CandidateRequest[] = [];
    let releaseLater: (() => void) | undefined;
    const sendMessage = vi.fn((request: RuntimeRequest): Promise<Result<unknown>> => {
      if (request.type === 'GET_PUBLIC_SETTINGS')
        return Promise.resolve({ ok: true, data: PUBLIC_SETTINGS });
      if (request.type === 'TRANSLATE_BATCH')
        return Promise.resolve({
          ok: true,
          data: successfulBatchData(request.segments, () => '可见译文'),
        });
      return Promise.resolve(controlResponse(request));
    });
    stubChrome(sendMessage, (request) => {
      lookups.push(request);
      const result = {
        skippedIds: [],
        cachedTranslations: {},
        missIds: request.candidates.map(({ id }) => id),
      };
      if (lookups.length !== 2) return Promise.resolve(result);
      return new Promise((resolve) => {
        releaseLater = () => resolve(result);
      });
    });
    const controller = new TranslationController();
    const translation = controller.start();
    await vi.waitFor(() => expect(lookups.length).toBeGreaterThan(1));
    expect(lookups[0].candidates.length).toBeLessThanOrEqual(4);
    await vi.waitFor(() =>
      expect(controller.getStatus().translated).toBe(lookups[0].candidates.length),
    );
    // Later resolved slices may now be in flight; only the unresolved slice must stay unmodified.
    for (const candidate of lookups[1].candidates) {
      const source = [...document.querySelectorAll('p')].find(
        (node) => node.textContent === candidate.text,
      );
      expect(source).toBeDefined();
      expect(source!.querySelector('[data-justranslate-state="pending"]')).toBeNull();
    }
    releaseLater!();
    await translation;
    expect(controller.getStatus()).toMatchObject({ translated: 30, total: 30 });
    controller.restore();
  });

  it('does not hold visible content behind read-ahead language and cache resolution', async () => {
    document.body.innerHTML =
      '<main><p id="visible">Visible article.</p><p id="ahead">Next screen article.</p></main>';
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      const top = this.id === 'ahead' ? window.innerHeight + 20 : 0;
      return { top, bottom: top + 20, left: 0, right: 100 } as DOMRect;
    });
    let releaseAhead: (() => void) | undefined;
    const sendMessage = vi.fn((request: RuntimeRequest): Promise<Result<unknown>> => {
      if (request.type === 'GET_PUBLIC_SETTINGS')
        return Promise.resolve({ ok: true, data: PUBLIC_SETTINGS });
      if (request.type === 'TRANSLATE_BATCH')
        return Promise.resolve({
          ok: true,
          data: successfulBatchData(request.segments, () => '首屏译文'),
        });
      return Promise.resolve(controlResponse(request));
    });
    stubChrome(sendMessage, (request) => {
      const result = {
        skippedIds: [],
        cachedTranslations: {},
        missIds: request.candidates.map(({ id }) => id),
      };
      if (request.candidates.some(({ text }) => text === 'Next screen article.')) {
        return new Promise((resolve) => {
          releaseAhead = () => resolve(result);
        });
      }
      return Promise.resolve(result);
    });
    const controller = new TranslationController();
    const translation = controller.start();
    await vi.waitFor(() => expect(releaseAhead).toBeTypeOf('function'));
    await vi.waitFor(() => expect(controller.getStatus().translated).toBe(1));
    expect(document.querySelector('#ahead [data-justranslate-translation]')).toBeNull();
    releaseAhead!();
    await translation;
    controller.restore();
  });

  it('isolates a failed preflight chunk and still translates later chunks', async () => {
    document.body.innerHTML = `<main>${Array.from(
      { length: 30 },
      (_, index) => `<p>Article number ${index} requires translation.</p>`,
    ).join('')}</main>`;
    let lookups = 0;
    let failedCount = 0;
    stubChrome(
      (request) => {
        if (request.type === 'GET_PUBLIC_SETTINGS')
          return Promise.resolve({ ok: true, data: PUBLIC_SETTINGS });
        if (request.type === 'TRANSLATE_BATCH')
          return Promise.resolve({
            ok: true,
            data: successfulBatchData(request.segments, () => '后续译文'),
          });
        return Promise.resolve(controlResponse(request));
      },
      (request) => {
        lookups += 1;
        if (lookups === 1) {
          failedCount = request.candidates.length;
          return Promise.reject(new Error('first chunk failed'));
        }
        return Promise.resolve({
          skippedIds: [],
          cachedTranslations: {},
          missIds: request.candidates.map(({ id }) => id),
        });
      },
    );
    const controller = new TranslationController();
    await controller.start();
    expect(controller.getStatus()).toMatchObject({
      phase: 'error',
      translated: 30 - failedCount,
      failed: failedCount,
      total: 30,
    });
    expect(document.querySelectorAll('[data-justranslate-state="error"]')).toHaveLength(
      failedCount,
    );
    expect(document.querySelectorAll('[data-justranslate-state="pending"]')).toHaveLength(0);
    controller.restore();
  });

  it('settles a hung candidate chunk and ignores its late response after stop', async () => {
    vi.useFakeTimers();
    document.body.innerHTML =
      '<main><p>A candidate waiting for a lost background reply.</p></main>';
    let resolveLookup:
      | ((value: {
          skippedIds: string[];
          cachedTranslations: Record<string, string>;
          missIds: string[];
        }) => void)
      | undefined;
    const sendMessage = vi.fn((request: RuntimeRequest): Promise<Result<unknown>> =>
      Promise.resolve({
        ok: true,
        data:
          request.type === 'GET_PUBLIC_SETTINGS' ? PUBLIC_SETTINGS : controlResponse(request).data,
      }),
    );
    stubChrome(
      sendMessage,
      () =>
        new Promise((resolve) => {
          resolveLookup = resolve;
        }),
    );
    const controller = new TranslationController();
    const translation = controller.start();
    await vi.advanceTimersByTimeAsync(5_000);
    await translation;
    expect(controller.getStatus()).toMatchObject({ phase: 'error', failed: 1 });
    controller.stop();
    resolveLookup!({ skippedIds: [], cachedTranslations: {}, missIds: ['candidate-0'] });
    await vi.advanceTimersByTimeAsync(0);
    expect(sendMessage.mock.calls.some(([request]) => request.type === 'TRANSLATE_BATCH')).toBe(
      false,
    );
    controller.restore();
  });

  it('updates display mode locally instead of rescanning all translated nodes for every batch', async () => {
    document.body.innerHTML = `<main>${Array.from(
      { length: 12 },
      (_, index) => `<p>${longText(`Article ${index}.`)}</p>`,
    ).join('')}</main>`;
    const queryAll = vi.spyOn(document, 'querySelectorAll');
    stubChrome((request) => {
      if (request.type === 'GET_PUBLIC_SETTINGS')
        return Promise.resolve({
          ok: true,
          data: { ...PUBLIC_SETTINGS, displayMode: 'translation' },
        });
      if (request.type === 'TRANSLATE_BATCH')
        return Promise.resolve({
          ok: true,
          data: successfulBatchData(request.segments, () => '译文'),
        });
      return Promise.resolve(controlResponse(request));
    });
    const controller = new TranslationController();
    await controller.start();
    expect(
      queryAll.mock.calls.filter(([selector]) => selector === '[data-justranslate-source]'),
    ).toHaveLength(1);
    expect(
      [...document.querySelectorAll<HTMLElement>('[data-justranslate-source-content]')].every(
        (source) => source.hidden,
      ),
    ).toBe(true);
    controller.restore();
  });

  it('renders completed batches only after every earlier DOM node has settled', async () => {
    document.body.innerHTML = `
      <main>
        <p id="first">${longText('First ordered source.')}</p>
        <p id="second">${longText('Second ordered source.')}</p>
        <p id="third">${longText('Third ordered source.')}</p>
      </main>
    `;
    const pendingBatches: Array<{
      request: Extract<RuntimeRequest, { type: 'TRANSLATE_BATCH' }>;
      resolve: (result: Result<TranslationBatchResult>) => void;
    }> = [];
    const sendMessage = vi.fn((request: RuntimeRequest): Promise<Result<unknown>> => {
      if (request.type === 'GET_PUBLIC_SETTINGS') {
        return Promise.resolve({ ok: true, data: PUBLIC_SETTINGS });
      }
      if (request.type === 'TRANSLATE_BATCH') {
        return new Promise((resolve) => pendingBatches.push({ request, resolve }));
      }
      return Promise.resolve(controlResponse(request));
    });
    stubChrome(sendMessage);
    const controller = new TranslationController();

    const translation = controller.start();
    await vi.waitFor(() => expect(pendingBatches).toHaveLength(3));

    resolveBatch(pendingBatches[2], '第三段译文');
    resolveBatch(pendingBatches[1], '第二段译文');
    await Promise.resolve();
    await Promise.resolve();

    expect(controller.getStatus().translated).toBe(0);
    expect(document.querySelectorAll('[data-justranslate-state="pending"]')).toHaveLength(3);
    expect(document.body.textContent).not.toContain('第二段译文');
    expect(document.body.textContent).not.toContain('第三段译文');

    resolveBatch(pendingBatches[0], '第一段译文');
    await translation;

    expect(
      ['first', 'second', 'third'].map(
        (id) =>
          document.querySelector(`#${id} [data-justranslate-state="translated"]`)?.textContent,
      ),
    ).toEqual(['第一段译文', '第二段译文', '第三段译文']);
    controller.restore();
  });

  it('holds a failure and later success until the earlier DOM node settles', async () => {
    document.body.innerHTML = `
      <main>
        <p id="first">${longText('First source still pending.')}</p>
        <p id="failed">${longText('Second source will fail.')}</p>
        <p id="third">${longText('Third source already finished.')}</p>
      </main>
    `;
    const pendingBatches: Array<{
      request: Extract<RuntimeRequest, { type: 'TRANSLATE_BATCH' }>;
      resolve: (result: Result<TranslationBatchResult>) => void;
    }> = [];
    const sendMessage = vi.fn((request: RuntimeRequest): Promise<Result<unknown>> => {
      if (request.type === 'GET_PUBLIC_SETTINGS') {
        return Promise.resolve({ ok: true, data: PUBLIC_SETTINGS });
      }
      if (request.type === 'TRANSLATE_BATCH') {
        return new Promise((resolve) => pendingBatches.push({ request, resolve }));
      }
      return Promise.resolve(controlResponse(request));
    });
    stubChrome(sendMessage);
    const controller = new TranslationController();

    const translation = controller.start();
    await vi.waitFor(() => expect(pendingBatches).toHaveLength(3));
    resolveBatch(pendingBatches[2], '第三段完成');
    pendingBatches[1].resolve({ ok: false, error: '第二段失败' });
    await Promise.resolve();
    await Promise.resolve();

    expect(controller.getStatus()).toMatchObject({ failed: 0, translated: 0 });
    expect(document.querySelector('#failed [data-justranslate-state="error"]')).toBeNull();
    expect(document.body.textContent).not.toContain('第三段完成');

    resolveBatch(pendingBatches[0], '第一段完成');
    await translation;

    expect(document.querySelector('#first [data-justranslate-translation]')?.textContent).toBe(
      '第一段完成',
    );
    expect(document.querySelector('#failed [data-justranslate-state="error"]')).not.toBeNull();
    expect(document.querySelector('#third [data-justranslate-translation]')?.textContent).toBe(
      '第三段完成',
    );
    expect(controller.getStatus()).toMatchObject({ translated: 2, failed: 1, total: 3 });
    controller.restore();
  });

  it.each([false, true])(
    'renders cache hits and duplicates before an earlier network result (dynamic=%s)',
    async (dynamic) => {
      document.body.innerHTML = `
        <main>
          <p id="network">Earlier network source.</p>
          <p id="cache">Later cached source.</p>
          ${dynamic ? '' : '<p id="duplicate">Later cached source.</p>'}
        </main>
      `;
      let pendingBatch:
        | {
            request: Extract<RuntimeRequest, { type: 'TRANSLATE_BATCH' }>;
            resolve: (result: Result<TranslationBatchResult>) => void;
          }
        | undefined;
      const sendMessage = vi.fn((request: RuntimeRequest): Promise<Result<unknown>> => {
        if (request.type === 'GET_PUBLIC_SETTINGS') {
          return Promise.resolve({ ok: true, data: PUBLIC_SETTINGS });
        }
        if (request.type === 'TRANSLATE_BATCH') {
          return new Promise((resolve) => {
            pendingBatch = { request, resolve };
          });
        }
        return Promise.resolve(controlResponse(request));
      });
      const lookup = vi.fn((request: CandidateRequest) =>
        Promise.resolve({
          skippedIds: [],
          cachedTranslations: Object.fromEntries(
            request.candidates
              .filter((candidate) => candidate.text === 'Later cached source.')
              .map((candidate) => [candidate.id, '缓存译文']),
          ),
          missIds: request.candidates
            .filter((candidate) => candidate.text !== 'Later cached source.')
            .map((candidate) => candidate.id),
        }),
      );
      stubChrome(sendMessage, lookup);
      const controller = new TranslationController();
      const translation = controller.start();
      try {
        await vi.waitFor(() => expect(pendingBatch).toBeDefined());
        // Keep the network promise unresolved: a cache hit must paint independently.
        await vi.waitFor(() =>
          expect(document.querySelector('#cache [data-justranslate-translation]')?.textContent)
            .toBe('缓存译文'),
        );
        const lookupCount = lookup.mock.calls.length;
        if (dynamic) {
          document.querySelector('main')!.insertAdjacentHTML(
            'beforeend', '<p id="duplicate">Later cached source.</p>',
          );
        }
        await vi.waitFor(() =>
          expect(document.querySelector('#duplicate [data-justranslate-translation]')?.textContent)
            .toBe('缓存译文'),
        );
        expect(lookup).toHaveBeenCalledTimes(lookupCount);
        expect(controller.getStatus()).toMatchObject({
          phase: 'translating', translated: 2, total: 3,
        });
        expect(document.querySelectorAll('[data-justranslate-state="pending"]')).toHaveLength(1);
        expect(pendingBatch!.request.segments.map((segment) => segment.text))
          .toEqual(['Earlier network source.']);
        expect(sendMessage.mock.calls.filter(([request]) => request.type === 'TRANSLATE_BATCH'))
          .toHaveLength(1);

        resolveBatch(pendingBatch!, '网络译文');
        await translation;
        expect(controller.getStatus()).toMatchObject({ phase: 'complete', translated: 3, total: 3 });
        // Advancing the ordered lane past already rendered cache slots must not render twice.
        expect(document.querySelectorAll('[data-justranslate-state="translated"]')).toHaveLength(3);
        expect(document.querySelector('#network [data-justranslate-translation]')?.textContent)
          .toBe('网络译文');
      } finally {
        controller.restore();
        if (pendingBatch) resolveBatch(pendingBatch, '网络译文');
        await translation;
      }
    },
  );

  it('finishes and renders the current window before dispatching the next window', async () => {
    const viewportHeight = window.innerHeight || 768;
    document.body.innerHTML = `
      <main>
        <p id="visible" data-top="0">${longText('Visible slow source.')}</p>
        <p id="ahead" data-top="${viewportHeight + 10}">${longText('Read-ahead fast source.')}</p>
      </main>
    `;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      const top = Number(this.dataset.top ?? 0);
      return {
        x: 0,
        y: top,
        top,
        bottom: top + 20,
        left: 0,
        right: 100,
        width: 100,
        height: 20,
        toJSON: () => ({}),
      };
    });
    const pendingBatches: Array<{
      request: Extract<RuntimeRequest, { type: 'TRANSLATE_BATCH' }>;
      resolve: (result: Result<TranslationBatchResult>) => void;
    }> = [];
    const sendMessage = vi.fn((request: RuntimeRequest): Promise<Result<unknown>> => {
      if (request.type === 'GET_PUBLIC_SETTINGS') {
        return Promise.resolve({ ok: true, data: PUBLIC_SETTINGS });
      }
      if (request.type === 'TRANSLATE_BATCH') {
        return new Promise((resolve) => pendingBatches.push({ request, resolve }));
      }
      return Promise.resolve(controlResponse(request));
    });
    stubChrome(sendMessage);
    const controller = new TranslationController();

    const translation = controller.start();
    await vi.waitFor(() => expect(pendingBatches).toHaveLength(1));
    expect(pendingBatches[0].request.priority).toBe('visible');
    expect(document.querySelector('#ahead [data-justranslate-state="pending"]')).toBeNull();
    resolveBatch(pendingBatches[0], '当前屏译文');
    await vi.waitFor(() => expect(pendingBatches).toHaveLength(2));
    expect(
      document.querySelector('#visible [data-justranslate-state="translated"]'),
    ).not.toBeNull();
    expect(pendingBatches[1].request.priority).toBe('readAhead');
    resolveBatch(pendingBatches[1], '下一屏译文');
    await translation;
    expect(document.querySelector('#visible [data-justranslate-translation]')?.textContent).toBe(
      '当前屏译文',
    );
    controller.restore();
  });

  it('fans out a deduplicated result only as each DOM position becomes committable', async () => {
    document.body.innerHTML = `
      <main>
        <p id="first">${longText('Repeated ordered source.')}</p>
        <p id="middle">${longText('Middle ordered source.')}</p>
        <p id="last">${longText('Repeated ordered source.')}</p>
      </main>
    `;
    const pendingBatches: Array<{
      request: Extract<RuntimeRequest, { type: 'TRANSLATE_BATCH' }>;
      resolve: (result: Result<TranslationBatchResult>) => void;
    }> = [];
    const sendMessage = vi.fn((request: RuntimeRequest): Promise<Result<unknown>> => {
      if (request.type === 'GET_PUBLIC_SETTINGS') {
        return Promise.resolve({ ok: true, data: PUBLIC_SETTINGS });
      }
      if (request.type === 'TRANSLATE_BATCH') {
        return new Promise((resolve) => pendingBatches.push({ request, resolve }));
      }
      return Promise.resolve(controlResponse(request));
    });
    stubChrome(sendMessage);
    const controller = new TranslationController();

    const translation = controller.start();
    await vi.waitFor(() => expect(pendingBatches).toHaveLength(2));
    const repeatedBatch = pendingBatches.find(({ request }) =>
      request.segments.some((segment) => segment.text.includes('Repeated ordered')),
    )!;
    const middleBatch = pendingBatches.find(({ request }) =>
      request.segments.some((segment) => segment.text.includes('Middle ordered')),
    )!;

    resolveBatch(repeatedBatch, '共享译文');
    await vi.waitFor(() =>
      expect(
        document.querySelector('#first [data-justranslate-state="translated"]'),
      ).not.toBeNull(),
    );

    expect(document.querySelector('#last [data-justranslate-state="translated"]')).toBeNull();

    resolveBatch(middleBatch, '中间译文');
    await translation;

    expect(document.querySelector('#middle [data-justranslate-translation]')?.textContent).toBe(
      '中间译文',
    );
    expect(document.querySelector('#last [data-justranslate-translation]')?.textContent).toBe(
      '共享译文',
    );
    expect(pendingBatches.flatMap(({ request }) => request.segments)).toHaveLength(2);
    controller.restore();
  });

  it('isolates a failed batch and continues translating later nodes', async () => {
    document.body.innerHTML = `<main><p id="failed">${longText('First source fails.')}</p><p>${longText('Second source works.')}</p></main>`;
    let batchCount = 0;
    const sendMessage = vi.fn((request: RuntimeRequest): Promise<Result<unknown>> => {
      if (request.type === 'GET_PUBLIC_SETTINGS') {
        return Promise.resolve({ ok: true, data: PUBLIC_SETTINGS });
      }
      if (request.type === 'TRANSLATE_BATCH') {
        batchCount += 1;
        if (batchCount === 1) return Promise.resolve({ ok: false, error: 'provider unavailable' });
        return Promise.resolve({
          ok: true,
          data: Object.fromEntries(
            request.segments.map((segment) => [segment.requestId, '第二段译文']),
          ),
        });
      }
      return Promise.resolve(controlResponse(request));
    });
    stubChrome(sendMessage);
    const controller = new TranslationController();

    await controller.start();

    expect(document.querySelector('#failed [data-justranslate-state="error"]')?.textContent).toBe(
      '翻译失败 · 重试',
    );
    expect(document.body.textContent).toContain('第二段译文');
    expect(controller.getStatus()).toMatchObject({
      phase: 'error',
      translated: 1,
      failed: 1,
      total: 2,
      error: 'provider unavailable',
    });
    expect(batchCount).toBe(2);
    controller.restore();
  });

  it('keeps valid items from a partial provider response and fails only the missing node', async () => {
    document.body.innerHTML = `
      <main>
        <p id="success">First item in one provider batch.</p>
        <p id="failed">Second item in one provider batch.</p>
      </main>
    `;
    const sendMessage = vi.fn((request: RuntimeRequest): Promise<Result<unknown>> => {
      if (request.type === 'GET_PUBLIC_SETTINGS') {
        return Promise.resolve({ ok: true, data: PUBLIC_SETTINGS });
      }
      if (request.type === 'TRANSLATE_BATCH') {
        const [success, failed] = request.segments;
        return Promise.resolve({
          ok: true,
          data: {
            translations: { [success.requestId]: '保留的成功译文' },
            failures: { [failed.requestId]: '补偿请求后仍缺少译文' },
          } satisfies TranslationBatchResult,
        });
      }
      return Promise.resolve(controlResponse(request));
    });
    stubChrome(sendMessage);
    const controller = new TranslationController();

    await controller.start();

    expect(document.querySelector('#success [data-justranslate-translation]')?.textContent).toBe(
      '保留的成功译文',
    );
    expect(document.querySelector('#failed [data-justranslate-state="error"]')).not.toBeNull();
    expect(controller.getStatus()).toMatchObject({ translated: 1, failed: 1, total: 2 });
    controller.restore();
  });

  it('retries only one failed source and ignores duplicate retry activation', async () => {
    document.body.innerHTML = '<main><p id="source">Retry only this source.</p></main>';
    let batchCount = 0;
    let resolveRetry: ((result: Result<TranslationBatchResult>) => void) | undefined;
    let retrySegments: Extract<RuntimeRequest, { type: 'TRANSLATE_BATCH' }>['segments'] = [];
    const sendMessage = vi.fn((request: RuntimeRequest): Promise<Result<unknown>> => {
      if (request.type === 'GET_PUBLIC_SETTINGS') {
        return Promise.resolve({ ok: true, data: PUBLIC_SETTINGS });
      }
      if (request.type === 'TRANSLATE_BATCH') {
        batchCount += 1;
        if (batchCount === 1) return Promise.resolve({ ok: false, error: 'temporary failure' });
        retrySegments = request.segments;
        return new Promise((resolve) => {
          resolveRetry = resolve;
        });
      }
      return Promise.resolve(controlResponse(request));
    });
    stubChrome(sendMessage);
    const controller = new TranslationController();
    await controller.start();
    const source = document.querySelector<HTMLElement>('#source')!;

    const retry = controller.retry(source);
    const duplicateRetry = controller.retry(source);
    await vi.waitFor(() => expect(resolveRetry).toBeTypeOf('function'));

    expect(batchCount).toBe(2);
    expect(source.querySelector('[data-justranslate-state="pending"]')).not.toBeNull();
    resolveRetry!({
      ok: true,
      data: successfulBatchData(retrySegments, () => '重试成功'),
    });
    await Promise.all([retry, duplicateRetry]);

    expect(source.querySelector('[data-justranslate-state="translated"]')?.textContent).toBe(
      '重试成功',
    );
    expect(controller.getStatus()).toMatchObject({
      phase: 'complete',
      translated: 1,
      failed: 0,
      total: 1,
    });
    controller.restore();
  });

  it('keeps the node retryable when its manual retry fails again', async () => {
    document.body.innerHTML = '<main><p id="source">This source always fails.</p></main>';
    let batchCount = 0;
    const sendMessage = vi.fn((request: RuntimeRequest): Promise<Result<unknown>> => {
      if (request.type === 'GET_PUBLIC_SETTINGS') {
        return Promise.resolve({ ok: true, data: PUBLIC_SETTINGS });
      }
      if (request.type === 'TRANSLATE_BATCH') {
        batchCount += 1;
        return Promise.resolve({ ok: false, error: `failure ${batchCount}` });
      }
      return Promise.resolve(controlResponse(request));
    });
    stubChrome(sendMessage);
    const controller = new TranslationController();
    await controller.start();
    const source = document.querySelector<HTMLElement>('#source')!;

    await controller.retry(source);

    expect(batchCount).toBe(2);
    expect(source.querySelector('[data-justranslate-state="error"]')?.textContent).toBe(
      '翻译失败 · 重试',
    );
    expect(controller.getStatus()).toMatchObject({
      phase: 'error',
      translated: 0,
      failed: 1,
      total: 1,
      error: 'failure 2',
    });
    controller.restore();
  });

  it('fails a split node as one unit and merges every segment on its manual retry', async () => {
    document.body.innerHTML = `<main><p id="source">${'a'.repeat(1_400)}</p></main>`;
    let initialSessionId: string | undefined;
    let initialBatchCount = 0;
    const retryParts: number[] = [];
    const sendMessage = vi.fn((request: RuntimeRequest): Promise<Result<unknown>> => {
      if (request.type === 'GET_PUBLIC_SETTINGS') {
        return Promise.resolve({ ok: true, data: PUBLIC_SETTINGS });
      }
      if (request.type === 'TRANSLATE_BATCH') {
        initialSessionId ??= request.sessionId;
        if (request.sessionId === initialSessionId) {
          initialBatchCount += 1;
          if (request.segments.some((segment) => segment.partIndex === 1)) {
            return Promise.resolve({ ok: false, error: 'split failure' });
          }
          return Promise.resolve({
            ok: true,
            data: Object.fromEntries(
              request.segments.map((segment) => [segment.requestId, '旧分段']),
            ),
          });
        }
        retryParts.push(...request.segments.map((segment) => segment.partIndex));
        return Promise.resolve({
          ok: true,
          data: Object.fromEntries(
            request.segments.map((segment) => [segment.requestId, `译${segment.partIndex}`]),
          ),
        });
      }
      return Promise.resolve(controlResponse(request));
    });
    stubChrome(sendMessage);
    const controller = new TranslationController();
    await controller.start();
    const source = document.querySelector<HTMLElement>('#source')!;

    expect(initialBatchCount).toBe(2);
    expect(source.querySelector('[data-justranslate-state="error"]')).not.toBeNull();
    expect(controller.getStatus()).toMatchObject({ failed: 1, translated: 0, total: 1 });

    await controller.retry(source);

    expect(retryParts).toEqual([1]);
    expect(source.querySelector('[data-justranslate-state="translated"]')?.textContent).toBe(
      '旧分段译1',
    );
    expect(controller.getStatus()).toMatchObject({
      phase: 'complete',
      translated: 1,
      failed: 0,
      total: 1,
    });
    controller.restore();
  });

  it('removes pending nodes on stop and ignores their late result', async () => {
    document.body.innerHTML = '<main><p id="source">Stop this pending source.</p></main>';
    let resolveBatch: ((result: Result<TranslationBatchResult>) => void) | undefined;
    let segments: Extract<RuntimeRequest, { type: 'TRANSLATE_BATCH' }>['segments'] = [];
    const sendMessage = vi.fn((request: RuntimeRequest): Promise<Result<unknown>> => {
      if (request.type === 'GET_PUBLIC_SETTINGS') {
        return Promise.resolve({ ok: true, data: PUBLIC_SETTINGS });
      }
      if (request.type === 'TRANSLATE_BATCH') {
        segments = request.segments;
        return new Promise((resolve) => {
          resolveBatch = resolve;
        });
      }
      return Promise.resolve(controlResponse(request));
    });
    stubChrome(sendMessage);
    const controller = new TranslationController();

    const translation = controller.start();
    await vi.waitFor(() => expect(resolveBatch).toBeTypeOf('function'));
    controller.stop();

    expect(document.querySelector('[data-justranslate-translation]')).toBeNull();
    expect(document.querySelector('#source')?.textContent).toBe('Stop this pending source.');
    resolveBatch!({
      ok: true,
      data: successfulBatchData(segments, () => '不应显示'),
    });
    await translation;

    expect(document.body.textContent).not.toContain('不应显示');
    expect(controller.getStatus().phase).toBe('stopped');
    controller.restore();
  });

  it('discards a stale API result and retranslates the current source text', async () => {
    document.body.innerHTML = '<main><p id="source">Original source text.</p></main>';
    let resolveFirstBatch: ((result: Result<TranslationBatchResult>) => void) | undefined;
    let firstBatchSegments: Extract<RuntimeRequest, { type: 'TRANSLATE_BATCH' }>['segments'] = [];
    let batchCount = 0;
    const sendMessage = vi.fn((request: RuntimeRequest): Promise<Result<unknown>> => {
      if (request.type === 'GET_PUBLIC_SETTINGS') {
        return Promise.resolve({ ok: true, data: PUBLIC_SETTINGS });
      }
      if (request.type === 'TRANSLATE_BATCH') {
        batchCount += 1;
        if (batchCount === 1) {
          firstBatchSegments = request.segments;
          return new Promise((resolve) => {
            resolveFirstBatch = resolve;
          });
        }
        expect(request.segments.map((segment) => segment.text)).toContain('Updated source text.');
        return Promise.resolve({
          ok: true,
          data: Object.fromEntries(
            request.segments.map((segment) => [segment.requestId, '新译文']),
          ),
        });
      }
      return Promise.resolve(controlResponse(request));
    });
    stubChrome(sendMessage);
    const controller = new TranslationController();

    const translation = controller.start();
    await vi.waitFor(() => expect(resolveFirstBatch).toBeTypeOf('function'));
    document.querySelector('#source')!.textContent = 'Updated source text.';
    resolveFirstBatch!({
      ok: true,
      data: successfulBatchData(firstBatchSegments, () => '旧译文'),
    });
    await translation;

    expect(document.querySelector('[data-justranslate-translation]')?.textContent).toBe('新译文');
    expect(document.body.textContent).not.toContain('旧译文');
    expect(controller.getStatus()).toMatchObject({ phase: 'complete', translated: 1, total: 1 });
    expect(batchCount).toBe(2);
    controller.restore();
  });

  it('translates newly added visible content while an earlier request is still running', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<main><p id="initial">Initial slow source.</p></main>';
    let resolveInitial: ((result: Result<TranslationBatchResult>) => void) | undefined;
    let initialSegments: Extract<RuntimeRequest, { type: 'TRANSLATE_BATCH' }>['segments'] = [];
    const requestedTexts: string[] = [];
    const sendMessage = vi.fn((request: RuntimeRequest): Promise<Result<unknown>> => {
      if (request.type === 'GET_PUBLIC_SETTINGS') {
        return Promise.resolve({ ok: true, data: PUBLIC_SETTINGS });
      }
      if (request.type === 'TRANSLATE_BATCH') {
        requestedTexts.push(...request.segments.map((segment) => segment.text));
        if (request.segments.some((segment) => segment.text.includes('Initial slow'))) {
          initialSegments = request.segments;
          return new Promise((resolve) => {
            resolveInitial = resolve;
          });
        }
        return Promise.resolve({
          ok: true,
          data: Object.fromEntries(
            request.segments.map((segment) => [segment.requestId, '动态译文']),
          ),
        });
      }
      return Promise.resolve(controlResponse(request));
    });
    stubChrome(sendMessage);
    const controller = new TranslationController();

    const translation = controller.start();
    await vi.waitFor(() => expect(resolveInitial).toBeTypeOf('function'));
    document
      .querySelector('main')!
      .insertAdjacentHTML('beforeend', '<p id="dynamic">Dynamic visible source.</p>');
    await vi.advanceTimersByTimeAsync(800);
    await Promise.resolve();
    await Promise.resolve();

    expect(requestedTexts).toContain('Dynamic visible source.');
    expect(document.querySelector('#dynamic [data-justranslate-state="translated"]')).toBeNull();
    expect(document.querySelector('#dynamic [data-justranslate-state="pending"]')).not.toBeNull();
    expect(document.querySelector('#initial [data-justranslate-state="pending"]')).not.toBeNull();

    resolveInitial!({
      ok: true,
      data: successfulBatchData(initialSegments, () => '初始译文'),
    });
    await translation;

    expect(
      document.querySelector('#initial [data-justranslate-state="translated"]')?.textContent,
    ).toBe('初始译文');
    expect(
      document.querySelector('#dynamic [data-justranslate-state="translated"]')?.textContent,
    ).toBe('动态译文');
    controller.restore();
  });

  it('attaches dynamic duplicate text to the existing in-flight group', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<main><p id="first">Repeated live source.</p></main>';
    let requestCount = 0;
    let resolveBatchRequest: ((result: Result<TranslationBatchResult>) => void) | undefined;
    let segments: Extract<RuntimeRequest, { type: 'TRANSLATE_BATCH' }>['segments'] = [];
    const sendMessage = vi.fn((request: RuntimeRequest): Promise<Result<unknown>> => {
      if (request.type === 'GET_PUBLIC_SETTINGS') {
        return Promise.resolve({ ok: true, data: PUBLIC_SETTINGS });
      }
      if (request.type === 'TRANSLATE_BATCH') {
        requestCount += 1;
        segments = request.segments;
        return new Promise((resolve) => {
          resolveBatchRequest = resolve;
        });
      }
      return Promise.resolve(controlResponse(request));
    });
    stubChrome(sendMessage);
    const controller = new TranslationController();

    const translation = controller.start();
    await vi.waitFor(() => expect(resolveBatchRequest).toBeTypeOf('function'));
    document
      .querySelector('main')!
      .insertAdjacentHTML('beforeend', '<p id="second">Repeated live source.</p>');
    await vi.advanceTimersByTimeAsync(800);
    await Promise.resolve();

    expect(requestCount).toBe(1);
    expect(document.querySelector('#second [data-justranslate-state="pending"]')).not.toBeNull();

    resolveBatchRequest!({
      ok: true,
      data: successfulBatchData(segments, () => '共享动态译文'),
    });
    await translation;

    expect(
      document.querySelector('#first [data-justranslate-state="translated"]')?.textContent,
    ).toBe('共享动态译文');
    expect(
      document.querySelector('#second [data-justranslate-state="translated"]')?.textContent,
    ).toBe('共享动态译文');
    controller.restore();
  });

  it('translates content that becomes visible through an attribute-only change', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<main><p id="lazy" hidden>Lazy content.</p></main>';
    const sendMessage = vi.fn((request: RuntimeRequest): Promise<Result<unknown>> => {
      if (request.type === 'GET_PUBLIC_SETTINGS') {
        return Promise.resolve({ ok: true, data: PUBLIC_SETTINGS });
      }
      if (request.type === 'TRANSLATE_BATCH') {
        return Promise.resolve({
          ok: true,
          data: Object.fromEntries(
            request.segments.map((segment) => [segment.requestId, '延迟内容']),
          ),
        });
      }
      return Promise.resolve(controlResponse(request));
    });
    stubChrome(sendMessage);
    const controller = new TranslationController();
    await controller.start();

    document.querySelector<HTMLElement>('#lazy')!.hidden = false;
    await vi.advanceTimersByTimeAsync(800);
    await Promise.resolve();
    await Promise.resolve();

    expect(document.querySelector('[data-justranslate-translation]')?.textContent).toBe('延迟内容');
    controller.restore();
  });

  it('collects dynamic content from changed roots instead of rescanning the whole document', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<main><p>Initial stable content.</p></main>';
    const requestedTexts: string[] = [];
    const sendMessage = vi.fn((request: RuntimeRequest): Promise<Result<unknown>> => {
      if (request.type === 'GET_PUBLIC_SETTINGS') {
        return Promise.resolve({ ok: true, data: PUBLIC_SETTINGS });
      }
      if (request.type === 'TRANSLATE_BATCH') {
        requestedTexts.push(...request.segments.map((segment) => segment.text));
        return Promise.resolve({
          ok: true,
          data: Object.fromEntries(
            request.segments.map((segment) => [segment.requestId, `译文 ${segment.text}`]),
          ),
        });
      }
      return Promise.resolve(controlResponse(request));
    });
    stubChrome(sendMessage);
    const controller = new TranslationController();
    await controller.start();

    const bodyScan = vi.spyOn(document.body, 'querySelectorAll');
    document
      .querySelector('main')!
      .insertAdjacentHTML('beforeend', '<p id="delta">Only this dynamic block is new.</p>');
    await vi.advanceTimersByTimeAsync(800);
    await Promise.resolve();
    await Promise.resolve();

    expect(bodyScan).not.toHaveBeenCalled();
    expect(requestedTexts).toContain('Only this dynamic block is new.');
    controller.restore();
  });

  it('repairs a translated source when the page removes only its translation node', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<main><p>Stable source content.</p></main>';
    let batchCount = 0;
    const sendMessage = vi.fn((request: RuntimeRequest): Promise<Result<unknown>> => {
      if (request.type === 'GET_PUBLIC_SETTINGS') {
        return Promise.resolve({ ok: true, data: PUBLIC_SETTINGS });
      }
      if (request.type === 'TRANSLATE_BATCH') {
        batchCount += 1;
        return Promise.resolve({
          ok: true,
          data: Object.fromEntries(
            request.segments.map((segment) => [segment.requestId, '稳定译文']),
          ),
        });
      }
      return Promise.resolve(controlResponse(request));
    });
    stubChrome(sendMessage);
    const controller = new TranslationController();
    await controller.start();

    document.querySelector('[data-justranslate-translation]')!.remove();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(800);
    await Promise.resolve();
    await Promise.resolve();

    expect(document.querySelector('[data-justranslate-translation]')?.textContent).toBe('稳定译文');
    expect(batchCount).toBe(1);
    controller.restore();
  });

  it('drops records for page nodes removed by dynamic updates', async () => {
    document.body.innerHTML = '<main><p id="removed">Content removed by the page.</p></main>';
    const sendMessage = vi.fn((request: RuntimeRequest): Promise<Result<unknown>> => {
      if (request.type === 'GET_PUBLIC_SETTINGS') {
        return Promise.resolve({ ok: true, data: PUBLIC_SETTINGS });
      }
      if (request.type === 'TRANSLATE_BATCH') {
        return Promise.resolve({
          ok: true,
          data: Object.fromEntries(
            request.segments.map((segment) => [segment.requestId, '已翻译内容']),
          ),
        });
      }
      return Promise.resolve(controlResponse(request));
    });
    stubChrome(sendMessage);
    const controller = new TranslationController();
    await controller.start();

    document.querySelector('#removed')!.remove();
    await Promise.resolve();
    await Promise.resolve();

    expect(controller.getStatus()).toMatchObject({ translated: 0, failed: 0, total: 0 });
    controller.restore();
  });

  it('stops after bounded stale retries when a page keeps changing', async () => {
    document.body.innerHTML = '<main><p id="source">Version 0 content.</p></main>';
    let batchCount = 0;
    const sendMessage = vi.fn((request: RuntimeRequest): Promise<Result<unknown>> => {
      if (request.type === 'GET_PUBLIC_SETTINGS') {
        return Promise.resolve({ ok: true, data: PUBLIC_SETTINGS });
      }
      if (request.type === 'TRANSLATE_BATCH') {
        batchCount += 1;
        document.querySelector('#source')!.textContent = `Version ${batchCount} content.`;
        return Promise.resolve({
          ok: true,
          data: Object.fromEntries(
            request.segments.map((segment) => [segment.requestId, '过期译文']),
          ),
        });
      }
      return Promise.resolve(controlResponse(request));
    });
    stubChrome(sendMessage);
    const controller = new TranslationController();

    await controller.start();

    expect(batchCount).toBe(3);
    const status = controller.getStatus();
    expect(status.phase).toBe('error');
    expect(status.error).toMatch(/持续变化/u);
    expect(document.querySelector('[data-justranslate-translation]')).toBeNull();
    controller.restore();
  });

  it('reuses the persistent cache after restore without another AI request', async () => {
    document.body.innerHTML = '<main><p>Translate this source again.</p></main>';
    let batchCount = 0;
    const persistentCache = new Map<string, string>();
    const sendMessage = vi.fn((request: RuntimeRequest): Promise<Result<unknown>> => {
      if (request.type === 'GET_PUBLIC_SETTINGS') {
        return Promise.resolve({ ok: true, data: PUBLIC_SETTINGS });
      }
      if (request.type === 'TRANSLATE_BATCH') {
        batchCount += 1;
        return Promise.resolve({
          ok: true,
          data: Object.fromEntries(
            request.segments.map((segment) => [segment.requestId, `译文 ${batchCount}`]),
          ),
        });
      }
      return Promise.resolve(controlResponse(request));
    });
    stubChrome(
      sendMessage,
      (request) => {
        const cachedTranslations: Record<string, string> = {};
        const missIds: string[] = [];
        for (const candidate of request.candidates) {
          const cached = persistentCache.get(candidate.text);
          if (cached === undefined) missIds.push(candidate.id);
          else cachedTranslations[candidate.id] = cached;
        }
        return Promise.resolve({ skippedIds: [], cachedTranslations, missIds });
      },
      (request) => {
        for (const entry of request.entries) {
          persistentCache.set(entry.sourceText, entry.translatedText);
        }
      },
    );
    const controller = new TranslationController();

    await controller.start();
    expect(document.querySelector('[data-justranslate-translation]')?.textContent).toBe('译文 1');
    controller.restore();
    await controller.start();

    expect(document.querySelector('[data-justranslate-translation]')?.textContent).toBe('译文 1');
    expect(batchCount).toBe(1);
    controller.restore();
  });

  it('renders a persistent-cache hit without pending UI or an AI request', async () => {
    document.body.innerHTML = '<main><p id="source">Already cached source text.</p></main>';
    const sendMessage = vi.fn((request: RuntimeRequest): Promise<Result<unknown>> => {
      if (request.type === 'GET_PUBLIC_SETTINGS') {
        return Promise.resolve({ ok: true, data: PUBLIC_SETTINGS });
      }
      if (request.type === 'TRANSLATE_BATCH') {
        return Promise.reject(new Error('AI request must not run for a cache hit'));
      }
      return Promise.resolve(controlResponse(request));
    });
    stubChrome(sendMessage, (request) =>
      Promise.resolve({
        skippedIds: [],
        cachedTranslations: Object.fromEntries(
          request.candidates.map((candidate) => [candidate.id, '持久缓存译文']),
        ),
        missIds: [],
      }),
    );
    const controller = new TranslationController();

    await controller.start();

    expect(
      document.querySelector('#source [data-justranslate-state="translated"]')?.textContent,
    ).toBe('持久缓存译文');
    expect(document.querySelector('[data-justranslate-state="pending"]')).toBeNull();
    expect(sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'TRANSLATE_BATCH' }),
    );
    expect(controller.getStatus()).toMatchObject({ translated: 1, failed: 0, total: 1 });
    controller.restore();
  });

  it('deduplicates identical source text into one network unit and fans out its result', async () => {
    document.body.innerHTML = `
      <main>
        <p id="first">Repeated source paragraph.</p>
        <p id="second">Repeated source paragraph.</p>
      </main>
    `;
    const requestedSourceTexts: string[] = [];
    const sendMessage = vi.fn((request: RuntimeRequest): Promise<Result<unknown>> => {
      if (request.type === 'GET_PUBLIC_SETTINGS') {
        return Promise.resolve({ ok: true, data: PUBLIC_SETTINGS });
      }
      if (request.type === 'TRANSLATE_BATCH') {
        requestedSourceTexts.push(...request.segments.map((segment) => segment.text));
        return Promise.resolve({
          ok: true,
          data: Object.fromEntries(
            request.segments.map((segment) => [segment.requestId, '共享译文']),
          ),
        });
      }
      return Promise.resolve(controlResponse(request));
    });
    stubChrome(sendMessage);
    const controller = new TranslationController();

    await controller.start();

    expect(requestedSourceTexts).toEqual(['Repeated source paragraph.']);
    // Keep status visible in assertion output when the request pipeline regresses.
    expect(controller.getStatus()).toMatchObject({ phase: 'complete', translated: 2, failed: 0 });
    expect(
      document.querySelector('#first [data-justranslate-state="translated"]')?.textContent,
    ).toBe('共享译文');
    expect(
      document.querySelector('#second [data-justranslate-state="translated"]')?.textContent,
    ).toBe('共享译文');
    expect(controller.getStatus()).toMatchObject({ translated: 2, failed: 0, total: 2 });
    controller.restore();
  });

  it('excludes background-skipped candidates from loading UI and status totals', async () => {
    document.body.innerHTML = `
      <main lang="ja">
        <p id="source-ja">これは翻訳が必要な日本語の文章です。</p>
        <p id="source-zh" lang="zh-CN">这是已经属于目标语言的中文内容。</p>
      </main>
    `;
    const sendMessage = vi.fn((request: RuntimeRequest): Promise<Result<unknown>> => {
      if (request.type === 'GET_PUBLIC_SETTINGS') {
        return Promise.resolve({ ok: true, data: PUBLIC_SETTINGS });
      }
      if (request.type === 'TRANSLATE_BATCH') {
        return Promise.resolve({
          ok: true,
          data: Object.fromEntries(
            request.segments.map((segment) => [segment.requestId, '日文译文']),
          ),
        });
      }
      return Promise.resolve(controlResponse(request));
    });
    stubChrome(sendMessage, (request) =>
      Promise.resolve({
        skippedIds: request.candidates
          .filter((candidate) => candidate.declaredLanguage === 'zh-CN')
          .map((candidate) => candidate.id),
        cachedTranslations: {},
        missIds: request.candidates
          .filter((candidate) => candidate.declaredLanguage !== 'zh-CN')
          .map((candidate) => candidate.id),
      }),
    );
    const controller = new TranslationController();

    await controller.start();

    expect(
      document.querySelector('#source-ja [data-justranslate-state="translated"]')?.textContent,
    ).toBe('日文译文');
    expect(document.querySelector('#source-zh [data-justranslate-translation]')).toBeNull();
    expect(controller.getStatus()).toMatchObject({ translated: 1, failed: 0, total: 1 });
    controller.restore();
  });

  it('runs at most six batches concurrently and lets later batches start as slots free up', async () => {
    document.body.innerHTML = `
      <main>
        <p>${longText('Concurrent source zero.')}</p>
        <p>${longText('Concurrent source one.')}</p>
        <p>${longText('Concurrent source two.')}</p>
        <p>${longText('Concurrent source three.')}</p>
        <p>${longText('Concurrent source four.')}</p>
        <p>${longText('Concurrent source five.')}</p>
        <p>${longText('Concurrent source six.')}</p>
        <p>${longText('Concurrent source seven.')}</p>
      </main>
    `;
    const releases: Array<() => void> = [];
    let active = 0;
    let maximumActive = 0;
    let started = 0;
    const sendMessage = vi.fn((request: RuntimeRequest): Promise<Result<unknown>> => {
      if (request.type === 'GET_PUBLIC_SETTINGS') {
        return Promise.resolve({ ok: true, data: PUBLIC_SETTINGS });
      }
      if (request.type === 'TRANSLATE_BATCH') {
        started += 1;
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        return new Promise((resolve) => {
          releases.push(() => {
            active -= 1;
            resolve({
              ok: true,
              data: Object.fromEntries(
                request.segments.map((segment) => [segment.requestId, `译文 ${segment.text}`]),
              ),
            });
          });
        });
      }
      return Promise.resolve(controlResponse(request));
    });
    stubChrome(sendMessage);
    const controller = new TranslationController();

    const translation = controller.start();
    await vi.waitFor(() => expect(started).toBe(6));
    expect(maximumActive).toBe(6);

    releases.shift()?.();
    await vi.waitFor(() => expect(started).toBe(7));
    expect(maximumActive).toBe(6);

    while (started < 8 || releases.length > 0) {
      releases.shift()?.();
      await Promise.resolve();
      await Promise.resolve();
    }
    await translation;

    expect(document.querySelectorAll('[data-justranslate-state="translated"]')).toHaveLength(8);
    expect(maximumActive).toBe(6);
    controller.restore();
  });
});

type CandidateRequest = Extract<RuntimeRequest, { type: 'RESOLVE_TRANSLATION_CANDIDATES' }>;

function controlResponse(request: RuntimeRequest): Extract<Result<unknown>, { ok: true }> {
  return {
    ok: true,
    data:
      request.type === 'BEGIN_TRANSLATION_SESSION'
        ? {
            configurationId: 'config-one',
            context: {
              profileId: PUBLIC_SETTINGS.activeProfileId,
              targetLanguage: PUBLIC_SETTINGS.targetLanguage,
            },
          }
        : undefined,
  };
}
type CacheWriteRequest = Extract<RuntimeRequest, { type: 'STORE_TRANSLATION_CACHE' }>;

function longText(label: string): string {
  return `${label} ${'x'.repeat(650)}`;
}

function successfulBatchData(
  segments: Extract<RuntimeRequest, { type: 'TRANSLATE_BATCH' }>['segments'],
  translate: (segment: (typeof segments)[number]) => string,
): TranslationBatchResult {
  return {
    translations: Object.fromEntries(
      segments.map((segment) => [segment.requestId, translate(segment)]),
    ),
    failures: {},
  };
}

function resolveBatch(
  pending: {
    request: Extract<RuntimeRequest, { type: 'TRANSLATE_BATCH' }>;
    resolve: (result: Result<TranslationBatchResult>) => void;
  },
  translatedText: string,
): void {
  pending.resolve({
    ok: true,
    data: {
      translations: Object.fromEntries(
        pending.request.segments.map((segment) => [segment.requestId, translatedText]),
      ),
      failures: {},
    },
  });
}

function stubChrome(
  sendMessage: (request: RuntimeRequest) => Promise<Result<unknown>>,
  resolveCandidates?: (request: CandidateRequest) => Promise<{
    skippedIds: string[];
    cachedTranslations: Record<string, string>;
    missIds: string[];
  }>,
  storeCache?: (request: CacheWriteRequest) => void,
): void {
  const persistentCache = new Map<string, string>();
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage: (request: RuntimeRequest) => {
        if (request.type === 'RESOLVE_TRANSLATION_CANDIDATES') {
          const resolution = resolveCandidates
            ? resolveCandidates(request)
            : Promise.resolve({
                skippedIds: [],
                cachedTranslations: Object.fromEntries(
                  request.candidates.flatMap((candidate) => {
                    const cached = persistentCache.get(candidate.text);
                    return cached === undefined ? [] : [[candidate.id, cached]];
                  }),
                ),
                missIds: request.candidates
                  .filter((candidate) => !persistentCache.has(candidate.text))
                  .map((candidate) => candidate.id),
              });
          return resolution.then((data) => ({ ok: true, data }));
        }
        if (request.type === 'STORE_TRANSLATION_CACHE') {
          if (storeCache) storeCache(request);
          else {
            for (const entry of request.entries) {
              persistentCache.set(entry.sourceText, entry.translatedText);
            }
          }
          return Promise.resolve(controlResponse(request));
        }
        return sendMessage(request).then((result) => {
          if (request.type !== 'TRANSLATE_BATCH' || !result.ok) return result;
          const data = result.data;
          if (
            typeof data === 'object' &&
            data !== null &&
            'translations' in data &&
            'failures' in data
          ) {
            return result;
          }
          return {
            ok: true,
            data: { translations: data as Record<string, string>, failures: {} },
          } satisfies Result<TranslationBatchResult>;
        });
      },
    },
  });
}
