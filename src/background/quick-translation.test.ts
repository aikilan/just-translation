import { afterEach, describe, expect, it, vi } from 'vitest';
import { TranslationTaskService } from './translation-task';
import { DEFAULT_SETTINGS, type TranslatorSettings } from '../shared/settings';
import { TEST_PROFILE } from '../test-utils/provider';
import { translateRuntimeBatch } from './translation-engine';
import type * as TranslationEngineModule from './translation-engine';

vi.mock('./translation-engine', async () => ({
  ...(await vi.importActual<typeof TranslationEngineModule>('./translation-engine')),
  translateRuntimeBatch: vi.fn(),
}));
const sender: chrome.runtime.MessageSender = {
  tab: { id: 42 } as chrome.tabs.Tab,
  frameId: 0,
  documentId: 'document',
  url: 'https://example.com',
};
const settings: TranslatorSettings = {
  ...DEFAULT_SETTINGS,
  activeTranslator: { kind: 'builtin', engine: 'google-free' },
  profiles: [{ ...TEST_PROFILE, model: 'test-model', apiKey: 'quick-test-secret' }],
  targetLanguage: 'Simplified Chinese',
  excludedSites: ['example.com'],
};
function setup(read = () => Promise.resolve(settings)) {
  const getFrame = vi.fn().mockResolvedValue({ documentId: 'document' });
  const service = new TranslationTaskService(read, getFrame);
  vi.mocked(translateRuntimeBatch).mockImplementation((_config, segments) =>
    Promise.resolve({
      translations: Object.fromEntries(
        segments.map((segment) => [segment.requestId, 'translated']),
      ),
      failures: {},
    }),
  );
  return { service, getFrame };
}
afterEach(() => vi.clearAllMocks());

describe('quick translation request scope', () => {
  it('uses a configured local engine and language without changing global settings or requiring a page session', async () => {
    const before = structuredClone(settings);
    const { service } = setup();
    const result = await service.translateQuick(
      sender,
      'quick',
      '  First\nSecond  ',
      { kind: 'ai', profileId: TEST_PROFILE.id },
      'Japanese',
    );
    expect(result).toEqual({
      text: 'translated',
      targetLanguage: 'Japanese',
      translatorName: TEST_PROFILE.name,
    });
    expect(translateRuntimeBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'ai',
        apiKey: 'quick-test-secret',
        targetLanguage: 'Japanese',
      }),
      [{ requestId: 'quick', unitId: 'quick', partIndex: 0, text: '  First\nSecond  ' }],
      expect.any(Object),
      expect.any(AbortSignal),
      expect.any(Object),
    );
    expect(settings).toEqual(before);
    expect(JSON.stringify(result)).not.toContain('quick-test-secret');
  });

  it.each([
    [{ kind: 'ai', profileId: 'missing' }, 'English'],
    [{ kind: 'builtin', engine: 'microsoft-free' }, 'Klingon'],
    [{ kind: 'builtin', engine: 'google-free' }, '   '],
    [{ kind: 'builtin', engine: 'invalid' }, 'English'],
  ])('rejects invalid local selection %j before issuing HTTP', async (translator, target) => {
    const { service } = setup();
    await expect(
      service.translateQuick(
        sender,
        'invalid',
        'text',
        translator as TranslatorSettings['activeTranslator'],
        target,
      ),
    ).rejects.toThrow();
    expect(translateRuntimeBatch).not.toHaveBeenCalled();
  });

  it('splits long text for free engines while retaining the chosen target and order', async () => {
    const { service } = setup();
    vi.mocked(translateRuntimeBatch).mockImplementation((_config, segments) =>
      Promise.resolve({
        translations: Object.fromEntries(
          segments.map((segment) => [segment.requestId, String(segment.partIndex)]),
        ),
        failures: {},
      }),
    );
    expect(
      await service.translateQuick(
        sender,
        'long',
        'x'.repeat(2100),
        { kind: 'builtin', engine: 'microsoft-free' },
        'English',
      ),
    ).toMatchObject({ text: '012', targetLanguage: 'English', translatorName: 'Microsoft' });
    expect(translateRuntimeBatch).toHaveBeenCalledTimes(3);
    expect(
      vi
        .mocked(translateRuntimeBatch)
        .mock.calls.every(
          ([config, segments]) =>
            config.targetLanguage === 'English' && segments[0].text.length <= 1000,
        ),
    ).toBe(true);
  });

  it('cancels settings preflight and rejects a changed document', async () => {
    let resolve!: (value: TranslatorSettings) => void;
    const { service, getFrame } = setup(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const pending = service.translateQuick(
      sender,
      'pending',
      'text',
      settings.activeTranslator,
      'English',
    );
    service.cancel(sender, 'pending', 'quick');
    resolve(settings);
    await expect(pending).rejects.toThrow();
    expect(translateRuntimeBatch).not.toHaveBeenCalled();
    getFrame.mockResolvedValue({ documentId: 'new-document' });
    const stale = service.translateQuick(
      sender,
      'stale',
      'text',
      settings.activeTranslator,
      'English',
    );
    resolve(settings);
    await expect(stale).rejects.toThrow();
    expect(translateRuntimeBatch).not.toHaveBeenCalled();
  });

  it('keeps selection and quick cancellation separate even with the same request ID', async () => {
    const { service } = setup();
    const signals: AbortSignal[] = [];
    vi.mocked(translateRuntimeBatch).mockImplementation(
      (_config, _segments, _client, signal) =>
        new Promise((_resolve, reject) => {
          signals.push(signal!);
          signal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
        }),
    );
    const selected = service
      .translateSelection(sender, 'same', 'selection', settings.activeTranslator)
      .catch(() => undefined);
    const quick = service
      .translateQuick(sender, 'same', 'typed', settings.activeTranslator, 'English')
      .catch(() => undefined);
    await vi.waitFor(() => expect(signals).toHaveLength(2));
    service.cancel(sender, 'same', 'quick');
    await quick;
    expect(signals[0].aborted).toBe(false);
    expect(signals[1].aborted).toBe(true);
    service.removeTab(42);
    await selected;
  });
});
