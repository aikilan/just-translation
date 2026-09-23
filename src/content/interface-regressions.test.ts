// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TranslationController } from './controller';
import { collectTranslatableElements, getElementSourceText } from './dom-translator';
import type { RuntimeRequest, Result, PublicTranslatorSettings } from '../shared/messages';

let controller: TranslationController;
let settings: PublicTranslatorSettings;
let send: ReturnType<typeof vi.fn<(request: RuntimeRequest) => Promise<Result<unknown>>>>;
let finish: () => void;
let failure: string | undefined;
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
            translator: { kind: 'ai', profileId: 'p' },
            targetLanguage: settings.targetLanguage,
          },
          batchProfiles: {
            visible: { maxCharacters: 1_200, maxItems: 4 },
            readAhead: { maxCharacters: 1_800, maxItems: 4 },
            background: { maxCharacters: 2_400, maxItems: 4 },
          },
          maxConcurrency: settings.translationConcurrency,
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

it('keeps a same-text host write hidden behind the translated control label', async () => {
  document.body.innerHTML = '<main><button>创建班级</button></main>';
  const button = document.querySelector('button')!;
  const text = button.firstChild as Text;
  await controller.start();
  expect(text.data).toBe('');
  const batches = send.mock.calls.filter(([request]) => request.type === 'TRANSLATE_BATCH').length;
  text.data = '创建班级';
  await new Promise((resolve) => setTimeout(resolve, 1000));
  expect(button.textContent).toBe('普通译文 创建班级');
  expect(send.mock.calls.filter(([request]) => request.type === 'TRANSLATE_BATCH')).toHaveLength(
    batches,
  );
});

it.each([true, false])(
  'restoration preserves an explicit empty host write with dynamic=%s',
  async (dynamic) => {
    settings.translateDynamicContent = dynamic;
    document.body.innerHTML = '<main><button>创建班级</button></main>';
    const button = document.querySelector('button')!;
    const text = button.firstChild as Text;
    await controller.start();
    text.data = '';
    if (!dynamic) await new Promise((resolve) => setTimeout(resolve, 20));
    controller.restore();
    expect(button.textContent).toBe('');
  },
);

it('does not starve post-full additions when an excluded navigation ticker keeps changing', async () => {
  const { work } = await pending();
  finish();
  await work;
  document
    .querySelector('main')!
    .insertAdjacentHTML('beforeend', '<button id="late">创建班级</button>');
  const ticker = document.querySelector('nav')!;
  let tick = 0;
  const timer = setInterval(() => {
    ticker.textContent = `Tick ${tick++}`;
  }, 100);
  try {
    await new Promise((resolve) => setTimeout(resolve, 2200));
    expect(document.querySelector('#late [data-justranslate-state="translated"]')).not.toBeNull();
  } finally {
    clearInterval(timer);
  }
});

it('keeps main-scope exclusion consistent for new short interface labels', async () => {
  document.body.innerHTML =
    '<div id="chrome"><button>切换机构</button></div><main><p>Main content.</p></main>';
  await controller.start();
  expect(document.querySelector('#chrome [data-justranslate-translation]')).toBeNull();
  document
    .querySelector('#chrome')!
    .insertAdjacentHTML('beforeend', '<button id="outside">账号管理</button>');
  await new Promise((resolve) => setTimeout(resolve, 1100));
  expect(document.querySelector('#outside [data-justranslate-translation]')).toBeNull();
});

it('retains surrounding prose in a flex paragraph containing controls', () => {
  document.body.innerHTML =
    '<main><p style="display:flex">先选择 <button>班级</button> 再提交。</p></main>';
  expect(
    collectTranslatableElements(document.body, { isVisible: () => true }).map(getElementSourceText),
  ).toEqual(['先选择', '班级', '再提交。']);
});

it.each(['single', 'all'] as const)(
  'preserves full mode when stopped incremental %s retries need a rescan',
  async (retryMode) => {
    settings.translationRetryCount = 0;
    const { work } = await pending();
    finish();
    await work;
    const normal = send.getMockImplementation()!;
    send.mockImplementation((request) =>
      request.type === 'TRANSLATE_BATCH'
        ? Promise.resolve({ ok: false, error: { text: 'fail addition' } })
        : normal(request),
    );
    document
      .querySelector('main')!
      .insertAdjacentHTML('beforeend', '<p id="failed">Added original paragraph.</p>');
    await vi.waitFor(
      () => expect(controller.getStatus()).toMatchObject({ phase: 'error', failed: 1 }),
      { timeout: 2200 },
    );
    controller.stop();
    let release: (() => void) | undefined;
    let first = true;
    send.mockImplementation((request) => {
      if (request.type === 'TRANSLATE_BATCH' && first) {
        first = false;
        return new Promise((resolve) => {
          release = () => {
            void normal(request).then(resolve);
          };
        });
      }
      return normal(request);
    });
    const failedSource = document.querySelector<HTMLElement>('#failed')!;
    const retry =
      retryMode === 'all' ? controller.retryAllFailed() : controller.retry(failedSource);
    await vi.waitFor(() => expect(release).toBeDefined());
    const paragraph = document.querySelector('#failed')!;
    const original = paragraph.querySelector('[data-justranslate-source-text]')!.firstChild as Text;
    original.data = 'Changed original paragraph.';
    release!();
    await retry;
    expect(controller.getStatus().mode).toBe('full-document');
    expect(document.querySelector('h1 [data-justranslate-translation]')!.textContent).toBe(
      '译文 A complete article title',
    );
  },
);

it.each([false, true])('preserves a host clear after stop, synchronous=%s', async (synchronous) => {
  document.body.innerHTML = '<main><button>创建班级</button></main>';
  const text = document.querySelector('button')!.firstChild as Text;
  await controller.start();
  controller.stop();
  const count = send.mock.calls.length;
  text.data = '';
  if (!synchronous) await new Promise((resolve) => setTimeout(resolve, 20));
  controller.restore();
  expect(document.querySelector('button')!.textContent).toBe('');
  expect(send.mock.calls.length).toBe(count);
});

it('retains untouched label originals after stop and restores all text nodes in place', async () => {
  document.body.innerHTML = '<main><button>创建班级</button><button>添加学员</button></main>';
  const texts = [...document.querySelectorAll('button')].map((button) => button.firstChild);
  await controller.start();
  controller.stop();
  controller.restore();
  expect([...document.querySelectorAll('button')].map((button) => button.textContent)).toEqual([
    '创建班级',
    '添加学员',
  ]);
  expect([...document.querySelectorAll('button')].map((button) => button.firstChild)).toEqual(
    texts,
  );
});

it('commits full translation of flex prose and its control in reading order', async () => {
  document.body.innerHTML =
    '<main><p style="display:flex">先选择 <button>班级</button> 再提交。</p></main>';
  const { work } = await pending();
  const request = send.mock.calls
    .map(([request]) => request)
    .find((request) => request.type === 'TRANSLATE_FULL_DOCUMENT')!;
  expect(request.units.map((unit) => unit.text)).toEqual(['先选择', '班级', '再提交。']);
  finish();
  await work;
  expect(controller.getStatus()).toMatchObject({
    mode: 'full-document',
    phase: 'complete',
    translated: 3,
  });
});

it('preserves detached text changes without retaining observation after restoration', async () => {
  document.body.innerHTML = '<main><button>创建班级</button></main>';
  const button = document.querySelector('button')!;
  const text = button.firstChild as Text;
  await controller.start();
  controller.stop();
  text.remove();
  text.data = '';
  controller.restore();
  expect(text.data).toBe('');
  // Reusing the same host node starts a new ownership lifetime.
  button.append(text);
  text.data = '添加学员';
  await controller.start();
  expect(button.textContent).toBe('普通译文 添加学员');
  controller.restore();
  expect(button.textContent).toBe('添加学员');
});

it('translates a dynamically added custom reading block', async () => {
  document.body.innerHTML = '<main><p>Initial readable paragraph.</p></main>';
  await controller.start();

  document
    .querySelector('main')!
    .insertAdjacentHTML(
      'beforeend',
      '<x-paragraph id="dynamic-custom" style="display:block">Dynamically added custom paragraph.</x-paragraph>',
    );

  await vi.waitFor(
    () =>
      expect(
        document.querySelector('#dynamic-custom [data-justranslate-state="translated"]'),
      ).not.toBeNull(),
    { timeout: 2_200 },
  );
});

it.each([true, false])(
  'revalidates ownership changed during preflight with dynamic=%s',
  async (dynamic) => {
    settings.translateDynamicContent = dynamic;
    document.body.innerHTML =
      '<main><x-owner style="display:block">Before words <x-fragment id="fragment" style="display:inline">middle words</x-fragment> after words.</x-owner></main>';
    const normal = send.getMockImplementation()!;
    let release: (() => void) | undefined;
    send.mockImplementation((request) =>
      request.type === 'GET_PUBLIC_SETTINGS'
        ? new Promise((resolve) => {
            release = () => {
              void normal(request).then(resolve);
            };
          })
        : normal(request),
    );
    const work = controller.start();
    try {
      await vi.waitFor(() => expect(release).toBeDefined());
      document.querySelector<HTMLElement>('#fragment')!.style.display = 'block';
      release!();
      await work;
      expect(
        [...document.querySelectorAll<HTMLElement>('[data-justranslate-source]')].map(
          getElementSourceText,
        ),
      ).toEqual(['Before words', 'middle words', 'after words.']);
    } finally {
      release?.();
      controller.stop();
      await work;
    }
  },
);

it('preserves translated node identity after an attribute change with unchanged reading structure', async () => {
  document.body.innerHTML =
    '<main><x-owner style="display:block">Before words <x-fragment id="fragment">middle words</x-fragment> after words.</x-owner></main>';
  await controller.start();
  const translation = document.querySelector('[data-justranslate-translation]')!;
  const requests = send.mock.calls.filter(([request]) => request.type === 'TRANSLATE_BATCH').length;
  document.querySelector('#fragment')!.setAttribute('data-tracking-tick', '1');
  await new Promise((resolve) => setTimeout(resolve, 1050));
  expect(document.querySelector('[data-justranslate-translation]')).toBe(translation);
  expect(send.mock.calls.filter(([request]) => request.type === 'TRANSLATE_BATCH')).toHaveLength(
    requests,
  );
});

it('repartitions a same-text inline-to-block replacement inside a translated owner', async () => {
  document.body.innerHTML =
    '<main><x-owner style="display:block">Before words <span id="fragment">middle words</span> after words.</x-owner></main>';
  await controller.start();
  document.querySelector('#fragment')!.outerHTML =
    '<x-block style="display:block">middle words</x-block>';
  await vi.waitFor(
    () =>
      expect(
        [...document.querySelectorAll<HTMLElement>('[data-justranslate-source]')].map(
          getElementSourceText,
        ),
      ).toEqual(['Before words', 'middle words', 'after words.']),
    { timeout: 2200 },
  );
});

it('repartitions after removing a protected boundary that never had a translation record', async () => {
  document.body.innerHTML =
    '<main><x-owner style="display:block">Before words <x-fragment id="fragment" style="display:block"><code>PRIVATE_TOKEN</code></x-fragment> after words.</x-owner></main>';
  await controller.start();
  expect(document.querySelectorAll('[data-justranslate-source]')).toHaveLength(2);
  document.querySelector('#fragment')!.remove();
  await vi.waitFor(
    () =>
      expect(
        [...document.querySelectorAll<HTMLElement>('[data-justranslate-source]')].map(
          getElementSourceText,
        ),
      ).toEqual(['Before words after words.']),
    { timeout: 2200 },
  );
});

it('repartitions a translated custom block when a child changes from inline to block', async () => {
  document.body.innerHTML = `
    <main>
      <x-paragraph id="owner" style="display:block">Before words <x-fragment id="fragment" style="display:inline">middle words</x-fragment> after words.</x-paragraph>
    </main>
  `;
  await controller.start();
  expect(
    [...document.querySelectorAll<HTMLElement>('[data-justranslate-source]')].map(
      getElementSourceText,
    ),
  ).toEqual(['Before words middle words after words.']);

  document.querySelector<HTMLElement>('#fragment')!.style.display = 'block';

  await vi.waitFor(
    () =>
      expect(
        [...document.querySelectorAll<HTMLElement>('[data-justranslate-source]')].map(
          getElementSourceText,
        ),
      ).toEqual(['Before words', 'middle words', 'after words.']),
    { timeout: 2_200 },
  );
});

it('recombines translated custom runs when a child changes from block to inline', async () => {
  document.body.innerHTML = `
    <main>
      <x-paragraph id="owner" style="display:block">Before words <x-fragment id="fragment" style="display:block">middle words</x-fragment> after words.</x-paragraph>
    </main>
  `;
  await controller.start();
  expect(
    [...document.querySelectorAll<HTMLElement>('[data-justranslate-source]')].map(
      getElementSourceText,
    ),
  ).toEqual(['Before words', 'middle words', 'after words.']);

  document.querySelector<HTMLElement>('#fragment')!.style.display = 'inline';

  await vi.waitFor(
    () =>
      expect(
        [...document.querySelectorAll<HTMLElement>('[data-justranslate-source]')].map(
          getElementSourceText,
        ),
      ).toEqual(['Before words middle words after words.']),
    { timeout: 2_200 },
  );
});

it('recombines translated custom runs after a nested block is removed', async () => {
  document.body.innerHTML = `
    <main>
      <x-paragraph id="owner" style="display:block">Before words <x-fragment id="fragment" style="display:block">removed words</x-fragment> after words.</x-paragraph>
    </main>
  `;
  await controller.start();
  expect(
    [...document.querySelectorAll<HTMLElement>('[data-justranslate-source]')].map(
      getElementSourceText,
    ),
  ).toEqual(['Before words', 'removed words', 'after words.']);

  document.querySelector('#fragment')!.remove();

  await vi.waitFor(
    () =>
      expect(
        [...document.querySelectorAll<HTMLElement>('[data-justranslate-source]')].map(
          getElementSourceText,
        ),
      ).toEqual(['Before words after words.']),
    { timeout: 2_200 },
  );
});

it('removes and restores custom-element translation when host visibility changes', async () => {
  document.body.innerHTML = `
    <main><x-paragraph id="visibility-target" style="display:block">Visibility-aware custom paragraph.</x-paragraph></main>
  `;
  await controller.start();
  const target = document.querySelector<HTMLElement>('#visibility-target')!;
  expect(target.querySelector('[data-justranslate-state="translated"]')).not.toBeNull();

  target.hidden = true;
  await vi.waitFor(
    () => expect(target.querySelector('[data-justranslate-translation]')).toBeNull(),
    { timeout: 2_200 },
  );

  target.hidden = false;
  await vi.waitFor(
    () => expect(target.querySelector('[data-justranslate-state="translated"]')).not.toBeNull(),
    { timeout: 2_200 },
  );
});
