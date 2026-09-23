import { describe, expect, it, vi } from 'vitest';

import { TEST_PROFILE } from '../test-utils/provider';
import { DEFAULT_SETTINGS } from '../shared/settings';
import type { TranslationSegment, TranslationUnit } from '../shared/batching';
import {
  getTranslationBatchProfiles,
  getTranslationMaxConcurrency,
  getTranslationRequestTimeout,
  getTranslationQueueUrl,
  resolveTranslationRuntimeConfig,
  translateRuntimeBatch,
  translateRuntimeFullDocument,
  type BuiltinTranslator,
} from './translation-engine';

const SEGMENT: TranslationSegment = {
  requestId: 'paragraph:0',
  unitId: 'paragraph',
  partIndex: 0,
  text: 'Hello [[JT_KEEP_0]]',
};

describe('translation engine resolution', () => {
  it('resolves a zero-config Google engine with provider-specific target code and limits', () => {
    const config = resolveTranslationRuntimeConfig(
      {
        ...DEFAULT_SETTINGS,
        profiles: [{ ...TEST_PROFILE, model: '' }],
        activeTranslator: { kind: 'builtin', engine: 'google-free' },
      },
      { kind: 'builtin', engine: 'google-free' },
    );

    expect(config).toEqual({
      kind: 'builtin',
      engine: 'google-free',
      targetLanguage: 'Simplified Chinese',
      targetLanguageCode: 'zh-CN',
      translationRetryCount: 1,
    });
    expect(getTranslationQueueUrl(config)).toBe('https://translate.googleapis.com');
    expect(getTranslationMaxConcurrency(config, 6)).toBe(2);
    expect(getTranslationBatchProfiles(config)).toEqual({
      visible: { maxCharacters: 1_000, maxItems: 1 },
      readAhead: { maxCharacters: 1_000, maxItems: 1 },
      background: { maxCharacters: 1_000, maxItems: 1 },
    });
    expect(getTranslationRequestTimeout(config, 'background')).toBe(20_000);
  });

  it('keeps the existing AI request configuration and its user concurrency', () => {
    const profile = { ...TEST_PROFILE, id: 'ai', name: 'AI', model: 'model' };
    const config = resolveTranslationRuntimeConfig(
      {
        ...DEFAULT_SETTINGS,
        profiles: [profile],
        activeTranslator: { kind: 'ai', profileId: 'ai' },
      },
      { kind: 'ai', profileId: 'ai' },
    );

    expect(config).toMatchObject({
      kind: 'ai',
      profileId: 'ai',
      profileName: 'AI',
      model: 'model',
    });
    expect(getTranslationQueueUrl(config)).toBe('https://api.openai.com/v1');
    expect(getTranslationMaxConcurrency(config, 5)).toBe(5);
    expect(getTranslationBatchProfiles(config).visible).toEqual({
      maxCharacters: 1_200,
      maxItems: 4,
    });
    expect(getTranslationRequestTimeout(config, 'visible')).toBe(20_000);
    expect(getTranslationRequestTimeout(config, 'background')).toBe(60_000);
  });

  it('rejects stale selections and unsupported custom targets without changing engine', () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      activeTranslator: { kind: 'builtin', engine: 'google-free' } as const,
    };
    expect(() =>
      resolveTranslationRuntimeConfig(settings, {
        kind: 'builtin',
        engine: 'microsoft-free',
      }),
    ).toThrow('设置已改变');
    expect(() =>
      resolveTranslationRuntimeConfig(
        { ...settings, targetLanguage: 'Portuguese' },
        settings.activeTranslator,
      ),
    ).toThrow('不支持当前目标语言');
  });
});

describe('translation engine dispatch', () => {
  it('uses only the explicitly selected built-in adapter and publishes its validated result', async () => {
    const translate = vi.fn().mockResolvedValue('你好 [[JT_KEEP_0]]');
    const onTranslations = vi.fn();
    const config = {
      kind: 'builtin' as const,
      engine: 'google-free' as const,
      targetLanguage: 'Simplified Chinese',
      targetLanguageCode: 'zh-CN',
      translationRetryCount: 0,
    };

    await expect(
      translateRuntimeBatch(config, [SEGMENT], { translate }, undefined, {
        onTranslations,
      }),
    ).resolves.toEqual({
      translations: { 'paragraph:0': '你好 [[JT_KEEP_0]]' },
      failures: {},
    });
    expect(translate).toHaveBeenCalledWith(
      {
        engine: 'google-free',
        targetLanguageCode: 'zh-CN',
        text: SEGMENT.text,
      },
      undefined,
      expect.any(Object),
    );
    expect(onTranslations).toHaveBeenCalledWith({
      'paragraph:0': '你好 [[JT_KEEP_0]]',
    });
  });

  it('retries the same engine within the shared budget and never falls back', async () => {
    const translate = vi
      .fn<BuiltinTranslator['translate']>()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValueOnce('translated [[JT_KEEP_0]]');
    const sleep = vi.fn().mockResolvedValue(undefined);
    const config = {
      kind: 'builtin' as const,
      engine: 'microsoft-free' as const,
      targetLanguage: 'English',
      targetLanguageCode: 'en',
      translationRetryCount: 1,
    };

    await expect(
      translateRuntimeBatch(config, [SEGMENT], { translate }, undefined, { sleep }),
    ).resolves.toMatchObject({ translations: { 'paragraph:0': 'translated [[JT_KEEP_0]]' } });
    expect(translate).toHaveBeenCalledTimes(2);
    expect(translate.mock.calls.map(([request]) => request.engine)).toEqual([
      'microsoft-free',
      'microsoft-free',
    ]);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it('rejects full-document translation for a built-in engine before network execution', async () => {
    const translate = vi.fn();
    const units: TranslationUnit[] = [{ id: 'p', text: 'whole document' }];
    await expect(
      translateRuntimeFullDocument(
        {
          kind: 'builtin',
          engine: 'google-free',
          targetLanguage: 'English',
          targetLanguageCode: 'en',
          translationRetryCount: 1,
        },
        units,
        { translate },
      ),
    ).rejects.toThrow('仅支持 AI');
    expect(translate).not.toHaveBeenCalled();
  });
});
