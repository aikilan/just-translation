import { renderMessage } from '../shared/i18n';
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicTranslatorSettings, RuntimeRequest, Result } from '../shared/messages';
import { TranslationController } from './controller';
let controller: TranslationController;
let settings: PublicTranslatorSettings;
let send: ReturnType<typeof vi.fn<(request: RuntimeRequest) => Promise<Result<unknown>>>>;
beforeEach(() => {
  settings = {
    uiLanguage: 'system',
    ready: true,
    supportsFullDocument: true,
    profiles: [{ id: 'one', name: 'One', configured: true, supportsImageInput: false }],
    activeTranslator: { kind: 'ai', profileId: 'one' },
    targetLanguage: 'English',
    displayMode: 'bilingual',
    translationConcurrency: 6,
    translationRetryCount: 1,
    fullDocumentTimeoutMinutes: 10,
    translateDynamicContent: true,
    autoTranslateSites: [],
    excludedSites: [],
  };
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue({ length: 1 } as DOMRectList);
  send = vi.fn(async (request: RuntimeRequest) => {
    await Promise.resolve();
    if (request.type === 'GET_PUBLIC_SETTINGS') return { ok: true, data: { ...settings } };
    if (request.type === 'BEGIN_TRANSLATION_SESSION')
      return {
        ok: true,
        data: {
          configurationId: settings.targetLanguage,
          context: {
            translator: settings.activeTranslator,
            targetLanguage: settings.targetLanguage,
          },
          batchProfiles: {
            visible: { maxCharacters: 6_000, maxItems: 6 },
            readAhead: { maxCharacters: 12_000, maxItems: 12 },
            background: { maxCharacters: 24_000, maxItems: 24 },
          },
          maxConcurrency: 6,
        },
      };
    if (request.type === 'RESOLVE_TRANSLATION_CANDIDATES')
      return {
        ok: true,
        data: {
          skippedIds: [],
          cachedTranslations: {},
          missIds: request.candidates.map((c) => c.id),
        },
      };
    if (request.type === 'TRANSLATE_BATCH')
      return {
        ok: true,
        data: {
          translations: Object.fromEntries(
            request.segments.map((s) => [s.requestId, `${settings.targetLanguage} result`]),
          ),
          failures: {},
        },
      };
    return { ok: true, data: undefined };
  });
  vi.stubGlobal('chrome', { runtime: { sendMessage: send } });
  document.body.innerHTML = '<main><p>Original text to translate.</p></main>';
  controller = new TranslationController();
});
afterEach(() => {
  controller.restore();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe('page translation context', () => {
  it('keeps an excluded page untouched even when started directly', async () => {
    settings.excludedSites = [location.hostname];
    const original = document.body.innerHTML;
    await controller.start();
    expect(document.body.innerHTML).toBe(original);
    expect(send.mock.calls.some(([request]) => request.type === 'BEGIN_TRANSLATION_SESSION')).toBe(
      false,
    );
    expect(renderMessage(controller.getStatus().error)).toContain('排除');
  });
  it('rejects a native-menu recipient that changed before page preflight', async () => {
    await controller.start({ kind: 'builtin', engine: 'google-free' });

    expect(send.mock.calls.some(([request]) => request.type === 'BEGIN_TRANSLATION_SESSION')).toBe(
      false,
    );
    expect(renderMessage(controller.getStatus().error)).toContain('设置已改变');
    expect(document.querySelectorAll('[data-justranslate-state="translated"]')).toHaveLength(0);
  });
  it('reports the actual configuration and requires explicit restart for a new language', async () => {
    await controller.start();
    expect(controller.getStatus().context).toEqual({
      translator: { kind: 'ai', profileId: 'one' },
      targetLanguage: 'English',
    });
    settings.targetLanguage = 'Japanese';
    const before = send.mock.calls.filter(([r]) => r.type === 'TRANSLATE_BATCH').length;
    await controller.start();
    expect(send.mock.calls.filter(([r]) => r.type === 'TRANSLATE_BATCH')).toHaveLength(before);
    expect(document.body.textContent).toContain('English result');
    expect(controller.getStatus().needsRestart).toBe(true);
    await controller.restart();
    expect(document.body.textContent).not.toContain('English result');
    expect(document.body.textContent).toContain('Japanese result');
    expect(controller.getStatus().context?.targetLanguage).toBe('Japanese');
  });
  it('does not resurrect context after a stopped session returns late', async () => {
    const original = send.getMockImplementation()!;
    let finish!: () => void;
    send.mockImplementation((request) =>
      request.type === 'BEGIN_TRANSLATION_SESSION'
        ? new Promise((resolve) => {
            finish = () =>
              resolve({
                ok: true,
                data: {
                  configurationId: 'late',
                  context: {
                    translator: { kind: 'ai', profileId: 'one' },
                    targetLanguage: 'English',
                  },
                  batchProfiles: {
                    visible: { maxCharacters: 6_000, maxItems: 6 },
                    readAhead: { maxCharacters: 12_000, maxItems: 12 },
                    background: { maxCharacters: 24_000, maxItems: 24 },
                  },
                  maxConcurrency: 6,
                },
              });
          })
        : original(request),
    );
    const running = controller.start();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    controller.restore();
    finish();
    await running;
    expect(controller.getStatus()).toMatchObject({ phase: 'idle', total: 0 });
    expect(controller.getStatus().context).toBeUndefined();
  });
  it('ignores an old preflight response after a new translation has completed', async () => {
    const original = send.getMockImplementation()!;
    let finish!: () => void;
    let firstRead = true;
    send.mockImplementation((request) => {
      if (request.type === 'GET_PUBLIC_SETTINGS' && firstRead) {
        firstRead = false;
        return new Promise((resolve) => {
          finish = () =>
            resolve({ ok: true, data: { ...settings, excludedSites: [location.hostname] } });
        });
      }
      return original(request);
    });
    const old = controller.start();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    await controller.restart();
    finish();
    await old;
    expect(controller.getStatus()).toMatchObject({ phase: 'complete', translated: 1 });
    expect(controller.getStatus().error).toBeUndefined();
  });
  it('reports the actual snapshot if preferences changed during preflight', async () => {
    const original = send.getMockImplementation()!;
    send.mockImplementation((request) => {
      if (request.type === 'BEGIN_TRANSLATION_SESSION') settings.targetLanguage = 'Japanese';
      return original(request);
    });
    await controller.start();
    expect(controller.getStatus().context?.targetLanguage).toBe('Japanese');
  });
  it('does not mix dynamic content after configuration changes', async () => {
    vi.useFakeTimers();
    await controller.start();
    settings.activeTranslator = { kind: 'ai', profileId: 'two' };
    document
      .querySelector('main')!
      .insertAdjacentHTML('beforeend', '<p>New dynamic paragraph.</p>');
    await vi.advanceTimersByTimeAsync(1000);
    expect(controller.getStatus().needsRestart).toBe(true);
    expect(document.querySelectorAll('[data-justranslate-state="translated"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-justranslate-state="pending"]')).toHaveLength(0);
  });
  it.each(['google-free', 'microsoft-free'] as const)(
    'translates initial and dynamic content with the selected %s engine identity',
    async (engine) => {
      vi.useFakeTimers();
      settings.activeTranslator = { kind: 'builtin', engine };
      settings.targetLanguage = 'English';
      settings.supportsFullDocument = false;
      await controller.start();
      document
        .querySelector('main')!
        .insertAdjacentHTML('beforeend', '<p>A newly loaded dynamic paragraph.</p>');
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() =>
        expect(document.querySelectorAll('[data-justranslate-state="translated"]')).toHaveLength(2),
      );
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'BEGIN_TRANSLATION_SESSION',
          translator: { kind: 'builtin', engine },
        }),
      );
    },
  );
  it('changes rendering without saving a preference or requesting translation', async () => {
    await controller.start();
    send.mockClear();
    controller.setDisplayMode('translation');
    expect(send).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLElement>('[data-justranslate-source-content]')?.hidden).toBe(
      true,
    );
    controller.restore();
    expect(document.body.textContent).toBe('Original text to translate.');
  });
});
