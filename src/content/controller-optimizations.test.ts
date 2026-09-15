// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Result, RuntimeRequest, TranslationBatchResult } from '../shared/messages';
import { TranslationController } from './controller';
import { TranslationScheduler } from './translation-scheduler';

type Batch = Extract<RuntimeRequest, { type: 'TRANSLATE_BATCH' }>;
const SETTINGS = {
  configured: true,
  activeProfileId: 'one',
  profiles: [{ id: 'one', name: 'Test', configured: true }],
  targetLanguage: 'Simplified Chinese',
  displayMode: 'bilingual',
  translationConcurrency: 6,
  translateDynamicContent: true,
  excludedSites: [],
  autoTranslateSites: [],
};
const controllers: TranslationController[] = [];
function controller(): TranslationController {
  const instance = new TranslationController();
  controllers.push(instance);
  return instance;
}
function successful(request: Batch): Result<TranslationBatchResult> {
  return {
    ok: true,
    data: {
      translations: Object.fromEntries(
        request.segments.map((s) => [s.requestId, `译文 ${s.text}`]),
      ),
      failures: {},
    },
  };
}
function installRuntime(
  handler: (request: RuntimeRequest) => Promise<Result<unknown>> | undefined,
) {
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage: vi.fn((request: RuntimeRequest) => {
        const handled = handler(request);
        if (handled) return handled;
        if (request.type === 'GET_PUBLIC_SETTINGS')
          return Promise.resolve({ ok: true, data: SETTINGS });
        if (request.type === 'BEGIN_TRANSLATION_SESSION')
          return Promise.resolve({
            ok: true,
            data: {
              configurationId: 'config-one',
              context: {
                profileId: SETTINGS.activeProfileId,
                targetLanguage: SETTINGS.targetLanguage,
              },
            },
          });
        if (request.type === 'RESOLVE_TRANSLATION_CANDIDATES')
          return Promise.resolve({
            ok: true,
            data: {
              skippedIds: [],
              cachedTranslations: {},
              missIds: request.candidates.map((c) => c.id),
            },
          });
        if (request.type === 'TRANSLATE_BATCH') return Promise.resolve(successful(request));
        return Promise.resolve({ ok: true, data: undefined });
      }),
    },
  });
}
beforeEach(() => {
  document.body.innerHTML = '';
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue({ length: 1 } as DOMRectList);
});
afterEach(() => {
  for (const instance of controllers.splice(0)) instance.restore();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** A regressed microtask spin would prevent Vitest's timeout from running; stop it explicitly. */
function guardIdleSpin(instance: TranslationController): () => number {
  let waits = 0;
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Forwarded with the intercepted scheduler via call below.
  const original = TranslationScheduler.prototype.waitForIdle;
  vi.spyOn(TranslationScheduler.prototype, 'waitForIdle').mockImplementation(function (
    this: TranslationScheduler,
  ) {
    if (++waits === 50) instance.stop();
    return original.call(this);
  });
  return () => waits;
}

describe('translation pipeline regressions', () => {
  it.each([1, 2, 6])('limits ordinary translation to %s concurrent batches', async (limit) => {
    document.body.innerHTML = `<main>${Array.from(
      { length: 32 },
      (_, i) => `<p>Article paragraph number ${i} with readable English text.</p>`,
    ).join('')}</main>`;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(0, 10, 300, 20),
    );
    const releases: Array<() => void> = [];
    let drain = false;
    installRuntime((request) => {
      if (request.type === 'GET_PUBLIC_SETTINGS')
        return Promise.resolve({
          ok: true,
          data: { ...SETTINGS, translationConcurrency: limit },
        });
      if (request.type === 'TRANSLATE_BATCH' && !drain)
        return new Promise((resolve) => {
          releases.push(() => resolve(successful(request)));
        });
    });
    const instance = controller();
    const work = instance.start();
    try {
      await vi.waitFor(() => expect(releases.length).toBeGreaterThanOrEqual(limit));
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(releases).toHaveLength(limit);
    } finally {
      drain = true;
      releases.forEach((release) => release());
      await work;
    }
    expect(instance.getStatus()).toMatchObject({ phase: 'complete', translated: 32 });
  });

  it('uses the newly saved concurrency when manually retrying a long node', async () => {
    document.body.innerHTML = `<main><p>${'Readable article sentence with detailed information. '.repeat(200)}</p></main>`;
    let retrying = false;
    let drain = false;
    const releases: Array<() => void> = [];
    installRuntime((request) => {
      if (request.type === 'GET_PUBLIC_SETTINGS')
        return Promise.resolve({
          ok: true,
          data: { ...SETTINGS, translationConcurrency: retrying ? 1 : 6 },
        });
      if (request.type !== 'TRANSLATE_BATCH') return;
      if (!retrying) return Promise.resolve({ ok: false, error: 'Failed request' });
      if (!drain)
        return new Promise((resolve) => releases.push(() => resolve(successful(request))));
    });
    const instance = controller();
    await instance.start();
    expect(instance.getStatus().failed).toBe(1);
    retrying = true;
    const work = instance.retry(document.querySelector('p')!);
    try {
      await vi.waitFor(() => expect(releases.length).toBeGreaterThan(0));
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(releases).toHaveLength(1);
    } finally {
      drain = true;
      releases.forEach((release) => release());
      await work;
    }
    expect(instance.getStatus()).toMatchObject({ phase: 'complete', translated: 1 });
  });

  it.each([
    [true, 'miss'],
    [false, 'miss'],
    [true, 'cache'],
    [false, 'cache'],
  ] as const)(
    'replaces stale queued sources after candidate lookup (dynamic=%s, result=%s)',
    async (dynamic, result) => {
      document.body.innerHTML =
        '<main><p id="visible">Original visible source.</p><p id="offscreen">Background source.</p></main>';
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
        this: HTMLElement,
      ) {
        return new DOMRect(0, this.id === 'offscreen' ? 3000 : 10, 300, 20);
      });
      let release!: () => void;
      let firstLookup = true;
      const sent: string[] = [];
      installRuntime((request) => {
        if (request.type === 'GET_PUBLIC_SETTINGS')
          return Promise.resolve({
            ok: true,
            data: { ...SETTINGS, translateDynamicContent: dynamic },
          });
        if (request.type === 'TRANSLATE_BATCH')
          sent.push(...request.segments.map((segment) => segment.text));
        if (request.type !== 'RESOLVE_TRANSLATION_CANDIDATES' || !firstLookup) return;
        firstLookup = false;
        return new Promise((resolve) => {
          release = () =>
            resolve({
              ok: true,
              data: {
                skippedIds: [],
                cachedTranslations:
                  result === 'cache'
                    ? Object.fromEntries(
                        request.candidates.map((candidate) => [candidate.id, '过期缓存译文']),
                      )
                    : {},
                missIds:
                  result === 'miss' ? request.candidates.map((candidate) => candidate.id) : [],
              },
            });
        });
      });
      const instance = controller();
      const idleWaits = guardIdleSpin(instance);
      const work = instance.start();
      try {
        await vi.waitFor(() => expect(release).toBeDefined());
        document.querySelector('#visible')!.firstChild!.textContent = 'Updated visible source.';
        release();
        await work;
        expect(idleWaits()).toBeLessThan(50);
        expect(instance.getStatus()).toMatchObject({
          phase: 'complete',
          translated: 2,
          failed: 0,
          total: 2,
        });
        expect(sent).toEqual(
          expect.arrayContaining(['Updated visible source.', 'Background source.']),
        );
        expect(
          document.querySelector('#visible [data-justranslate-state="translated"]')?.textContent,
        ).toBe('译文 Updated visible source.');
        expect(document.body.textContent).not.toContain('过期缓存译文');
      } finally {
        instance.stop();
        release?.();
        await work;
      }
    },
  );

  it.each(['network', 'cache', 'failure'] as const)(
    'releases an offscreen duplicate behind deferred text after visible %s settles',
    async (result) => {
      document.body.innerHTML =
        '<main><p id="background">Earlier background source.</p><p id="duplicate">Shared visible source.</p><p id="visible">Shared visible source.</p></main>';
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
        this: HTMLElement,
      ) {
        return new DOMRect(0, this.id === 'visible' ? 10 : 3000, 300, 20);
      });
      let release!: () => void;
      const sent: string[] = [];
      installRuntime((request) => {
        if (
          result === 'cache' &&
          request.type === 'RESOLVE_TRANSLATION_CANDIDATES' &&
          request.candidates.some((candidate) => candidate.text === 'Shared visible source.')
        ) {
          return new Promise((resolve) => {
            release = () =>
              resolve({
                ok: true,
                data: {
                  skippedIds: [],
                  missIds: [],
                  cachedTranslations: Object.fromEntries(
                    request.candidates.map((candidate) => [candidate.id, '相同原文的缓存译文']),
                  ),
                },
              });
          });
        }
        if (request.type !== 'TRANSLATE_BATCH') return;
        sent.push(...request.segments.map((segment) => segment.text));
        if (request.segments.some((segment) => segment.text === 'Shared visible source.'))
          return new Promise((resolve) => {
            release = () =>
              resolve(
                result === 'failure'
                  ? { ok: false, error: 'Provider failure' }
                  : successful(request),
              );
          });
      });
      const instance = controller();
      const idleWaits = guardIdleSpin(instance);
      const work = instance.start();
      try {
        await vi.waitFor(() => expect(instance.getStatus().total).toBe(result === 'cache' ? 2 : 3));
        expect(sent).not.toContain('Earlier background source.');
        release();
        await work;
        expect(idleWaits()).toBeLessThan(50);
        expect(instance.getStatus()).toMatchObject({
          phase: result === 'failure' ? 'error' : 'complete',
          translated: result === 'failure' ? 1 : 3,
          failed: result === 'failure' ? 2 : 0,
          total: 3,
        });
        expect(sent.filter((text) => text === 'Shared visible source.')).toHaveLength(
          result === 'cache' ? 0 : 1,
        );
        expect(sent.filter((text) => text === 'Earlier background source.')).toHaveLength(1);
        expect(
          document.querySelector('#background [data-justranslate-state="translated"]'),
        ).not.toBeNull();
        expect(document.querySelectorAll('[data-justranslate-state="pending"]')).toHaveLength(0);
      } finally {
        instance.stop();
        release?.();
        await work;
      }
    },
  );

  it('discovers the current viewport first and holds offscreen preflight until it is rendered', async () => {
    document.body.innerHTML = `<main>${Array.from({ length: 60 }, (_, i) => `<p id="p${i}">Readable paragraph number ${i}.</p>`).join('')}</main>`;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      const i = Number(this.id.slice(1));
      return {
        top: this.id === 'p40' ? 20 : i < 40 ? -100 : 3000,
        bottom: this.id === 'p40' ? 50 : i < 40 ? -50 : 3030,
        left: 0,
        right: 400,
      } as DOMRect;
    });
    const candidates: string[][] = [];
    const batches: Batch[] = [];
    let release: (() => void) | undefined;
    installRuntime((request) => {
      if (request.type === 'RESOLVE_TRANSLATION_CANDIDATES')
        candidates.push(request.candidates.map((c) => c.text));
      if (request.type !== 'TRANSLATE_BATCH') return;
      batches.push(request);
      if (!release)
        return new Promise((resolve) => {
          release = () => resolve(successful(request));
        });
      expect(document.querySelector('#p40 [data-justranslate-state="translated"]')).not.toBeNull();
    });
    const instance = controller();
    const work = instance.start();
    try {
      await vi.waitFor(() => expect(batches).toHaveLength(1));
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(candidates.flat()).toEqual(['Readable paragraph number 40.']);
      expect(batches[0].segments.map((s) => s.text)).toEqual(['Readable paragraph number 40.']);
    } finally {
      release?.();
      await work;
    }
    expect(instance.getStatus()).toMatchObject({ total: 60, translated: 60, failed: 0 });
  });

  it.each(['cache', 'skip', 'failure'] as const)(
    'releases offscreen work after visible %s without getting stuck',
    async (outcome) => {
      document.body.innerHTML =
        '<main><p id="visible">Visible source.</p><p id="offscreen">Offscreen source.</p></main>';
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
        this: HTMLElement,
      ) {
        const top = this.id === 'offscreen' ? 3000 : 10;
        return new DOMRect(0, top, 300, 20);
      });
      const batches: Batch[] = [];
      installRuntime((request) => {
        if (
          request.type === 'RESOLVE_TRANSLATION_CANDIDATES' &&
          request.candidates[0]?.text === 'Visible source.'
        ) {
          const id = request.candidates[0].id;
          if (outcome === 'failure')
            return Promise.resolve({ ok: false, error: 'Visible lookup failed' });
          return Promise.resolve({
            ok: true,
            data: {
              skippedIds: outcome === 'skip' ? [id] : [],
              cachedTranslations: outcome === 'cache' ? { [id]: '可视译文' } : {},
              missIds: [],
            },
          });
        }
        if (request.type === 'TRANSLATE_BATCH') batches.push(request);
      });
      const instance = controller();
      await instance.start();
      expect(batches.flatMap((batch) => batch.segments.map((s) => s.text))).toEqual([
        'Offscreen source.',
      ]);
      expect(instance.getStatus()).toMatchObject({
        translated: outcome === 'cache' ? 2 : 1,
        failed: outcome === 'failure' ? 1 : 0,
      });
    },
  );

  it('keeps offscreen preflight blocked while a fully streamed visible request is still finishing', async () => {
    document.body.innerHTML =
      '<main><p id="visible">Visible streamed source.</p><p id="offscreen">Offscreen waiting source.</p></main>';
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      return new DOMRect(0, this.id === 'offscreen' ? 3000 : 10, 300, 20);
    });
    const candidates: string[] = [];
    let batch!: Batch;
    let release!: () => void;
    installRuntime((request) => {
      if (request.type === 'RESOLVE_TRANSLATION_CANDIDATES')
        candidates.push(...request.candidates.map((c) => c.text));
      if (request.type !== 'TRANSLATE_BATCH' || request.priority !== 'visible') return;
      batch = request;
      return new Promise((resolve) => {
        release = () => resolve(successful(request));
      });
    });
    const instance = controller();
    const work = instance.start();
    try {
      await vi.waitFor(() => expect(batch).toBeDefined());
      const result = successful(batch);
      if (!result.ok) throw new Error('Expected successful test response');
      instance.receiveBatchProgress({
        type: 'TRANSLATION_BATCH_PROGRESS',
        batchId: batch.batchId,
        sessionId: batch.sessionId,
        translations: result.data.translations,
      });
      await vi.waitFor(() => expect(instance.getStatus().translated).toBe(1));
      expect(candidates).toEqual(['Visible streamed source.']);
    } finally {
      release();
      await work;
    }
    expect(instance.getStatus()).toMatchObject({ translated: 2, failed: 0 });
  });

  it('refills a released slot with the latest viewport after nested scrolling without cancellation', async () => {
    document.body.innerHTML = `<main>${Array.from({ length: 80 }, (_, i) => `<p id="p${i}">Scrollable paragraph number ${i}.</p>`).join('')}</main>`;
    let visibleId = '';
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      return {
        top: this.id === visibleId ? 20 : 3000,
        bottom: this.id === visibleId ? 50 : 3030,
        left: 0,
        right: 400,
      } as DOMRect;
    });
    const batches: Batch[] = [];
    const releases: Array<() => void> = [];
    const cancellations: RuntimeRequest[] = [];
    installRuntime((request) => {
      if (request.type === 'CANCEL_TRANSLATION_REQUESTS') cancellations.push(request);
      if (request.type !== 'TRANSLATE_BATCH') return;
      batches.push(request);
      return new Promise((resolve) => releases.push(() => resolve(successful(request))));
    });
    const instance = controller();
    const work = instance.start();
    try {
      await vi.waitFor(() => expect(batches).toHaveLength(6));
      visibleId = 'p60';
      document.querySelector('main')!.dispatchEvent(new Event('scroll'));
      visibleId = 'p70';
      document.querySelector('main')!.dispatchEvent(new Event('scroll'));
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(batches).toHaveLength(6);
      releases.shift()!();
      await vi.waitFor(() => expect(batches).toHaveLength(7));
      expect(batches[6].segments.map((s) => s.text)).toEqual(['Scrollable paragraph number 70.']);
      expect(batches[6].priority).toBe('visible');
      expect(cancellations).toHaveLength(0);
    } finally {
      instance.stop();
      releases.forEach((release) => release());
      await work;
    }
  });

  it('rechecks scrolling that occurred while a foreground candidate lookup was pending', async () => {
    document.body.innerHTML = `<main>${Array.from({ length: 40 }, (_, i) => `<p id="p${i}">Lookup paragraph ${i}.</p>`).join('')}</main>`;
    let visibleId = '';
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      return new DOMRect(0, this.id === visibleId ? 10 : 3000, 300, 20);
    });
    let releaseInitial: (() => void) | undefined;
    let releaseVisible: (() => void) | undefined;
    const sent: Batch[] = [];
    installRuntime((request) => {
      if (request.type === 'TRANSLATE_BATCH') sent.push(request);
      if (request.type !== 'RESOLVE_TRANSLATION_CANDIDATES') return;
      const result = {
        ok: true as const,
        data: {
          skippedIds: [],
          cachedTranslations: {},
          missIds: request.candidates.map((c) => c.id),
        },
      };
      if (!releaseInitial)
        return new Promise((resolve) => {
          releaseInitial = () => resolve(result);
        });
      if (request.candidates.some((c) => c.text === 'Lookup paragraph 20.'))
        return new Promise((resolve) => {
          releaseVisible = () => resolve(result);
        });
    });
    const instance = controller();
    const work = instance.start();
    try {
      await vi.waitFor(() => expect(releaseInitial).toBeDefined());
      visibleId = 'p20';
      document.dispatchEvent(new Event('scroll'));
      releaseInitial!();
      await vi.waitFor(() => expect(releaseVisible).toBeDefined());
      visibleId = 'p30';
      document.dispatchEvent(new Event('scroll'));
      releaseVisible!();
      await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0));
      expect(sent[0].segments.map((segment) => segment.text)).toEqual(['Lookup paragraph 30.']);
    } finally {
      instance.stop();
      releaseInitial?.();
      releaseVisible?.();
      await work;
    }
  });

  it('rescans changed raw prose after unwrapping its stale reading anchor', async () => {
    document.body.innerHTML =
      '<main><div>Original surrounding prose.<p>Nested stable paragraph.</p>Trailing readable prose.</div></main>';
    let first!: Batch;
    let release!: () => void;
    let requests = 0;
    installRuntime((request) => {
      if (request.type !== 'TRANSLATE_BATCH') return;
      if (++requests === 1) {
        first = request;
        return new Promise((resolve) => {
          release = () => resolve(successful(request));
        });
      }
      return Promise.resolve(successful(request));
    });
    const instance = controller();
    const work = instance.start();
    try {
      await vi.waitFor(() => expect(first).toBeDefined());
      const source = document.querySelector('[data-justranslate-reading-run]')!;
      source.querySelector('[data-justranslate-source-content]')!.firstChild!.textContent =
        'Updated surrounding prose.';
      await new Promise((resolve) => setTimeout(resolve, 0));
      release();
      await work;
      expect(document.body.textContent).toContain('译文 Updated surrounding prose.');
      expect(document.body.textContent).not.toContain('译文 Original surrounding prose.');
    } finally {
      instance.restore();
      release();
      await work;
    }
  });
  it('promotes an in-flight group when a newly visible duplicate joins it without sending again', async () => {
    document.body.innerHTML = '<main><p id="original">Shared background paragraph.</p></main>';
    vi.spyOn(document.querySelector('#original')!, 'getBoundingClientRect').mockReturnValue({
      top: 4000,
      bottom: 4020,
    } as DOMRect);
    let batch!: Batch;
    let release!: () => void;
    let requests = 0;
    installRuntime((request) => {
      if (request.type !== 'TRANSLATE_BATCH') return;
      requests += 1;
      batch = request;
      return new Promise((resolve) => {
        release = () => resolve(successful(request));
      });
    });
    const instance = controller();
    const work = instance.start();
    try {
      await vi.waitFor(() => expect(batch).toBeDefined());
      const added = document.createElement('p');
      added.textContent = 'Shared background paragraph.';
      document.querySelector('main')!.append(added);
      await vi.waitFor(
        () =>
          expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
            type: 'PROMOTE_TRANSLATION_BATCHES',
            sessionId: batch.sessionId,
            batchIds: [batch.batchId],
            priority: 'visible',
          }),
        { timeout: 1800 },
      );
      expect(requests).toBe(1);
    } finally {
      instance.stop();
      release();
      await work;
    }
  });
  it('starts a dynamic subtree microbatch before measuring its final candidates', async () => {
    document.body.innerHTML = '<main><p>Keep the original batch active.</p></main>';
    let release!: () => void;
    let tailMeasured = false;
    let measuredBeforeFirstDynamicRequest: boolean | undefined;
    installRuntime((request) => {
      if (request.type !== 'TRANSLATE_BATCH') return;
      if (request.segments.some((segment) => segment.text.startsWith('Keep'))) {
        return new Promise((resolve) => {
          release = () => resolve(successful(request));
        });
      }
      measuredBeforeFirstDynamicRequest ??= tailMeasured;
      return Promise.resolve(successful(request));
    });
    const instance = controller();
    const work = instance.start();
    try {
      await vi.waitFor(() => expect(release).toBeTypeOf('function'));
      const container = document.createElement('div');
      container.innerHTML = Array.from(
        { length: 60 },
        (_, i) => `<p>New dynamic reading paragraph ${i}.</p>`,
      ).join('');
      vi.spyOn(container.lastElementChild!, 'getBoundingClientRect').mockImplementation(() => {
        tailMeasured = true;
        return { top: 0, bottom: 20 } as DOMRect;
      });
      document.querySelector('main')!.append(container);
      await vi.waitFor(() => expect(measuredBeforeFirstDynamicRequest).toBe(false), {
        timeout: 1800,
      });
    } finally {
      instance.stop();
      release();
      await work;
    }
  });
  it('withdraws an admitted batch whose last consumer disappears without turning the page into an error', async () => {
    document.body.innerHTML = '<main><p>Remove this entire pending source.</p></main>';
    let batch!: Batch;
    let finish!: () => void;
    installRuntime((request) => {
      if (request.type === 'TRANSLATE_BATCH') {
        batch = request;
        return new Promise((resolve) => {
          finish = () => resolve({ ok: false, error: 'API 请求已取消' });
        });
      }
      if (request.type === 'CANCEL_TRANSLATION_BATCH') finish();
    });
    const instance = controller();
    const work = instance.start();
    try {
      await vi.waitFor(() => expect(batch).toBeDefined());
      document.querySelector('p')!.remove();
      await vi.waitFor(() =>
        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
          type: 'CANCEL_TRANSLATION_BATCH',
          sessionId: batch.sessionId,
          batchId: batch.batchId,
        }),
      );
      await work;
      expect(instance.getStatus()).toMatchObject({
        translated: 0,
        failed: 0,
        total: 0,
        phase: 'complete',
      });
    } finally {
      instance.stop();
      finish();
      await work;
    }
  });
  it('promotes backend-queued batches and their uncommitted reading slots when entering the viewport', async () => {
    document.body.innerHTML = `<main>${Array.from({ length: 8 }, (_, i) => `<p id="p${i}">Background reading paragraph ${i}.</p>`).join('')}</main>`;
    let visible: Element | undefined;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      return { top: this === visible ? 10 : 4000, bottom: this === visible ? 30 : 4020 } as DOMRect;
    });
    let callback!: IntersectionObserverCallback;
    const observed = new Set<Element>();
    const observer = {
      observe: (el: Element) => observed.add(el),
      unobserve: (el: Element) => observed.delete(el),
      disconnect: vi.fn(),
    };
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(cb: IntersectionObserverCallback) {
          callback = cb;
          return observer;
        }
      },
    );
    const batches: Batch[] = [];
    const releases: Array<() => void> = [];
    const promotions: RuntimeRequest[] = [];
    installRuntime((request) => {
      if (request.type === 'PROMOTE_TRANSLATION_BATCHES') promotions.push(request);
      if (request.type !== 'TRANSLATE_BATCH') return;
      batches.push(request);
      return new Promise((resolve) => releases.push(() => resolve(successful(request))));
    });
    const instance = controller();
    const work = instance.start();
    try {
      await vi.waitFor(() => expect(batches).toHaveLength(2));
      visible = document.querySelector('#p4')!;
      expect(observed.has(visible)).toBe(true);
      callback(
        [{ target: visible, isIntersecting: true } as IntersectionObserverEntry],
        observer as unknown as IntersectionObserver,
      );
      await vi.waitFor(() =>
        expect(promotions).toContainEqual({
          type: 'PROMOTE_TRANSLATION_BATCHES',
          sessionId: batches[1].sessionId,
          batchIds: [batches[1].batchId],
          priority: 'visible',
        }),
      );
      releases[1]();
      await vi.waitFor(() =>
        expect(visible?.querySelector('[data-justranslate-state="translated"]')).not.toBeNull(),
      );
      expect(document.querySelector('#p0 [data-justranslate-state="translated"]')).toBeNull();
    } finally {
      instance.stop();
      releases.forEach((release) => release());
      await work;
    }
  });
  it('keeps page mutations queued in the same event as a retry', async () => {
    document.body.innerHTML = '<main><p id="first">Original paragraph for retry.</p></main>';
    let failing = true;
    installRuntime((request) =>
      request.type === 'TRANSLATE_BATCH' && failing
        ? Promise.resolve({ ok: false, error: 'Test failure' })
        : undefined,
    );
    const instance = controller();
    await instance.start();
    failing = false;
    const added = document.createElement('p');
    added.textContent = 'Page content inserted synchronously before retry.';
    document.querySelector('main')!.append(added);
    await instance.retry(document.querySelector('#first')!);
    await vi.waitFor(
      () => expect(added.querySelector('[data-justranslate-state="translated"]')).not.toBeNull(),
      { timeout: 1800 },
    );
    expect(instance.getStatus()).toMatchObject({ translated: 2, total: 2 });
  });

  it('does not send queued groups after every source member was removed', async () => {
    document.body.innerHTML = `<main>${Array.from({ length: 28 }, (_, i) => `<p id="p${i}">Readable paragraph number ${i}.</p>`).join('')}</main>`;
    const sent: string[] = [];
    const releases: Array<() => void> = [];
    installRuntime((request) => {
      if (request.type !== 'TRANSLATE_BATCH') return;
      sent.push(...request.segments.map((s) => s.text));
      return new Promise((resolve) => releases.push(() => resolve(successful(request))));
    });
    const instance = controller();
    const work = instance.start();
    try {
      await vi.waitFor(() => expect(releases).toHaveLength(6));
      for (let i = 24; i < 28; i++) document.querySelector(`#p${i}`)!.remove();
      await new Promise((resolve) => setTimeout(resolve, 0));
      releases[0]();
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(sent.some((text) => /number 2[4-7]\./u.test(text))).toBe(false);
    } finally {
      instance.stop();
      releases.forEach((release) => release());
      await work;
    }
  });

  it('reuses source analysis instead of reading every inline style at each pipeline stage', async () => {
    document.body.innerHTML = `<main><p>${Array.from({ length: 100 }, (_, i) => `<span>word${i} </span>`).join('')}</p></main>`;
    const styles = vi.spyOn(window, 'getComputedStyle');
    installRuntime(() => undefined);
    await controller().start();
    expect(styles.mock.calls.length).toBeLessThan(450);
  });

  it('continues discovering and resolving later slices while the first preflight is pending', async () => {
    document.body.innerHTML = `<main>${Array.from({ length: 60 }, (_, i) => `<p>Readable paragraph ${i}.</p>`).join('')}</main>`;
    let release!: () => void;
    let resolutions = 0;
    let requests = 0;
    installRuntime((request) => {
      if (request.type === 'RESOLVE_TRANSLATION_CANDIDATES' && ++resolutions === 1) {
        return new Promise((resolve) => {
          release = () =>
            resolve({
              ok: true,
              data: {
                skippedIds: [],
                cachedTranslations: {},
                missIds: request.candidates.map((c) => c.id),
              },
            });
        });
      }
      if (request.type === 'TRANSLATE_BATCH') requests++;
    });
    const instance = controller();
    const work = instance.start();
    try {
      await vi.waitFor(() => expect(resolutions).toBeGreaterThan(1), { timeout: 500 });
      await vi.waitFor(() => expect(requests).toBeGreaterThan(0));
    } finally {
      release?.();
      await work;
    }
    expect(instance.getStatus()).toMatchObject({ total: 60, translated: 60, failed: 0 });
    expect(instance.getDiagnostics().firstTranslationMs).toBeGreaterThanOrEqual(0);
    expect(instance.getDiagnostics().batches.segments).toBe(60);
  });

  it('bounds unresolved preflight slices and discards their late results after stop', async () => {
    document.body.innerHTML = `<main>${Array.from({ length: 120 }, (_, i) => `<p>Uncached paragraph ${i}.</p>`).join('')}</main>`;
    const releases: Array<() => void> = [];
    let requests = 0;
    installRuntime((request) => {
      if (request.type === 'RESOLVE_TRANSLATION_CANDIDATES')
        return new Promise((resolve) =>
          releases.push(() =>
            resolve({
              ok: true,
              data: {
                skippedIds: [],
                cachedTranslations: {},
                missIds: request.candidates.map((c) => c.id),
              },
            }),
          ),
        );
      if (request.type === 'TRANSLATE_BATCH') requests++;
    });
    const instance = controller();
    const work = instance.start();
    try {
      await vi.waitFor(() => expect(releases).toHaveLength(3), { timeout: 500 });
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(releases).toHaveLength(3);
    } finally {
      instance.stop();
      releases.forEach((release) => release());
      await work;
    }
    expect(requests).toBe(0);
    expect(instance.getStatus()).toMatchObject({ phase: 'stopped', total: 0 });
  });

  it('finishes the page before cache acknowledgement but retains the session until the write settles', async () => {
    document.body.innerHTML =
      '<main><p>A translated page should not wait for cache persistence.</p></main>';
    let release!: () => void;
    let ended = false;
    installRuntime((request) => {
      if (request.type === 'STORE_TRANSLATION_CACHE')
        return new Promise((resolve) => {
          release = () => resolve({ ok: true, data: undefined });
        });
      if (request.type === 'END_TRANSLATION_SESSION') ended = true;
    });
    const instance = controller();
    const work = instance.start();
    try {
      await vi.waitFor(
        () => expect(instance.getStatus()).toMatchObject({ phase: 'complete', translated: 1 }),
        { timeout: 500 },
      );
      await work;
      expect(ended).toBe(false);
    } finally {
      release?.();
      await work;
    }
    await vi.waitFor(() => expect(ended).toBe(true));
  });

  it.each([false, true])(
    'retries only missing long-node pieces unless configuration changed (%s)',
    async (changed) => {
      document.body.innerHTML = `<main><p>${'Readable sentence with meaningful article content. '.repeat(65)}</p></main>`;
      let retrying = false;
      const sent: number[] = [];
      installRuntime((request) => {
        if (changed && retrying && request.type === 'BEGIN_TRANSLATION_SESSION')
          return Promise.resolve({
            ok: true,
            data: {
              configurationId: 'config-two',
              context: {
                profileId: SETTINGS.activeProfileId,
                targetLanguage: SETTINGS.targetLanguage,
              },
            },
          });
        if (request.type !== 'TRANSLATE_BATCH') return;
        if (retrying) sent.push(...request.segments.map((s) => s.partIndex));
        if (!retrying)
          return new Promise((resolve) =>
            setTimeout(
              () =>
                resolve(
                  request.segments.some((s) => s.partIndex === 1)
                    ? {
                        ok: true,
                        data: {
                          translations: {},
                          failures: Object.fromEntries(
                            request.segments.map((s) => [s.requestId, 'Missing part']),
                          ),
                        },
                      }
                    : successful(request),
                ),
              40,
            ),
          );
      });
      const instance = controller();
      await instance.start();
      expect(instance.getStatus().failed).toBe(1);
      retrying = true;
      await instance.retry(document.querySelector('p')!);
      expect(sent).toEqual(changed ? [0, 1, 2] : [1]);
      expect(instance.getStatus()).toMatchObject({ phase: 'complete', translated: 1 });
    },
  );

  it('retains mutations arriving during a manual retry and translates them afterwards', async () => {
    document.body.innerHTML = '<main><p>Original paragraph that fails first.</p></main>';
    let retrying = false;
    let release!: () => void;
    installRuntime((request) => {
      if (request.type !== 'TRANSLATE_BATCH') return;
      if (!retrying) return Promise.resolve({ ok: false, error: 'Test failure' });
      if (request.segments.some((s) => s.text.startsWith('Original')))
        return new Promise((resolve) => {
          release = () => resolve(successful(request));
        });
    });
    const instance = controller();
    await instance.start();
    retrying = true;
    const retry = instance.retry(document.querySelector('p')!);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const added = document.createElement('p');
    added.textContent = 'New article content arriving during retry.';
    document.querySelector('main')!.append(added);
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    await retry;
    await vi.waitFor(
      () => expect(added.querySelector('[data-justranslate-state="translated"]')).not.toBeNull(),
      { timeout: 1800 },
    );
  });

  it('shares successful part progress with a dynamic duplicate but retries only the clicked node', async () => {
    const text = 'Readable article sentence. '.repeat(55);
    document.body.innerHTML = `<main><p id="original">${text}</p></main>`;
    let retrying = false;
    let release!: () => void;
    const retried: number[] = [];
    installRuntime((request) => {
      if (request.type !== 'TRANSLATE_BATCH') return;
      if (retrying) retried.push(...request.segments.map((s) => s.partIndex));
      else if (request.segments.some((s) => s.partIndex === 1))
        return new Promise((resolve) => {
          release = () => resolve({ ok: false, error: 'Failed second part' });
        });
    });
    const instance = controller();
    const work = instance.start();
    try {
      await vi.waitFor(() => expect(release).toBeTypeOf('function'));
      const duplicate = document.createElement('p');
      duplicate.id = 'duplicate';
      duplicate.textContent = text;
      document.querySelector('main')!.append(duplicate);
      await vi.waitFor(
        () => expect(duplicate.querySelector('[data-justranslate-state="pending"]')).not.toBeNull(),
        { timeout: 1400 },
      );
      release();
      await work;
      retrying = true;
      await instance.retry(duplicate);
      expect(retried).toEqual([1]);
      expect(document.querySelector('#original [data-justranslate-state="error"]')).not.toBeNull();
      expect(duplicate.querySelector('[data-justranslate-state="translated"]')).not.toBeNull();
    } finally {
      release?.();
      await work;
    }
  });

  it('does not let a continuously changing sibling postpone a stable new paragraph', async () => {
    document.body.innerHTML = '<main><p>Initial article text.</p><div id="ticker"></div></main>';
    installRuntime(() => undefined);
    const instance = controller();
    await instance.start();
    const added = document.createElement('p');
    added.textContent = 'Stable newly published paragraph.';
    document.querySelector('main')!.append(added);
    const ticker = document.querySelector('#ticker')!;
    const timer = setInterval(() => {
      ticker.textContent = `Live ticker update ${Date.now()}.`;
    }, 100);
    try {
      await vi.waitFor(
        () => expect(added.querySelector('[data-justranslate-state="translated"]')).not.toBeNull(),
        { timeout: 1400 },
      );
    } finally {
      clearInterval(timer);
    }
  });
});
