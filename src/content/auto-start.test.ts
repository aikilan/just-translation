import { describe, expect, it, vi } from 'vitest';

import type { PublicTranslatorSettings } from '../shared/messages';
import { tryStartAutomaticTranslation } from './auto-start';

const SETTINGS: PublicTranslatorSettings = {
  uiLanguage: 'system',
  ready: true,
  supportsFullDocument: false,
  activeTranslator: { kind: 'builtin', engine: 'google-free' },
  profiles: [{ id: 'profile-one', name: '默认配置', configured: true }],
  targetLanguage: 'Simplified Chinese',
  displayMode: 'bilingual',
  translationConcurrency: 6,
  translationRetryCount: 1,
  fullDocumentTimeoutMinutes: 10,
  translateDynamicContent: true,
  excludedSites: [],
  autoTranslateSites: ['news.ycombinator.com'],
};

describe('tryStartAutomaticTranslation', () => {
  it.each(['news.ycombinator.com', '*.ycombinator.com'])(
    'does not start when the auto-translated site also matches exclusion %s',
    async (rule) => {
      const start = vi.fn().mockResolvedValue(undefined);
      await tryStartAutomaticTranslation(
        { start },
        'https://news.ycombinator.com/news',
        new AbortController().signal,
        vi.fn().mockResolvedValue({ ok: true, data: { ...SETTINGS, excludedSites: [rule] } }),
      );
      expect(start).not.toHaveBeenCalled();
    },
  );
  it.each(['google-free', 'microsoft-free'] as const)(
    'starts immediately with the selected %s engine when the hostname is marked',
    async (engine) => {
      const start = vi.fn().mockResolvedValue(undefined);

      await tryStartAutomaticTranslation(
        { start },
        'https://news.ycombinator.com/news?p=2',
        new AbortController().signal,
        vi.fn().mockResolvedValue({
          ok: true,
          data: { ...SETTINGS, activeTranslator: { kind: 'builtin', engine } },
        }),
      );

      expect(start).toHaveBeenCalledOnce();
    },
  );

  it('does not start an automatic site when the selected engine is not ready', async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    await tryStartAutomaticTranslation(
      { start },
      'https://news.ycombinator.com/news',
      new AbortController().signal,
      vi.fn().mockResolvedValue({ ok: true, data: { ...SETTINGS, ready: false } }),
    );
    expect(start).not.toHaveBeenCalled();
  });

  it('does nothing for an unmarked site or a failed settings read', async () => {
    const start = vi.fn().mockResolvedValue(undefined);

    await tryStartAutomaticTranslation(
      { start },
      'https://example.com/',
      new AbortController().signal,
      vi.fn().mockResolvedValue({ ok: true, data: SETTINGS }),
    );
    await tryStartAutomaticTranslation(
      { start },
      'https://news.ycombinator.com/news',
      new AbortController().signal,
      vi.fn().mockResolvedValue({ ok: false, error: { text: 'worker unavailable' } }),
    );

    expect(start).not.toHaveBeenCalled();
  });
});
