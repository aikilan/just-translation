import { TEST_PROFILE } from '../test-utils/provider';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TranslationTaskService } from './translation-task';
import { DEFAULT_SETTINGS, type TranslatorSettings } from '../shared/settings';
import type { ActiveTranslator } from '../shared/translation-engines';
import { translateRuntimeBatch } from './translation-engine';
import type * as TranslationEngineModule from './translation-engine';

vi.mock('./translation-engine', async () => ({
  ...(await vi.importActual<typeof TranslationEngineModule>('./translation-engine')),
  translateRuntimeBatch: vi.fn(),
}));
const sender = (frameId = 0, documentId = 'doc'): chrome.runtime.MessageSender => ({
  tab: { id: 12 } as chrome.tabs.Tab,
  frameId,
  documentId,
  url: 'https://example.com/article',
});
const settings: TranslatorSettings = {
  ...DEFAULT_SETTINGS,
  profiles: [{ ...TEST_PROFILE, model: 'model' }],
  activeTranslator: { kind: 'ai', profileId: TEST_PROFILE.id },
  excludedSites: ['example.com'],
};
const AI_TRANSLATOR: ActiveTranslator = { kind: 'ai', profileId: TEST_PROFILE.id };
function setup(readSettings = () => Promise.resolve(settings)) {
  const getFrame = vi.fn(() => Promise.resolve({ documentId: 'doc' }));
  const service = new TranslationTaskService(readSettings, getFrame);
  vi.mocked(translateRuntimeBatch).mockImplementation((_config, segments) =>
    Promise.resolve({
      translations: Object.fromEntries(segments.map((segment) => [segment.requestId, '译文'])),
      failures: {},
    }),
  );
  return { service, getFrame };
}
afterEach(() => vi.clearAllMocks());

describe('selection translation isolation', () => {
  it('uses the selected profile thinking setting for selection translation', async () => {
    const { service } = setup(() =>
      Promise.resolve({
        ...settings,
        profiles: [{ ...settings.profiles[0], thinkingEnabled: false }],
      }),
    );
    await service.translateSelection(sender(), 'thinking-off', 'Hello', AI_TRANSLATOR);
    expect(translateRuntimeBatch).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'ai', thinkingEnabled: false }),
      expect.any(Array),
      expect.any(Object),
      expect.any(AbortSignal),
      expect.any(Object),
    );
  });
  it('translates exactly the selection, including on excluded sites and inside frames', async () => {
    const { service, getFrame } = setup();
    expect(
      await service.translateSelection(sender(3), 'one', '  First\nSecond  ', AI_TRANSLATOR),
    ).toEqual({
      text: '译文',
      targetLanguage: settings.targetLanguage,
      translatorName: TEST_PROFILE.name,
    });
    expect(getFrame).toHaveBeenCalledWith({ tabId: 12, frameId: 3 });
    expect(translateRuntimeBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'ai',
        model: 'model',
        targetLanguage: settings.targetLanguage,
      }),
      [{ requestId: 'selection', unitId: 'selection', partIndex: 0, text: '  First\nSecond  ' }],
      expect.any(Object),
      expect.any(AbortSignal),
      expect.objectContaining({ maxRetries: settings.translationRetryCount }),
    );
  });
  it('rejects empty text, missing configuration and stale documents before HTTP', async () => {
    const { service, getFrame } = setup();
    await expect(
      service.translateSelection(sender(), 'one', ' \n ', AI_TRANSLATOR),
    ).rejects.toThrow();
    getFrame.mockResolvedValue({ documentId: 'new-doc' });
    await expect(
      service.translateSelection(sender(), 'two', 'text', AI_TRANSLATOR),
    ).rejects.toThrow();
    const unconfigured = setup(() =>
      Promise.resolve({
        ...DEFAULT_SETTINGS,
        activeTranslator: { kind: 'ai', profileId: DEFAULT_SETTINGS.profiles[0].id },
      }),
    ).service;
    await expect(
      unconfigured.translateSelection(sender(), 'three', 'text', AI_TRANSLATOR),
    ).rejects.toThrow(/配置/);
    expect(translateRuntimeBatch).not.toHaveBeenCalled();
  });
  it('splits long free-engine selections into 1000-character requests and preserves order', async () => {
    const freeSettings: TranslatorSettings = {
      ...DEFAULT_SETTINGS,
      activeTranslator: { kind: 'builtin', engine: 'microsoft-free' },
      targetLanguage: 'English',
    };
    const { service } = setup(() => Promise.resolve(freeSettings));
    vi.mocked(translateRuntimeBatch).mockImplementation((_config, segments) =>
      Promise.resolve({
        translations: Object.fromEntries(
          segments.map((segment) => [segment.requestId, `[${segment.partIndex}]`]),
        ),
        failures: {},
      }),
    );
    await expect(
      service.translateSelection(
        sender(),
        'long',
        'x'.repeat(2_100),
        freeSettings.activeTranslator,
      ),
    ).resolves.toEqual({
      text: '[0][1][2]',
      targetLanguage: 'English',
      translatorName: 'Microsoft',
    });
    expect(vi.mocked(translateRuntimeBatch).mock.calls).toHaveLength(3);
    expect(
      vi
        .mocked(translateRuntimeBatch)
        .mock.calls.every(([, segments]) =>
          segments.every((segment) => segment.text.length <= 1_000),
        ),
    ).toBe(true);
  });
  it('keeps the established AI selection contract as one unsplit request', async () => {
    const { service } = setup();
    const text = 'x'.repeat(2_100);

    await service.translateSelection(sender(), 'long-ai', text, AI_TRANSLATOR);

    expect(translateRuntimeBatch).toHaveBeenCalledOnce();
    expect(translateRuntimeBatch).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'ai' }),
      [{ requestId: 'selection', unitId: 'selection', partIndex: 0, text }],
      expect.any(Object),
      expect.any(AbortSignal),
      expect.any(Object),
    );
  });
  it('cancels sibling selection batches as soon as one batch fails', async () => {
    const freeSettings: TranslatorSettings = {
      ...DEFAULT_SETTINGS,
      activeTranslator: { kind: 'builtin', engine: 'google-free' },
      targetLanguage: 'English',
      translationRetryCount: 0,
    };
    const { service } = setup(() => Promise.resolve(freeSettings));
    let siblingSignal: AbortSignal | undefined;
    vi.mocked(translateRuntimeBatch).mockImplementation(
      async (_config, segments, _client, signal) => {
        if (segments[0].partIndex === 0) throw new Error('first batch failed');
        siblingSignal = signal;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => reject(signal.reason instanceof Error ? signal.reason : new Error('aborted')),
            { once: true },
          );
        });
      },
    );

    await expect(
      service.translateSelection(
        sender(),
        'fanout',
        'x'.repeat(2_100),
        freeSettings.activeTranslator,
      ),
    ).rejects.toThrow('first batch failed');
    expect(siblingSignal?.aborted).toBe(true);
  });
  it('rejects a menu-bound translator that is no longer active before translation', async () => {
    const { service } = setup(() =>
      Promise.resolve({
        ...DEFAULT_SETTINGS,
        activeTranslator: { kind: 'builtin', engine: 'google-free' },
        targetLanguage: 'English',
      }),
    );

    await expect(
      service.translateSelection(sender(), 'stale', 'text', {
        kind: 'builtin',
        engine: 'microsoft-free',
      }),
    ).rejects.toThrow('翻译设置已改变');
    expect(translateRuntimeBatch).not.toHaveBeenCalled();
  });
  it('cancels even while settings are still loading', async () => {
    let release!: (value: typeof settings) => void;
    const { service } = setup(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = service.translateSelection(sender(), 'one', 'text', AI_TRANSLATOR);
    service.cancel(sender(), 'one', 'selection');
    release(settings);
    await expect(pending).rejects.toThrow(/取消/);
    expect(translateRuntimeBatch).not.toHaveBeenCalled();
  });
  it('isolates frame navigation, request IDs, and tab cleanup', async () => {
    const { service, getFrame } = setup();
    getFrame.mockImplementation((details?: { frameId: number }) =>
      Promise.resolve({ documentId: details?.frameId === 3 ? 'child' : 'doc' }),
    );
    const signals: AbortSignal[] = [];
    vi.mocked(translateRuntimeBatch).mockImplementation(
      async (_config, _segments, _client, signal) => {
        signals.push(signal!);
        return new Promise((_resolve, reject) =>
          signal!.addEventListener('abort', () => reject(new Error('cancelled'))),
        );
      },
    );
    const top = service
      .translateSelection(sender(), 'same', 'top', AI_TRANSLATOR)
      .catch(() => undefined);
    const frame = service
      .translateSelection(sender(3, 'child'), 'same', 'child', AI_TRANSLATOR)
      .catch(() => undefined);
    await vi.waitFor(() => expect(signals.length).toBe(2));
    service.navigate(12, 3, 'next');
    expect(signals[0].aborted).toBe(false);
    expect(signals[1].aborted).toBe(true);
    service.removeTab(12);
    await Promise.all([top, frame]);
    expect(signals[0].aborted).toBe(true);
  });
});
