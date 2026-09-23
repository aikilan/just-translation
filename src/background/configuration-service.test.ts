import { TEST_PROFILE } from '../test-utils/provider';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
  type TranslatorSettings,
} from '../shared/settings';
import {
  deleteTranslationProfile,
  readPublicSettings,
  saveTranslationProfile,
  selectActiveTranslator,
  setSiteAutoTranslation,
  updateReadingPreferences,
  updateSiteRule,
} from './configuration-service';

describe('configuration service', () => {
  let stored: TranslatorSettings;
  let storageSet: ReturnType<
    typeof vi.fn<(values: Record<string, TranslatorSettings>) => Promise<void>>
  >;
  beforeEach(() => {
    stored = structuredClone({ ...DEFAULT_SETTINGS, profiles: [TEST_PROFILE] });
    storageSet = vi.fn((values: Record<string, TranslatorSettings>) => {
      stored = structuredClone(values[SETTINGS_STORAGE_KEY]);
      return Promise.resolve();
    });
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn(() => Promise.resolve({ [SETTINGS_STORAGE_KEY]: structuredClone(stored) })),
          set: storageSet,
        },
      },
    });
  });
  it('persists and publicly exposes concurrency independently of AI configuration', async () => {
    await expect(updateReadingPreferences({ translationConcurrency: 2 })).resolves.toMatchObject({
      translationConcurrency: 2,
    });
    expect(stored.translationConcurrency).toBe(2);
    await expect(readPublicSettings()).resolves.toMatchObject({ translationConcurrency: 2 });
  });
  it.each([2, 10, 60])(
    'persists the full-document deadline %i',
    async (fullDocumentTimeoutMinutes) => {
      await expect(updateReadingPreferences({ fullDocumentTimeoutMinutes })).resolves.toMatchObject(
        { fullDocumentTimeoutMinutes },
      );
      await expect(readPublicSettings()).resolves.toMatchObject({ fullDocumentTimeoutMinutes });
    },
  );
  it.each([0, 1, 61, 2.5, NaN, Infinity])(
    'rejects invalid full-document deadline %s',
    async (fullDocumentTimeoutMinutes) => {
      await expect(updateReadingPreferences({ fullDocumentTimeoutMinutes })).rejects.toThrow(
        '全文最长等待',
      );
      expect(storageSet).not.toHaveBeenCalled();
    },
  );
  it('persists disabled thinking and rejects a malformed preference without writing', async () => {
    await saveTranslationProfile({
      ...stored.profiles[0],
      model: 'mimo-v2.5',
      thinkingEnabled: false,
    });
    expect(stored.profiles[0].thinkingEnabled).toBe(false);
    storageSet.mockClear();
    await expect(
      saveTranslationProfile({
        ...stored.profiles[0],
        // @ts-expect-error exercise the untrusted runtime-message boundary
        thinkingEnabled: 'false',
      }),
    ).rejects.toThrow('思考');
    expect(storageSet).not.toHaveBeenCalled();
  });
  it.each([0, 3, 5])(
    'persists and publicly exposes retry count %i',
    async (translationRetryCount) => {
      await expect(updateReadingPreferences({ translationRetryCount })).resolves.toMatchObject({
        translationRetryCount,
      });
      expect(stored.translationRetryCount).toBe(translationRetryCount);
      await expect(readPublicSettings()).resolves.toMatchObject({ translationRetryCount });
    },
  );
  it.each([-1, 6, 1.5, NaN, Infinity])(
    'rejects invalid retry count %s without writing',
    async (translationRetryCount) => {
      await expect(updateReadingPreferences({ translationRetryCount })).rejects.toThrow('重试次数');
      expect(storageSet).not.toHaveBeenCalled();
    },
  );
  it.each([0, -1, 7, 1.5, NaN, Infinity])(
    'rejects invalid concurrency %s without writing',
    async (value) => {
      await expect(updateReadingPreferences({ translationConcurrency: value })).rejects.toThrow(
        '并发数',
      );
      expect(storageSet).not.toHaveBeenCalled();
    },
  );
  it('saves a single profile, normalizes values and keeps secrets private', async () => {
    const result = await saveTranslationProfile({
      ...stored.profiles[0],
      model: ' model ',
      apiKey: 'secret',
    });
    expect(result.ready).toBe(true);
    expect(stored.profiles[0].model).toBe('model');
    expect(JSON.stringify(result)).not.toContain('secret');
    await expect(readPublicSettings()).resolves.toEqual(result);
  });
  it('saves preferences and sites independently from incomplete AI configuration', async () => {
    await expect(updateReadingPreferences({ targetLanguage: ' Japanese ' })).resolves.toMatchObject(
      { ready: true, targetLanguage: 'Japanese' },
    );
    await updateSiteRule({
      list: 'excludedSites',
      hostname: '*.Internal.Example.com',
      enabled: true,
    });
    expect(stored.excludedSites).toEqual(['*.internal.example.com']);
    expect(stored.profiles[0].model).toBe('');
  });
  it('serializes simultaneous domain updates against latest storage', async () => {
    await Promise.all([
      saveTranslationProfile({ ...stored.profiles[0], model: 'model' }),
      updateReadingPreferences({ targetLanguage: 'Japanese' }),
      updateReadingPreferences({ displayMode: 'translation' }),
      setSiteAutoTranslation('News.Example.com', true),
      updateSiteRule({ list: 'excludedSites', hostname: 'bank.example.com', enabled: true }),
    ]);
    expect(stored).toMatchObject({
      uiLanguage: 'system',
      targetLanguage: 'Japanese',
      displayMode: 'translation',
      autoTranslateSites: ['news.example.com'],
      excludedSites: ['bank.example.com'],
      profiles: [expect.objectContaining({ model: 'model' })],
    });
  });
  it('rejects unconfirmed writes and recovers the queue after failure', async () => {
    storageSet.mockResolvedValueOnce(undefined);
    await expect(updateReadingPreferences({ targetLanguage: 'Japanese' })).rejects.toThrow(
      '回读不一致',
    );
    await expect(updateReadingPreferences({ targetLanguage: 'English' })).resolves.toMatchObject({
      targetLanguage: 'English',
    });
  });
  it('requires explicit valid activation and protects the active or last profile', async () => {
    await saveTranslationProfile({
      ...stored.profiles[0],
      id: 'second',
      name: '第二个',
      model: 'model',
    });
    expect(stored.activeTranslator).toEqual({ kind: 'builtin', engine: 'google-free' });
    await selectActiveTranslator({ kind: 'ai', profileId: 'second' });
    await expect(deleteTranslationProfile('second')).rejects.toThrow();
    await expect(
      selectActiveTranslator({ kind: 'ai', profileId: DEFAULT_SETTINGS.profiles[0].id }),
    ).rejects.toThrow('模型');
    await selectActiveTranslator({ kind: 'builtin', engine: 'microsoft-free' });
    await deleteTranslationProfile(DEFAULT_SETTINGS.profiles[0].id);
    expect(stored.profiles).toHaveLength(1);
    await expect(deleteTranslationProfile('second')).rejects.toThrow();
  });

  it('exposes built-in readiness independently from incomplete AI profiles', async () => {
    await expect(readPublicSettings()).resolves.toMatchObject({
      activeTranslator: { kind: 'builtin', engine: 'google-free' },
      ready: true,
      supportsFullDocument: false,
    });
    await expect(
      selectActiveTranslator({ kind: 'builtin', engine: 'microsoft-free' }),
    ).resolves.toMatchObject({
      activeTranslator: { kind: 'builtin', engine: 'microsoft-free' },
      ready: true,
      supportsFullDocument: false,
    });
  });

  it('keeps a custom target recoverable but not ready for a free engine', async () => {
    await updateReadingPreferences({ targetLanguage: 'Portuguese' });
    await expect(readPublicSettings()).resolves.toMatchObject({
      ready: false,
      supportsFullDocument: false,
      configurationError: { key: '免费翻译通道不支持当前目标语言' },
    });
  });
  it('rejects duplicate names and malformed rules', async () => {
    await expect(
      saveTranslationProfile({ ...stored.profiles[0], id: 'second', model: 'model' }),
    ).rejects.toThrow('名称不能重复');
    for (const hostname of [
      'https://example.com',
      'example.com/path',
      '*.*.example.com',
      'example.com?x',
      'example.com#x',
      'user@example.com',
    ]) {
      await expect(
        updateSiteRule({ list: 'excludedSites', hostname, enabled: true }),
      ).rejects.toThrow();
    }
    await expect(setSiteAutoTranslation('*.example.com', true)).rejects.toThrow();
    await expect(updateReadingPreferences({ targetLanguage: '' })).rejects.toThrow();
    expect(stored).toEqual({ ...DEFAULT_SETTINGS, profiles: [TEST_PROFILE] });
  });
  it('deduplicates rules and retains exclusion conflicts', async () => {
    await setSiteAutoTranslation('News.Example.com', true);
    await setSiteAutoTranslation('news.example.com', true);
    await updateSiteRule({ list: 'excludedSites', hostname: 'news.example.com', enabled: true });
    expect(stored.autoTranslateSites).toEqual(['news.example.com']);
    expect(stored.excludedSites).toEqual(['news.example.com']);
  });
});
