import { renderMessage } from '../shared/i18n';
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TranslationController } from './controller';
import type { RuntimeRequest, Result, PublicTranslatorSettings } from '../shared/messages';

let controller: TranslationController;
let settings: PublicTranslatorSettings;
let send: ReturnType<typeof vi.fn<(request: RuntimeRequest) => Promise<Result<unknown>>>>;
let finish: () => void;
let failure: string | undefined;
const resultNodes = () => document.querySelectorAll('[data-justranslate-state="translated"]');
beforeEach(() => {
  settings = {
    uiLanguage: 'system',
    ready: true,
    supportsFullDocument: true,
    profiles: [{ id: 'p', name: 'AI', configured: true, supportsImageInput: false }],
    activeTranslator: { kind: 'ai', profileId: 'p' },
    targetLanguage: 'Chinese',
    displayMode: 'translation',
    translationConcurrency: 6,
    translationRetryCount: 1,
    fullDocumentTimeoutMinutes: 10,
    translateDynamicContent: true,
    autoTranslateSites: [],
    excludedSites: [],
  };
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue({ length: 1 } as DOMRectList);
  failure = undefined;
  document.body.innerHTML =
    '<nav>Skip this navigation.</nav><main><h1>A complete article title</h1><p>Same words.</p><p>They depend on the previous paragraph.</p><p>Same words.</p><p lang="zh">已经属于目标语言的上下文。</p><p>Keep <code>PRIVATE_TOKEN</code> here.</p></main>';
  send = vi.fn(async (request) => {
    await Promise.resolve();
    if (request.type === 'GET_PUBLIC_SETTINGS') return { ok: true, data: settings };
    if (request.type === 'BEGIN_TRANSLATION_SESSION')
      return {
        ok: true,
        data: {
          configurationId: 'config',
          context: {
            translator: settings.activeTranslator,
            targetLanguage: settings.targetLanguage,
          },
          batchProfiles: {
            visible: { maxCharacters: 1_200, maxItems: 4 },
            readAhead: { maxCharacters: 1_800, maxItems: 4 },
            background: { maxCharacters: 2_400, maxItems: 4 },
          },
          maxConcurrency: 6,
        },
      };
    if (request.type === 'RESOLVE_TRANSLATION_CANDIDATES')
      return {
        ok: true,
        data: {
          missIds: request.candidates.map((unit) => unit.id),
          skippedIds: [],
          cachedTranslations: {},
        },
      };
    if (request.type === 'TRANSLATE_BATCH')
      return {
        ok: true,
        data: {
          translations: Object.fromEntries(
            request.segments.map((unit) => [unit.requestId, `普通译文 ${unit.text}`]),
          ),
          failures: {},
        },
      };
    if (request.type === 'TRANSLATE_FULL_DOCUMENT')
      return new Promise((resolve) => {
        finish = () =>
          resolve(
            failure
              ? { ok: false, error: { text: failure } }
              : {
                  ok: true,
                  data: Object.fromEntries(request.units.map((u) => [u.id, `译文 ${u.text}`])),
                },
          );
      });
    return { ok: true, data: undefined };
  });
  vi.stubGlobal('chrome', { runtime: { sendMessage: send } });
  controller = new TranslationController();
});
afterEach(() => {
  controller.restore();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function pending() {
  const work = controller.startFullDocument();
  await vi.waitFor(() =>
    expect(send.mock.calls.some(([r]) => r.type === 'TRANSLATE_FULL_DOCUMENT')).toBe(true),
  );
  return { work };
}

describe('full document lifecycle', () => {
  it('shows independent progress when the first unit is a control, then removes it on success', async () => {
    document.body.innerHTML =
      '<main><button>Share this post</button><p>A visible paragraph.</p></main>';
    const { work } = await pending();
    const host = document.querySelector('[data-justranslate-full-status]')!;
    expect(host?.parentElement).toBe(document.documentElement);
    expect(host.getAttribute('translate')).toBe('no');
    expect(host.shadowRoot?.querySelector('[role="status"]')?.textContent).toContain('全文翻译');
    expect(document.querySelector('[data-justranslate-state="pending"]')).toBeNull();
    finish();
    await work;
    expect(document.querySelector('[data-justranslate-full-status]')).toBeNull();
  });
  it('rejects a built-in engine before collecting or sending the document', async () => {
    settings.activeTranslator = { kind: 'builtin', engine: 'google-free' };
    settings.supportsFullDocument = false;
    await controller.startFullDocument();
    expect(send.mock.calls.some(([request]) => request.type === 'BEGIN_TRANSLATION_SESSION')).toBe(
      false,
    );
    expect(renderMessage(controller.getStatus().error)).toContain('仅支持 AI');
  });

  it('captures all ordered original blocks, keeps repeats, and publishes only a complete result', async () => {
    const { work } = await pending();
    await controller.startFullDocument();
    const requests = send.mock.calls.map(([r]) => r);
    const request = requests.find((r) => r.type === 'TRANSLATE_FULL_DOCUMENT')!;
    expect(request.units).toHaveLength(6);
    expect(request.units.filter((u) => u.text === 'Same words.')).toHaveLength(2);
    expect(JSON.stringify(request)).not.toContain('PRIVATE_TOKEN');
    expect(JSON.stringify(request)).toContain('[[JT_KEEP_0]]');
    expect(requests.filter((r) => r.type === 'TRANSLATE_FULL_DOCUMENT')).toHaveLength(1);
    expect(
      requests.some(
        (r) => r.type === 'RESOLVE_TRANSLATION_CANDIDATES' || r.type === 'TRANSLATE_BATCH',
      ),
    ).toBe(false);
    expect(resultNodes()).toHaveLength(0);
    expect(document.querySelector('[data-justranslate-source-content][hidden]')).toBeNull();
    finish();
    await work;
    expect(resultNodes()).toHaveLength(6);
    expect(controller.getStatus()).toMatchObject({
      mode: 'full-document',
      phase: 'complete',
      total: 6,
      translated: 6,
    });
    expect(
      [...document.querySelectorAll('[data-justranslate-source]')].every((source) =>
        [
          ...source.querySelectorAll<HTMLElement>(':scope > [data-justranslate-source-content]'),
        ].every((child) => child.hidden),
      ),
    ).toBe(true);
    expect(send.mock.calls.some(([r]) => r.type === 'STORE_TRANSLATION_CACHE')).toBe(false);
    controller.restore();
    expect(document.querySelector('[data-justranslate-source]')).toBeNull();
    expect(document.body.textContent).toContain('PRIVATE_TOKEN');
  });

  it.each(['remove', 'edit', 'reorder', 'protected', 'first'] as const)(
    'discards the full result after source %s',
    async (kind) => {
      const { work } = await pending();
      const main = document.querySelector('main')!;
      if (kind === 'protected') main.querySelector('code')!.textContent = 'CHANGED_TOKEN';
      if (kind === 'first') main.firstElementChild!.append(' Changed.');
      if (kind === 'remove') main.lastElementChild!.remove();
      if (kind === 'edit') main.lastElementChild!.append(' Changed.');
      if (kind === 'reorder') main.append(main.children[1]);
      finish();
      await work;
      expect(resultNodes()).toHaveLength(0);
      expect(renderMessage(controller.getStatus().error)).toContain('正文已变化');
      expect(document.querySelector('[data-justranslate-source-content][hidden]')).toBeNull();
    },
  );

  it('cancels once and ignores a late result', async () => {
    const { work } = await pending();
    controller.stop();
    finish();
    await work;
    expect(controller.getStatus().phase).toBe('stopped');
    expect(resultNodes()).toHaveLength(0);
    expect(document.querySelector('[data-justranslate-translation]')).toBeNull();
    expect(send.mock.calls.some(([r]) => r.type === 'CANCEL_TRANSLATION_REQUESTS')).toBe(true);
  });

  it('retries the entire document from its native button without changing page text', async () => {
    failure = 'PRIVATE_PROVIDER_ERROR';
    const { work } = await pending();
    finish();
    await work;
    expect(resultNodes()).toHaveLength(0);
    expect(document.body.textContent).not.toContain('PRIVATE_PROVIDER_ERROR');
    const control = document
      .querySelector('[data-justranslate-full-status]')!
      .shadowRoot!.querySelector('button')!;
    expect(control.textContent).toBe('重新全文翻译');
    expect(control.type).toBe('button');
    failure = undefined;
    control.click();
    await vi.waitFor(() =>
      expect(send.mock.calls.filter(([r]) => r.type === 'TRANSLATE_FULL_DOCUMENT')).toHaveLength(2),
    );
    finish();
    await vi.waitFor(() => expect(controller.getStatus().phase).toBe('complete'));
    expect(resultNodes()).toHaveLength(6);
  });

  it('incrementally translates new content after full completion', async () => {
    const { work } = await pending();
    finish();
    await work;
    document
      .querySelector('main')!
      .insertAdjacentHTML('beforeend', '<p>Later reading content.</p>');
    await vi.waitFor(
      () => {
        expect(renderMessage(controller.getStatus().error)).toBe('');
        expect(resultNodes()).toHaveLength(7);
      },
      { timeout: 2200 },
    );
    expect(send.mock.calls.filter(([r]) => r.type === 'TRANSLATE_FULL_DOCUMENT')).toHaveLength(1);
    expect(controller.getStatus()).toMatchObject({
      mode: 'full-document',
      total: 7,
      translated: 7,
    });
    expect(send.mock.calls.filter(([r]) => r.type === 'TRANSLATE_BATCH')).toHaveLength(1);
  });

  it('restarts with new settings in full mode and keeps originals visible while switching display modes', async () => {
    const { work } = await pending();
    controller.setDisplayMode('bilingual');
    controller.setDisplayMode('translation');
    expect(document.querySelector('[data-justranslate-source-content][hidden]')).toBeNull();
    finish();
    await work;
    settings.targetLanguage = 'Japanese';
    const restarted = controller.restart();
    await vi.waitFor(() =>
      expect(send.mock.calls.filter(([r]) => r.type === 'TRANSLATE_FULL_DOCUMENT')).toHaveLength(2),
    );
    expect(resultNodes()).toHaveLength(0);
    finish();
    await restarted;
    expect(controller.getStatus().context?.targetLanguage).toBe('Japanese');
    expect(controller.getStatus().mode).toBe('full-document');
  });

  it('stops before a late BEGIN response without submitting the document', async () => {
    let release!: () => void;
    const normalSend = send.getMockImplementation()!;
    send.mockImplementation((request) =>
      request.type === 'BEGIN_TRANSLATION_SESSION'
        ? new Promise((resolve) => {
            release = () =>
              resolve({
                ok: true,
                data: {
                  configurationId: 'config',
                  context: {
                    translator: { kind: 'ai', profileId: 'p' },
                    targetLanguage: settings.targetLanguage,
                  },
                  batchProfiles: {
                    visible: { maxCharacters: 1_200, maxItems: 4 },
                    readAhead: { maxCharacters: 1_800, maxItems: 4 },
                    background: { maxCharacters: 2_400, maxItems: 4 },
                  },
                  maxConcurrency: 6,
                },
              });
          })
        : normalSend(request),
    );
    const work = controller.startFullDocument();
    await vi.waitFor(() => expect(release).toBeDefined());
    controller.stop();
    release();
    await work;
    expect(send.mock.calls.some(([r]) => r.type === 'TRANSLATE_FULL_DOCUMENT')).toBe(false);
    expect(send.mock.calls.some(([r]) => r.type === 'END_TRANSLATION_SESSION')).toBe(true);
    expect(controller.getStatus().phase).toBe('stopped');
  });

  it('switches to ordinary translation and ignores the old full response', async () => {
    const { work } = await pending();
    const ordinary = controller.start();
    finish();
    await work;
    await ordinary;
    expect(controller.getStatus()).toMatchObject({
      mode: 'segmented',
      phase: 'complete',
      translated: 6,
    });
    expect(resultNodes()).toHaveLength(6);
    expect([...resultNodes()].every((node) => node.textContent?.startsWith('普通译文'))).toBe(true);
    expect(
      send.mock.calls.some(
        ([r]) => r.type === 'BEGIN_TRANSLATION_SESSION' && r.mode === 'segmented',
      ),
    ).toBe(true);
  });

  it('rolls back staged writes if the source changes during frame-based rendering', async () => {
    const { work } = await pending();
    const observer = new MutationObserver(() => {
      if (resultNodes().length) {
        observer.disconnect();
        document.querySelector('main')!.querySelector('p')!.append(' Changed during commit.');
        expect(document.documentElement.hasAttribute('data-justranslate-full-pending')).toBe(true);
        expect(document.querySelector('[data-justranslate-source-content][hidden]')).toBeNull();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    finish();
    await work;
    observer.disconnect();
    expect(resultNodes()).toHaveLength(0);
    expect(renderMessage(controller.getStatus().error)).toContain('正文已变化');
  });

  it('cancels during staged rendering without exposing any translated result', async () => {
    const { work } = await pending();
    const observer = new MutationObserver(() => {
      if (resultNodes().length) {
        observer.disconnect();
        controller.stop();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    finish();
    await work;
    observer.disconnect();
    expect(resultNodes()).toHaveLength(0);
    expect(controller.getStatus().phase).toBe('stopped');
  });

  it('rejects changed original text in an already-scanned branch during final validation', async () => {
    const { work } = await pending();
    const main = document.querySelector('main')!;
    const last = main.lastElementChild;
    let changed = false;
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (!changed && this === last && resultNodes().length === 6) {
        changed = true;
        main.querySelector('h1')!.append(' Changed during validation.');
      }
      return { length: 1 } as DOMRectList;
    });
    finish();
    await work;
    expect(changed).toBe(true);
    expect(resultNodes()).toHaveLength(0);
    expect(renderMessage(controller.getStatus().error)).toContain('正文已变化');
  });

  it('keeps the full retry independent of restored raw prose', async () => {
    document.body.innerHTML =
      '<main><div>Opening raw prose before the nested paragraph.<p>A separate paragraph.</p>Closing raw prose after the paragraph.</div></main>';
    failure = 'Failed response';
    const { work } = await pending();
    finish();
    await work;
    const host = document.querySelector('[data-justranslate-full-status]')!;
    expect(host.parentElement).toBe(document.documentElement);
    expect(host.shadowRoot?.querySelector('button')?.textContent).toBe('重新全文翻译');
    expect(document.querySelectorAll('[data-justranslate-state="error"]')).toHaveLength(0);
  });

  it('does not touch an excluded page or open a translation session', async () => {
    settings.excludedSites = [location.hostname];
    const original = document.body.innerHTML;
    await controller.startFullDocument();
    expect(document.body.innerHTML).toBe(original);
    expect(send.mock.calls.some(([r]) => r.type === 'BEGIN_TRANSLATION_SESSION')).toBe(false);
  });
  it('accepts an unchanged article while an excluded navigation element changes its class', async () => {
    const { work } = await pending();
    const before = document.querySelector('main')!.cloneNode(true) as HTMLElement;
    before.querySelectorAll('[data-justranslate-translation]').forEach((node) => node.remove());
    const original = before.textContent;
    const last = document.querySelector('main')!.lastElementChild;
    let tick = 0;
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this === last) document.querySelector('nav')!.className = `frame-${++tick}`;
      return { length: 1 } as DOMRectList;
    });
    finish();
    await work;
    const after = document.querySelector('main')!.cloneNode(true) as HTMLElement;
    after.querySelectorAll('[data-justranslate-translation]').forEach((node) => node.remove());
    expect(after.textContent).toBe(original);
    expect(controller.getStatus().phase, JSON.stringify({ ...controller.getStatus(), tick })).toBe(
      'complete',
    );
    expect(resultNodes()).toHaveLength(6);
  });

  it('rejects a source which is split into distinct paragraphs without changing flattened text', async () => {
    document.body.innerHTML =
      '<main><div class="article-text">First paragraph. Second paragraph.</div><p>Another reading paragraph.</p></main>';
    const { work } = await pending();
    const source = document.querySelector('.article-text')!;
    source.innerHTML = '<p>First paragraph. </p><p>Second paragraph.</p>';
    finish();
    await work;
    expect(controller.getStatus().phase, JSON.stringify(controller.getStatus())).toBe('error');
    expect(resultNodes()).toHaveLength(0);
  });
  it('allows inline wrappers without changing the reading units', async () => {
    const { work } = await pending();
    document.querySelector('h1')!.innerHTML = '<span>A complete article title</span>';
    finish();
    await work;
    expect(controller.getStatus()).toMatchObject({ phase: 'complete', translated: 6 });
  });

  it.each(['raw', 'new-scope', 'visibility'] as const)(
    'queues added reading membership but rejects lost eligibility: %s',
    async (change) => {
      const { work } = await pending();
      if (change === 'raw') document.querySelector('main')!.prepend('New opening raw prose.');
      if (change === 'new-scope')
        document.body.insertAdjacentHTML(
          'beforeend',
          '<main><p>Another article appeared.</p></main>',
        );
      if (change === 'visibility') document.querySelector('h1')!.hidden = true;
      finish();
      await work;
      if (change === 'visibility') {
        expect(renderMessage(controller.getStatus().error)).toContain('正文已变化');
        expect(resultNodes()).toHaveLength(0);
      } else {
        expect(controller.getStatus().error).toBeUndefined();
        await vi.waitFor(() => expect(resultNodes()).toHaveLength(7), { timeout: 2200 });
      }
    },
  );
  it('accepts a layout-only change when the same reading leaf remains eligible', async () => {
    const { work } = await pending();
    document.querySelector('h1')!.style.display = 'grid';
    finish();
    await work;
    expect(controller.getStatus()).toMatchObject({ phase: 'complete', translated: 6 });
  });

  it('rechecks fragment visibility controlled by arbitrary host attributes', async () => {
    document.body.innerHTML =
      '<style>[data-state="hidden"] span { display:none }</style><main><h1>A stable headline</h1><p>Visible paragraph with <span>changing contextual words</span>.</p></main>';
    const { work } = await pending();
    document.querySelector('p')!.dataset.state = 'hidden';
    finish();
    await work;
    expect(renderMessage(controller.getStatus().error)).toContain('正文已变化');
    expect(resultNodes()).toHaveLength(0);
  });
});

describe('full snapshot to incremental handoff', () => {
  it('queues additions during the first request and adopts completed sources without retranslating them', async () => {
    const { work } = await pending();
    document.querySelector('main')!.insertAdjacentHTML('beforeend', '<button>创建班级</button>');
    finish();
    await work;
    expect(controller.getStatus().error).toBeUndefined();
    await vi.waitFor(() => expect(resultNodes()).toHaveLength(7), { timeout: 2200 });
    const batches = send.mock.calls.map(([r]) => r).filter((r) => r.type === 'TRANSLATE_BATCH');
    expect(batches.flatMap((r) => r.segments.map((s) => s.text))).toEqual(['创建班级']);
    await vi.waitFor(() =>
      expect(controller.getStatus()).toMatchObject({
        mode: 'full-document',
        phase: 'complete',
        translated: 7,
      }),
    );
  });

  it('respects the dynamic toggle and stops observing after stop', async () => {
    settings.translateDynamicContent = false;
    const { work } = await pending();
    finish();
    await work;
    document.querySelector('main')!.insertAdjacentHTML('beforeend', '<p>New disabled content.</p>');
    await new Promise((resolve) => setTimeout(resolve, 950));
    expect(send.mock.calls.some(([r]) => r.type === 'TRANSLATE_BATCH')).toBe(false);
    controller.stop();
    expect(controller.getStatus().phase).toBe('stopped');
    expect(resultNodes()).toHaveLength(6);
  });

  it('retranslates edited originals after full completion and preserves other translations', async () => {
    const { work } = await pending();
    finish();
    await work;
    const heading = document.querySelector('h1')!;
    heading.textContent = 'Changed heading';
    await vi.waitFor(
      () =>
        expect(heading.querySelector('[data-justranslate-state="translated"]')?.textContent).toBe(
          '普通译文 Changed heading',
        ),
      { timeout: 2200 },
    );
    expect(resultNodes()).toHaveLength(6);
    expect(send.mock.calls.filter(([r]) => r.type === 'TRANSLATE_FULL_DOCUMENT')).toHaveLength(1);
  });

  it('pauses incremental requests when the configuration fingerprint changes', async () => {
    const { work } = await pending();
    finish();
    await work;
    const normal = send.getMockImplementation()!;
    send.mockImplementation((request) =>
      request.type === 'BEGIN_TRANSLATION_SESSION'
        ? Promise.resolve({
            ok: true,
            data: {
              configurationId: 'new-config',
              context: {
                translator: { kind: 'ai', profileId: 'p' },
                targetLanguage: settings.targetLanguage,
              },
              batchProfiles: {
                visible: { maxCharacters: 1_200, maxItems: 4 },
                readAhead: { maxCharacters: 1_800, maxItems: 4 },
                background: { maxCharacters: 2_400, maxItems: 4 },
              },
              maxConcurrency: 6,
            },
          })
        : normal(request),
    );
    document
      .querySelector('main')!
      .insertAdjacentHTML('beforeend', '<p>New content after settings edit.</p>');
    await vi.waitFor(() => expect(controller.getStatus().needsRestart).toBe(true), {
      timeout: 2200,
    });
    expect(send.mock.calls.some(([r]) => r.type === 'TRANSLATE_BATCH')).toBe(false);
    expect(resultNodes()).toHaveLength(6);
  });
});

it('preserves successful full translations when incremental requests fail and retries only additions', async () => {
  settings.translationRetryCount = 0;
  const { work } = await pending();
  finish();
  await work;
  const normal = send.getMockImplementation()!;
  let failBatch = true;
  send.mockImplementation((request) =>
    request.type === 'TRANSLATE_BATCH' && failBatch
      ? Promise.resolve({ ok: false, error: { text: 'Incremental failure' } })
      : normal(request),
  );
  document.querySelector('main')!.insertAdjacentHTML('beforeend', '<button>添加学员</button>');
  await vi.waitFor(
    () => expect(controller.getStatus()).toMatchObject({ failed: 1, phase: 'error' }),
    { timeout: 2200 },
  );
  expect(resultNodes()).toHaveLength(6);
  expect(controller.getStatus()).toMatchObject({
    mode: 'full-document',
    stage: 'incremental',
    phase: 'error',
  });
  expect(document.querySelector('button')!.textContent).toBe('添加学员');
  failBatch = false;
  await controller.retryAllFailed();
  expect(controller.getStatus()).toMatchObject({ failed: 0, translated: 7, phase: 'complete' });
  expect(send.mock.calls.filter(([r]) => r.type === 'TRANSLATE_FULL_DOCUMENT')).toHaveLength(1);
});

it('cancels incremental work and ignores late results while preserving the completed snapshot', async () => {
  const { work } = await pending();
  finish();
  await work;
  const normal = send.getMockImplementation()!;
  let release: (() => void) | undefined;
  send.mockImplementation((request) =>
    request.type === 'TRANSLATE_BATCH'
      ? new Promise((resolve) => {
          release = () => {
            void normal(request).then(resolve);
          };
        })
      : normal(request),
  );
  document.querySelector('main')!.insertAdjacentHTML('beforeend', '<p>Late content.</p>');
  await vi.waitFor(() => expect(release).toBeDefined(), { timeout: 2200 });
  controller.stop();
  release!();
  await new Promise((resolve) => setTimeout(resolve, 950));
  expect(controller.getStatus()).toMatchObject({ phase: 'stopped', translated: 6 });
  expect(resultNodes()).toHaveLength(6);
  document.querySelector('main')!.insertAdjacentHTML('beforeend', '<p>After stop.</p>');
  await new Promise((resolve) => setTimeout(resolve, 950));
  expect(send.mock.calls.filter(([r]) => r.type === 'TRANSLATE_BATCH')).toHaveLength(1);
  controller.restore();
  expect(resultNodes()).toHaveLength(0);
});

it('keeps a stop at the atomic commit boundary from re-enabling observation', async () => {
  const { work } = await pending();
  const observer = new MutationObserver(() => {
    if (
      !document.documentElement.hasAttribute('data-justranslate-full-pending') &&
      resultNodes().length === 6
    ) {
      observer.disconnect();
      controller.stop();
    }
  });
  observer.observe(document.documentElement, { attributes: true });
  finish();
  await work;
  observer.disconnect();
  expect(controller.getStatus().phase).toBe('stopped');
  document.querySelector('main')!.insertAdjacentHTML('beforeend', '<p>After atomic stop.</p>');
  await new Promise((resolve) => setTimeout(resolve, 950));
  expect(send.mock.calls.some(([r]) => r.type === 'TRANSLATE_BATCH')).toBe(false);
});

it('rejects captured text changed between the atomic reveal and controller handoff', async () => {
  const { work } = await pending();
  const observer = new MutationObserver(() => {
    if (
      !document.documentElement.hasAttribute('data-justranslate-full-pending') &&
      resultNodes().length === 6
    ) {
      observer.disconnect();
      document.querySelector('h1')!.textContent = 'Changed at handoff';
    }
  });
  observer.observe(document.documentElement, { attributes: true });
  finish();
  await work;
  observer.disconnect();
  expect(controller.getStatus().phase).toBe('error');
  expect(renderMessage(controller.getStatus().error)).toContain('正文已变化');
  expect(resultNodes()).toHaveLength(0);
});

it('switches from an active ordinary request to full translation and ignores its late result', async () => {
  const normal = send.getMockImplementation()!;
  const releases: Array<() => void> = [];
  send.mockImplementation((request) =>
    request.type === 'TRANSLATE_BATCH'
      ? new Promise((resolve) => {
          releases.push(() => {
            void normal(request).then(resolve);
          });
        })
      : normal(request),
  );
  const ordinary = controller.start();
  await vi.waitFor(() => expect(releases.length).toBeGreaterThan(0));
  const full = controller.startFullDocument();
  await vi.waitFor(() =>
    expect(send.mock.calls.some(([r]) => r.type === 'TRANSLATE_FULL_DOCUMENT')).toBe(true),
  );
  releases.forEach((release) => release());
  finish();
  await ordinary;
  await full;
  expect(controller.getStatus()).toMatchObject({
    mode: 'full-document',
    phase: 'complete',
    translated: 6,
  });
  expect([...resultNodes()].every((node) => node.textContent?.startsWith('译文 '))).toBe(true);
});
