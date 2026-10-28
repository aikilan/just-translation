// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PublicTranslatorSettings } from '../shared/messages';
import type { PageLanguageResult } from './page-language';
import { tryStartAutomaticTranslation } from './auto-start';

const SETTINGS: PublicTranslatorSettings = {
  uiLanguage: 'system',
  ready: true,
  supportsFullDocument: false,
  activeTranslator: { kind: 'builtin', engine: 'google-free' },
  profiles: [{ id: 'profile-one', name: '默认配置', configured: true, supportsImageInput: false }],
  targetLanguage: 'Simplified Chinese',
  displayMode: 'bilingual',
  translationStyle: 'inherit',
  selectionIcon: true,
  autoTranslateLanguages: [],
  translationConcurrency: 6,
  translationRetryCount: 1,
  fullDocumentTimeoutMinutes: 10,
  translateDynamicContent: true,
  excludedSites: [],
  autoTranslateSites: ['news.ycombinator.com'],
  youtubeSubtitles: false,
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

  describe('language rules', () => {
    const LANGUAGE_SETTINGS = {
      ...SETTINGS,
      autoTranslateSites: [],
      autoTranslateLanguages: ['en'],
    };
    const detected = (language: string) =>
      vi
        .fn<() => Promise<PageLanguageResult>>()
        .mockResolvedValue({ status: 'detected', language, tag: language });
    async function attempt(
      settings: PublicTranslatorSettings,
      readLanguage: () => Promise<PageLanguageResult>,
      signal = new AbortController().signal,
    ) {
      const start = vi.fn().mockResolvedValue(undefined);
      await tryStartAutomaticTranslation(
        { start },
        'https://example.com/article',
        signal,
        vi.fn().mockResolvedValue({ ok: true, data: settings }),
        readLanguage,
      );
      return start;
    }

    afterEach(() => {
      document.body.innerHTML = '';
      vi.useRealTimers();
    });

    it('starts a page whose locally detected language is listed', async () => {
      expect(await attempt(LANGUAGE_SETTINGS, detected('en'))).toHaveBeenCalledOnce();
    });

    it('never detects or starts without a listed language, and ignores other languages', async () => {
      const readLanguage = detected('en');
      expect(
        await attempt({ ...LANGUAGE_SETTINGS, autoTranslateLanguages: [] }, readLanguage),
      ).not.toHaveBeenCalled();
      expect(readLanguage).not.toHaveBeenCalled();
      expect(await attempt(LANGUAGE_SETTINGS, detected('fr'))).not.toHaveBeenCalled();
    });

    it('lets exclusions win and skips pages already in the target language', async () => {
      expect(
        await attempt({ ...LANGUAGE_SETTINGS, excludedSites: ['example.com'] }, detected('en')),
      ).not.toHaveBeenCalled();
      expect(
        await attempt({ ...LANGUAGE_SETTINGS, targetLanguage: 'English' }, detected('en')),
      ).not.toHaveBeenCalled();
    });

    it('converts Traditional Chinese pages for a Simplified Chinese reader', async () => {
      const chinese = { ...LANGUAGE_SETTINGS, autoTranslateLanguages: ['zh'] };
      const page = (tag: string) =>
        vi
          .fn<() => Promise<PageLanguageResult>>()
          .mockResolvedValue({ status: 'detected', language: 'zh', tag });
      expect(await attempt(chinese, page('zh-Hant'))).toHaveBeenCalledOnce();
      expect(await attempt(chinese, page('zh-Hans'))).not.toHaveBeenCalled();
    });

    it('keeps pages with a password field manual', async () => {
      document.body.innerHTML = '<form><input type="password"></form>';
      expect(await attempt(LANGUAGE_SETTINGS, detected('en'))).not.toHaveBeenCalled();
    });

    it('waits for a still-rendering page but gives up on an unknown language', async () => {
      vi.useFakeTimers();
      const readLanguage = vi
        .fn<() => Promise<PageLanguageResult>>()
        .mockResolvedValueOnce({ status: 'insufficient' })
        .mockResolvedValueOnce({ status: 'detected', language: 'en', tag: 'en' });
      const pending = attempt(LANGUAGE_SETTINGS, readLanguage);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await pending).toHaveBeenCalledOnce();
      expect(readLanguage).toHaveBeenCalledTimes(2);

      const unknown = vi
        .fn<() => Promise<PageLanguageResult>>()
        .mockResolvedValue({ status: 'unknown' });
      expect(await attempt(LANGUAGE_SETTINGS, unknown)).not.toHaveBeenCalled();
      expect(unknown).toHaveBeenCalledOnce();
    });

    it('drops the startup intent when a user command aborts it while waiting', async () => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const pending = attempt(
        LANGUAGE_SETTINGS,
        vi.fn<() => Promise<PageLanguageResult>>().mockResolvedValue({ status: 'insufficient' }),
        controller.signal,
      );
      await vi.advanceTimersByTimeAsync(10);
      controller.abort();
      expect(await pending).not.toHaveBeenCalled();
    });
  });
});
