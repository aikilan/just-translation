import { afterEach, describe, expect, it, vi } from 'vitest';
import { TranslationTaskService } from './translation-task';
import { DEFAULT_SETTINGS, type TranslatorSettings } from '../shared/settings';
import { TEST_PROFILE } from '../test-utils/provider';
import { sliceText } from '../shared/text-slices';
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
const slices = (text: string) => sliceText(text).slices;
function setup(read = () => Promise.resolve(settings)) {
  const getFrame = vi.fn().mockResolvedValue({ documentId: 'document' });
  const notify = vi.fn(() => Promise.resolve());
  const service = new TranslationTaskService(
    read,
    getFrame,
    undefined,
    undefined,
    undefined,
    notify,
  );
  vi.mocked(translateRuntimeBatch).mockImplementation((_config, segments) =>
    Promise.resolve({
      translations: Object.fromEntries(
        segments.map((segment) => [segment.requestId, 'translated']),
      ),
      failures: {},
    }),
  );
  return { service, getFrame, notify };
}
afterEach(() => vi.clearAllMocks());

describe('quick translation request scope', () => {
  it('uses a configured local engine and language without changing global settings or requiring a page session', async () => {
    const before = structuredClone(settings);
    const { service } = setup();
    const result = await service.translateQuick(
      sender,
      'quick',
      slices('First\nSecond'),
      { kind: 'ai', profileId: TEST_PROFILE.id },
      'Japanese',
    );
    expect(result).toEqual({
      translations: { s0: 'translated' },
      failures: {},
      targetLanguage: 'Japanese',
      translatorName: TEST_PROFILE.name,
    });
    expect(translateRuntimeBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'ai',
        apiKey: 'quick-test-secret',
        targetLanguage: 'Japanese',
      }),
      [{ requestId: 's0:0', unitId: 's0', partIndex: 0, text: 'First\nSecond' }],
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
        slices('text'),
        translator as TranslatorSettings['activeTranslator'],
        target,
      ),
    ).rejects.toThrow();
    expect(translateRuntimeBatch).not.toHaveBeenCalled();
  });

  it('sends each slice of long free-engine text as its own request with the chosen target', async () => {
    const { service } = setup();
    vi.mocked(translateRuntimeBatch).mockImplementation((_config, segments) =>
      Promise.resolve({
        translations: Object.fromEntries(
          segments.map((segment) => [segment.requestId, segment.unitId]),
        ),
        failures: {},
      }),
    );
    expect(
      await service.translateQuick(
        sender,
        'long',
        slices('x'.repeat(2100)),
        { kind: 'builtin', engine: 'microsoft-free' },
        'English',
      ),
    ).toMatchObject({
      translations: { s0: 's0', s1: 's1', s2: 's2' },
      targetLanguage: 'English',
      translatorName: 'Microsoft',
    });
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

  it('keeps finished slices when another slice fails and reports progress to the sender document', async () => {
    const { service, notify } = setup();
    vi.mocked(translateRuntimeBatch).mockImplementation(
      (_config, segments, _client, _signal, options) => {
        if (segments.some((segment) => segment.unitId === 's1'))
          return Promise.reject(new Error('provider timed out'));
        const translations = Object.fromEntries(
          segments.map((segment) => [segment.requestId, `译:${segment.unitId}`]),
        );
        options?.onTranslations?.(translations);
        return Promise.resolve({ translations, failures: {} });
      },
    );
    const text = ['A'.repeat(900), 'B'.repeat(900), 'C'.repeat(900)].join('\n\n');
    const result = await service.translateQuick(
      sender,
      'partial',
      slices(text),
      { kind: 'builtin', engine: 'google-free' },
      'English',
    );
    expect(result.translations).toEqual({ s0: '译:s0', s2: '译:s2' });
    expect(result.failures).toEqual({ s1: { text: 'provider timed out' } });
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(2));
    expect(notify).toHaveBeenCalledWith(
      { tabId: 42, frameId: 0, documentId: 'document' },
      { type: 'QUICK_TRANSLATION_PROGRESS', requestId: 'partial', translations: { s0: '译:s0' } },
    );
  });

  it.each([
    ['text'],
    [[]],
    [[{ id: 's0', text: '' }]],
    [
      [
        { id: 's0', text: 'a' },
        { id: 's0', text: 'b' },
      ],
    ],
    [[{ id: 's0', text: 'x'.repeat(5_000) }]],
  ])('rejects malformed slices %j before reading settings', async (input) => {
    const read = vi.fn(() => Promise.resolve(settings));
    const { service } = setup(read);
    await expect(
      service.translateQuick(sender, 'bad', input, settings.activeTranslator, 'English'),
    ).rejects.toThrow('快捷翻译输入无效');
    expect(read).not.toHaveBeenCalled();
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
      slices('text'),
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
      slices('text'),
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
      .translateQuick(sender, 'same', slices('typed'), settings.activeTranslator, 'English')
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
