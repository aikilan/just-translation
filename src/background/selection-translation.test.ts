import { TEST_PROFILE } from '../test-utils/provider';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SelectionTranslationService } from './selection-translation';
import { DEFAULT_SETTINGS, type TranslatorSettings } from '../shared/settings';
import { translateBatch } from '../shared/translation-client';

vi.mock('../shared/translation-client', () => ({ translateBatch: vi.fn() }));
const sender = (frameId = 0, documentId = 'doc'): chrome.runtime.MessageSender => ({
  tab: { id: 12 } as chrome.tabs.Tab,
  frameId,
  documentId,
  url: 'https://example.com/article',
});
const settings: TranslatorSettings = {
  ...DEFAULT_SETTINGS,
  profiles: [{ ...TEST_PROFILE, model: 'model' }],
  excludedSites: ['example.com'],
};
const result = { translations: { selection: '译文' }, failures: {} };
function setup(readSettings = () => Promise.resolve(settings)) {
  const getFrame = vi.fn(() => Promise.resolve({ documentId: 'doc' }));
  const service = new SelectionTranslationService(readSettings, getFrame);
  vi.mocked(translateBatch).mockResolvedValue(result);
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
    await service.translate(sender(), 'thinking-off', 'Hello');
    expect(translateBatch).toHaveBeenCalledWith(
      expect.objectContaining({ thinkingEnabled: false }),
      expect.any(Array),
      fetch,
      expect.any(AbortSignal),
      expect.any(Object),
    );
  });
  it('translates exactly the selection, including on excluded sites and inside frames', async () => {
    const { service, getFrame } = setup();
    expect(await service.translate(sender(3), 'one', '  First\nSecond  ')).toEqual({
      text: '译文',
      targetLanguage: settings.targetLanguage,
    });
    expect(getFrame).toHaveBeenCalledWith({ tabId: 12, frameId: 3 });
    expect(translateBatch).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'model', targetLanguage: settings.targetLanguage }),
      [{ requestId: 'selection', unitId: 'selection', partIndex: 0, text: '  First\nSecond  ' }],
      fetch,
      expect.any(AbortSignal),
      expect.objectContaining({ maxRetries: settings.translationRetryCount }),
    );
  });
  it('rejects empty text, missing configuration and stale documents before HTTP', async () => {
    const { service, getFrame } = setup();
    await expect(service.translate(sender(), 'one', ' \n ')).rejects.toThrow();
    getFrame.mockResolvedValue({ documentId: 'new-doc' });
    await expect(service.translate(sender(), 'two', 'text')).rejects.toThrow();
    const unconfigured = setup(() => Promise.resolve(DEFAULT_SETTINGS)).service;
    await expect(unconfigured.translate(sender(), 'three', 'text')).rejects.toThrow(/配置/);
    expect(translateBatch).not.toHaveBeenCalled();
  });
  it('cancels even while settings are still loading', async () => {
    let release!: (value: typeof settings) => void;
    const { service } = setup(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = service.translate(sender(), 'one', 'text');
    service.cancel(sender(), 'one');
    release(settings);
    await expect(pending).rejects.toThrow(/取消/);
    expect(translateBatch).not.toHaveBeenCalled();
  });
  it('isolates frame navigation, request IDs, and tab cleanup', async () => {
    const { service, getFrame } = setup();
    getFrame.mockImplementation((details?: { frameId: number }) =>
      Promise.resolve({ documentId: details?.frameId === 3 ? 'child' : 'doc' }),
    );
    const signals: AbortSignal[] = [];
    vi.mocked(translateBatch).mockImplementation(async (_config, _segments, _fetch, signal) => {
      signals.push(signal!);
      return new Promise((_resolve, reject) =>
        signal!.addEventListener('abort', () => reject(new Error('cancelled'))),
      );
    });
    const top = service.translate(sender(), 'same', 'top').catch(() => undefined);
    const frame = service.translate(sender(3, 'child'), 'same', 'child').catch(() => undefined);
    await vi.waitFor(() => expect(signals.length).toBe(2));
    service.navigate(12, 3, 'next');
    expect(signals[0].aborted).toBe(false);
    expect(signals[1].aborted).toBe(true);
    service.removeTab(12);
    await Promise.all([top, frame]);
    expect(signals[0].aborted).toBe(true);
  });
});
