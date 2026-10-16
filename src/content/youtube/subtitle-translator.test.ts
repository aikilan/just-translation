import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Result, RuntimeRequest, TranslationBatchResult } from '../../shared/messages';
import type { SubtitleSentence } from './sentences';
import { SubtitleTranslator } from './subtitle-translator';

type Batch = Extract<RuntimeRequest, { type: 'TRANSLATE_BATCH' }>;
const TRANSLATOR = { kind: 'builtin', engine: 'google-free' } as const;

/** One sentence every 10 s: s0 at 0 s, s1 at 10 s, … */
function sentences(count: number): SubtitleSentence[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `s${index}`,
    startMs: index * 10_000,
    endMs: index * 10_000 + 4_000,
    text: `Line number ${index}.`,
  }));
}

function fakeRuntime(options: {
  cached?: Record<string, string>;
  skipped?: string[];
  translate?: (
    batch: Batch,
  ) => Result<TranslationBatchResult> | Promise<Result<TranslationBatchResult>>;
}) {
  const requests: RuntimeRequest[] = [];
  const runtime = vi.fn(async (request: RuntimeRequest): Promise<Result<unknown>> => {
    requests.push(request);
    await Promise.resolve();
    switch (request.type) {
      case 'BEGIN_TRANSLATION_SESSION':
        return {
          ok: true,
          data: {
            configurationId: 'config',
            context: { translator: TRANSLATOR, targetLanguage: 'Simplified Chinese' },
            batchProfiles: {
              visible: { maxCharacters: 1_000, maxItems: 1 },
              readAhead: { maxCharacters: 1_000, maxItems: 1 },
              background: { maxCharacters: 1_000, maxItems: 1 },
            },
            maxConcurrency: 2,
          },
        };
      case 'RESOLVE_TRANSLATION_CANDIDATES': {
        const cached = Object.fromEntries(
          request.candidates
            .filter((candidate) => options.cached?.[candidate.text])
            .map((candidate) => [candidate.id, options.cached![candidate.text]]),
        );
        const skippedIds = request.candidates
          .filter((candidate) => options.skipped?.includes(candidate.text))
          .map((candidate) => candidate.id);
        return {
          ok: true,
          data: {
            cachedTranslations: cached,
            skippedIds,
            missIds: request.candidates
              .map((candidate) => candidate.id)
              .filter((id) => !(id in cached) && !skippedIds.includes(id)),
          },
        };
      }
      case 'TRANSLATE_BATCH':
        return (
          options.translate?.(request) ?? {
            ok: true,
            data: {
              translations: Object.fromEntries(
                request.segments.map((segment) => [segment.requestId, `译文 ${segment.text}`]),
              ),
              failures: {},
            },
          }
        );
      default:
        return { ok: true, data: undefined };
    }
  });
  return { runtime: runtime as never, requests };
}

const sentTexts = (requests: RuntimeRequest[]) =>
  requests.flatMap((request) =>
    request.type === 'TRANSLATE_BATCH' ? request.segments.map((segment) => segment.text) : [],
  );
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('subtitle translator', () => {
  afterEach(() => vi.useRealTimers());

  it('translates only the lines near playback and follows a seek', async () => {
    const { runtime, requests } = fakeRuntime({});
    const listener = { onChange: vi.fn(), onError: vi.fn() };
    const translator = new SubtitleTranslator(sentences(60), 'en', listener, runtime);
    await translator.start(TRANSLATOR);
    for (let i = 0; i < 20; i++) await settle();
    // 0 s to 180 s ahead: lines 0–18.
    expect(sentTexts(requests)).toHaveLength(19);
    expect(sentTexts(requests)[0]).toBe('Line number 0.');
    expect(translator.translationOf('s0')).toEqual({
      state: 'translated',
      text: '译文 Line number 0.',
    });
    expect(translator.translationOf('s30')).toEqual({ state: 'pending' });
    translator.setPosition(400_000);
    for (let i = 0; i < 20; i++) await settle();
    expect(sentTexts(requests)).toContain('Line number 40.');
    expect(sentTexts(requests)).toContain('Line number 58.');
    expect(sentTexts(requests)).not.toContain('Line number 30.');
    expect(listener.onChange).toHaveBeenCalled();
  });

  it('uses cached lines, keeps target-language lines and stores new translations', async () => {
    const { runtime, requests } = fakeRuntime({
      cached: { 'Line number 0.': '缓存译文' },
      skipped: ['Line number 1.'],
    });
    const translator = new SubtitleTranslator(
      sentences(3),
      'en',
      { onChange() {}, onError() {} },
      runtime,
    );
    await translator.start(TRANSLATOR);
    for (let i = 0; i < 10; i++) await settle();
    expect(translator.translationOf('s0')).toEqual({ state: 'translated', text: '缓存译文' });
    expect(translator.translationOf('s1')).toEqual({ state: 'original' });
    expect(translator.translationOf('s2')).toEqual({
      state: 'translated',
      text: '译文 Line number 2.',
    });
    expect(sentTexts(requests)).toEqual(['Line number 2.']);
    expect(
      requests.find((request) => request.type === 'RESOLVE_TRANSLATION_CANDIDATES'),
    ).toMatchObject({ candidates: [{ declaredLanguage: 'en' }, {}, {}] });
    expect(requests).toContainEqual(
      expect.objectContaining({
        type: 'STORE_TRANSLATION_CACHE',
        entries: [{ sourceText: 'Line number 2.', translatedText: '译文 Line number 2.' }],
      }),
    );
  });

  it('shows the original for a failed line and retries it after a pause', async () => {
    let fail = true;
    const { runtime, requests } = fakeRuntime({
      translate: () =>
        fail
          ? { ok: false, error: { text: 'quota exceeded' } }
          : { ok: true, data: { translations: {}, failures: {} } },
    });
    let now = 0;
    const listener = { onChange: vi.fn(), onError: vi.fn() };
    const translator = new SubtitleTranslator(sentences(1), 'en', listener, runtime, () => now);
    await translator.start(TRANSLATOR);
    for (let i = 0; i < 10; i++) await settle();
    expect(translator.translationOf('s0')).toEqual({
      state: 'failed',
      error: { text: 'quota exceeded' },
    });
    expect(listener.onError).toHaveBeenCalledWith({ text: 'quota exceeded' });
    translator.setPosition(1_000);
    for (let i = 0; i < 10; i++) await settle();
    expect(sentTexts(requests)).toHaveLength(1);
    now = 20_000;
    fail = false;
    translator.setPosition(2_000);
    for (let i = 0; i < 10; i++) await settle();
    // The second attempt returns no text: the line stays original and is not requested again soon.
    expect(sentTexts(requests)).toHaveLength(2);
    expect(translator.translationOf('s0')).toMatchObject({ state: 'failed' });
  });

  it('ends the session when stopped and ignores late results', async () => {
    let release!: () => void;
    const { runtime, requests } = fakeRuntime({
      translate: (batch) =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              ok: true,
              data: {
                translations: { [batch.segments[0].requestId]: 'late' },
                failures: {},
              },
            });
        }),
    });
    const translator = new SubtitleTranslator(
      sentences(1),
      'en',
      { onChange() {}, onError() {} },
      runtime,
    );
    await translator.start(TRANSLATOR);
    for (let i = 0; i < 10; i++) await settle();
    translator.stop();
    release();
    for (let i = 0; i < 10; i++) await settle();
    expect(translator.translationOf('s0')).toEqual({ state: 'pending' });
    expect(requests.map((request) => request.type)).toEqual(
      expect.arrayContaining(['CANCEL_TRANSLATION_REQUESTS', 'END_TRANSLATION_SESSION']),
    );
  });
});
