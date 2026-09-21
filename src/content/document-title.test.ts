// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicTranslatorSettings, Result, RuntimeRequest } from '../shared/messages';
import { TranslationController } from './controller';

let controller: TranslationController;
let settings: PublicTranslatorSettings;
let send: ReturnType<typeof vi.fn<(request: RuntimeRequest) => Promise<Result<unknown>>>>;
let fail: boolean;
let cached: boolean;
let release: (() => void) | undefined;
let delay: Promise<void> | undefined;
const title = 'An original page title';
const translated = (text: string) => `译文 ${text}`;

beforeEach(() => {
  document.head.innerHTML = `<title>${title}</title>`;
  document.body.innerHTML = '<main><p>A readable article paragraph.</p></main>';
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue({ length: 1 } as DOMRectList);
  settings = {
    configured: true,
    profiles: [{ id: 'p', name: 'AI', configured: true }],
    activeProfileId: 'p',
    targetLanguage: 'Chinese',
    displayMode: 'bilingual',
    translationConcurrency: 6,
    translationRetryCount: 1,
    translateDynamicContent: true,
    autoTranslateSites: [],
    excludedSites: [],
  };
  fail = false;
  cached = false;
  delay = undefined;
  release = undefined;
  send = vi.fn(async (request) => {
    if (request.type === 'GET_PUBLIC_SETTINGS') return { ok: true, data: settings };
    if (request.type === 'BEGIN_TRANSLATION_SESSION')
      return {
        ok: true,
        data: { configurationId: 'config', context: { profileId: 'p', targetLanguage: 'Chinese' } },
      };
    if (request.type === 'RESOLVE_TRANSLATION_CANDIDATES')
      return {
        ok: true,
        data: {
          missIds: cached ? [] : request.candidates.map((unit) => unit.id),
          skippedIds: [],
          cachedTranslations: cached
            ? Object.fromEntries(request.candidates.map((unit) => [unit.id, translated(unit.text)]))
            : {},
        },
      };
    if (request.type === 'TRANSLATE_BATCH') {
      await delay;
      return {
        ok: true,
        data: {
          translations: fail
            ? {}
            : Object.fromEntries(
                request.segments.map((unit) => [unit.requestId, translated(unit.text)]),
              ),
          failures: fail
            ? Object.fromEntries(request.segments.map((unit) => [unit.requestId, 'Failed']))
            : {},
        },
      };
    }
    if (request.type === 'TRANSLATE_FULL_DOCUMENT') {
      await delay;
      return fail
        ? { ok: false, error: 'Failed' }
        : {
            ok: true,
            data: Object.fromEntries(request.units.map((unit) => [unit.id, translated(unit.text)])),
          };
    }
    return { ok: true, data: undefined };
  });
  vi.stubGlobal('chrome', { runtime: { sendMessage: send } });
  controller = new TranslationController();
});
afterEach(() => {
  controller.restore();
  release?.();
  document.head.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const batches = () => send.mock.calls.map(([r]) => r).filter((r) => r.type === 'TRANSLATE_BATCH');
function hold() {
  delay = new Promise<void>((resolve) => {
    release = resolve;
  });
}

describe('document title translation', () => {
  it.each(['segmented', 'full-document'] as const)(
    'translates the tab title and restores the exact source in %s mode',
    async (mode) => {
      const source = document.querySelector('title')!;
      source.textContent = `  ${title}  `;
      await (mode === 'segmented' ? controller.start() : controller.startFullDocument());
      expect(document.title).toBe(translated(title));
      expect(source.children).toHaveLength(0);
      expect(controller.getStatus()).toMatchObject({ phase: 'complete', translated: 2, total: 2 });
      controller.setDisplayMode('translation');
      controller.setDisplayMode('bilingual');
      expect(document.title).toBe(translated(title));
      controller.restore();
      expect(source.textContent).toBe(`  ${title}  `);
    },
  );

  it('uses the existing candidate cache for the title', async () => {
    cached = true;
    await controller.start();
    expect(document.title).toBe(translated(title));
    expect(batches()).toHaveLength(0);
  });

  it('does not translate its own title writes again', async () => {
    await controller.start();
    const count = batches().length;
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(document.title).toBe(translated(title));
    expect(batches()).toHaveLength(count);
  });

  it.each(['text', 'element', 'insert'] as const)(
    'translates a dynamic title change via %s',
    async (change) => {
      if (change === 'insert') document.querySelector('title')!.remove();
      await controller.start();
      const next = 'A newly selected article';
      if (change === 'text') document.querySelector('title')!.firstChild!.nodeValue = next;
      else if (change === 'element') {
        const replacement = document.createElement('title');
        replacement.textContent = next;
        document.querySelector('title')!.replaceWith(replacement);
      } else document.title = next;
      await vi.waitFor(() => expect(document.title).toBe(translated(next)), { timeout: 3000 });
      controller.restore();
      expect(document.title).toBe(next);
    },
  );

  it.each([title, `  ${title}  `])(
    'reapplies the accepted translation when the host repeats %j',
    async (repeated) => {
      await controller.start();
      const count = batches().length;
      document.title = repeated;
      await vi.waitFor(() => expect(document.title).toBe(translated(title)));
      expect(batches()).toHaveLength(count);
      controller.restore();
      expect(document.querySelector('title')!.textContent).toBe(repeated);
    },
  );

  it('does not let an in-flight old title overwrite a new host title', async () => {
    hold();
    const work = controller.start();
    await vi.waitFor(() => expect(batches().length).toBeGreaterThan(0));
    document.title = 'New host title';
    release!();
    await work;
    await vi.waitFor(() => expect(document.title).toBe(translated('New host title')), {
      timeout: 3000,
    });
    controller.restore();
    expect(document.title).toBe('New host title');
  });

  it.each(['segmented', 'full-document'] as const)(
    'handles a title-only page in %s mode',
    async (mode) => {
      document.body.replaceChildren();
      await (mode === 'segmented' ? controller.start() : controller.startFullDocument());
      expect(document.title).toBe(translated(title));
      expect(document.querySelector('title')!.attributes).toHaveLength(0);
      expect(controller.getStatus()).toMatchObject({ total: 1, translated: 1 });
    },
  );

  it('preserves a host title written after translation is stopped', async () => {
    await controller.start();
    controller.stop();
    document.title = 'New host title';
    controller.restore();
    expect(document.title).toBe('New host title');
  });

  it('translates dynamic titles after a successful full-document handoff', async () => {
    await controller.startFullDocument();
    document.title = 'New host title';
    await vi.waitFor(() => expect(document.title).toBe(translated('New host title')), {
      timeout: 3000,
    });
    controller.restore();
    expect(document.title).toBe('New host title');
  });

  it('preserves a newer host title when restoring before the rescan', async () => {
    await controller.start();
    document.title = 'New host title';
    controller.restore();
    expect(document.title).toBe('New host title');
  });

  it('keeps a failed title intact and supports bulk retry', async () => {
    fail = true;
    await controller.start();
    expect(document.title).toBe(title);
    expect(controller.getStatus().failed).toBe(2);
    fail = false;
    await controller.retryAllFailed();
    expect(document.title).toBe(translated(title));
    expect(controller.getStatus().failed).toBe(0);
  });

  it.each(['segmented', 'full-document'] as const)(
    'ignores delayed results after restore in %s mode',
    async (mode) => {
      hold();
      const work = mode === 'segmented' ? controller.start() : controller.startFullDocument();
      await vi.waitFor(() =>
        expect(
          send.mock.calls.some(
            ([r]) =>
              r.type === (mode === 'segmented' ? 'TRANSLATE_BATCH' : 'TRANSLATE_FULL_DOCUMENT'),
          ),
        ).toBe(true),
      );
      controller.restore();
      release!();
      await work;
      expect(document.title).toBe(title);
    },
  );

  it('rejects a full snapshot whose title changed while awaiting the provider', async () => {
    hold();
    const work = controller.startFullDocument();
    await vi.waitFor(() =>
      expect(send.mock.calls.some(([r]) => r.type === 'TRANSLATE_FULL_DOCUMENT')).toBe(true),
    );
    document.title = 'New host title';
    release!();
    await work;
    expect(document.title).toBe('New host title');
    expect(controller.getStatus().phase).toBe('error');
    expect(document.querySelector('[data-justranslate-state="translated"]')).toBeNull();
  });

  it.each(['', '   '])('does not enqueue an empty title (%j)', async (value) => {
    document.title = value;
    await controller.start();
    expect(controller.getStatus()).toMatchObject({ total: 1, translated: 1 });
  });

  it('respects explicit title translation opt-out', async () => {
    document.querySelector('title')!.setAttribute('translate', 'no');
    await controller.start();
    expect(document.title).toBe(title);
    expect(controller.getStatus()).toMatchObject({ total: 1, translated: 1 });
  });
});
