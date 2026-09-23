// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TranslationController } from './controller';
import type { Result, RuntimeRequest, TranslationBatchResult } from '../shared/messages';
import { DEFAULT_SETTINGS } from '../shared/settings';

type Batch = Extract<RuntimeRequest, { type: 'TRANSLATE_BATCH' }>;
const settings = {
  ...DEFAULT_SETTINGS,
  ready: true,
  supportsFullDocument: true,
  activeTranslator: { kind: 'ai' as const, profileId: 'test-profile' },
  profiles: [{ id: 'test-profile', name: 'Test', configured: true }],
  translationConcurrency: 2,
  translateDynamicContent: false,
};
let controller: TranslationController;
let failureAvailability: boolean[];
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue({ length: 1 } as DOMRectList);
  failureAvailability = [];
  controller = new TranslationController(() => {
    failureAvailability.push(controller.getStatus().failed > 0);
  });
});
afterEach(() => {
  controller.restore();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** The first part succeeds initially; retry must request only the missing long-paragraph parts. */
function batchResult(request: Batch, fails: (segment: Batch['segments'][number]) => boolean) {
  const data: TranslationBatchResult = { translations: {}, failures: {} };
  for (const segment of request.segments) {
    if (fails(segment)) data.failures[segment.requestId] = { text: 'Temporary provider failure' };
    else data.translations[segment.requestId] = `译文 ${segment.partIndex}`;
  }
  return { ok: true, data } satisfies Result<TranslationBatchResult>;
}

function installRuntime(
  onRequest: (request: RuntimeRequest) => Promise<Result<unknown>> | undefined,
) {
  const send = vi.fn((request: RuntimeRequest): Promise<Result<unknown>> => {
    const custom = onRequest(request);
    if (custom) return custom;
    if (request.type === 'GET_PUBLIC_SETTINGS')
      return Promise.resolve({ ok: true, data: settings });
    if (request.type === 'BEGIN_TRANSLATION_SESSION') {
      return Promise.resolve({
        ok: true,
        data: {
          configurationId: 'unchanged-configuration',
          context: {
            translator: settings.activeTranslator,
            targetLanguage: settings.targetLanguage,
          },
          batchProfiles: {
            visible: { maxCharacters: 1_200, maxItems: 4 },
            readAhead: { maxCharacters: 1_800, maxItems: 4 },
            background: { maxCharacters: 2_400, maxItems: 4 },
          },
          maxConcurrency: settings.translationConcurrency,
        },
      });
    }
    if (request.type === 'RESOLVE_TRANSLATION_CANDIDATES') {
      return Promise.resolve({
        ok: true,
        data: {
          skippedIds: [],
          cachedTranslations: {},
          missIds: request.candidates.map((item) => item.id),
        },
      });
    }
    return Promise.resolve({ ok: true, data: undefined });
  });
  vi.stubGlobal('chrome', { runtime: { sendMessage: send } });
  return send;
}

it.each(['success', 'failure', 'stop', 'restore'] as const)(
  'bulk retry preserves successful parts, shares concurrency and handles %s',
  async (outcome) => {
    document.body.innerHTML = `<main>
      <p id="success">Keep this successful paragraph.</p>
      <p id="first">First failed paragraph. ${'alpha '.repeat(410)}</p>
      <p id="second">Second failed paragraph. ${'beta '.repeat(490)}</p>
    </main>`;
    let retrying = false;
    let drain = false;
    let failAgain = outcome === 'failure';
    const retried: Batch[] = [];
    const releases: Array<() => void> = [];
    const failedUnits = new Set<string>();
    const send = installRuntime((request) => {
      if (request.type !== 'TRANSLATE_BATCH') return;
      if (!retrying) {
        return Promise.resolve(
          batchResult(request, (segment) => {
            if (segment.partIndex > 0) {
              failedUnits.add(segment.unitId);
              return true;
            }
            return false;
          }),
        );
      }
      retried.push(request);
      const result = () => batchResult(request, () => failAgain);
      if (drain) return Promise.resolve(result());
      return new Promise((resolve) => releases.push(() => resolve(result())));
    });
    await controller.start();
    expect(controller.getStatus()).toMatchObject({ phase: 'error', translated: 1, failed: 2 });
    expect(failureAvailability).toEqual([true]);
    const preserved = document.querySelector('#success [data-justranslate-translation]');
    retrying = true;
    const work = controller.retryAllFailed();
    try {
      expect(controller.getStatus().phase).toBe('translating');
      await controller.retryAllFailed();
      await vi.waitFor(() => expect(retried).toHaveLength(2));
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(retried).toHaveLength(2);
      expect(failureAvailability).toEqual([true, false]);
      expect(controller.getStatus()).toMatchObject({
        phase: 'translating',
        translated: 1,
        failed: 0,
      });
      expect(document.querySelector('#success [data-justranslate-translation]')).toBe(preserved);
      if (outcome === 'stop') controller.stop();
      if (outcome === 'restore') controller.restore();
      drain = true;
      releases.forEach((release) => release());
      await work;
      if (outcome === 'stop' || outcome === 'restore') {
        expect(retried).toHaveLength(2);
        expect(controller.getStatus().phase).toBe(outcome === 'stop' ? 'stopped' : 'idle');
        expect(
          send.mock.calls.some(([request]) => request.type === 'CANCEL_TRANSLATION_REQUESTS'),
        ).toBe(true);
        expect(document.querySelectorAll('[data-justranslate-state="pending"]')).toHaveLength(0);
      } else {
        expect(controller.getStatus()).toMatchObject({
          phase: failAgain ? 'error' : 'complete',
          translated: failAgain ? 1 : 3,
          failed: failAgain ? 2 : 0,
        });
        const segments = retried.flatMap((request) => request.segments);
        expect(segments.length).toBeGreaterThan(2);
        expect(segments.every((segment) => segment.partIndex > 0)).toBe(true);
        expect(new Set(segments.map((segment) => segment.requestId)).size).toBe(segments.length);
        expect(failedUnits.size).toBe(2);
        if (failAgain) {
          failAgain = false;
          await controller.retryAllFailed();
          expect(controller.getStatus()).toMatchObject({
            phase: 'complete',
            translated: 3,
            failed: 0,
          });
        }
        const count = retried.length;
        await controller.retryAllFailed();
        expect(retried).toHaveLength(count);
        expect(document.querySelector('#success [data-justranslate-translation]')).toBe(preserved);
      }
    } finally {
      controller.stop();
      drain = true;
      releases.forEach((release) => release());
      await work;
    }
  },
);

it('does not start retry sessions when stopped during settings lookup', async () => {
  document.body.innerHTML = '<p>A paragraph that initially fails.</p>';
  let holdSettings = false;
  let release!: (result: Result<unknown>) => void;
  const send = installRuntime((request) => {
    if (request.type === 'TRANSLATE_BATCH')
      return Promise.resolve({ ok: false, error: { text: 'Failed' } });
    if (holdSettings && request.type === 'GET_PUBLIC_SETTINGS')
      return new Promise((resolve) => {
        release = resolve;
      });
  });
  await controller.start();
  const sessionsBefore = send.mock.calls.filter(
    ([r]) => r.type === 'BEGIN_TRANSLATION_SESSION',
  ).length;
  holdSettings = true;
  const work = controller.retryAllFailed();
  await vi.waitFor(() => expect(release).toBeDefined());
  controller.stop();
  release({ ok: true, data: settings });
  await work;
  expect(send.mock.calls.filter(([r]) => r.type === 'BEGIN_TRANSLATION_SESSION')).toHaveLength(
    sessionsBefore,
  );
  expect(controller.getStatus().phase).toBe('stopped');
});
