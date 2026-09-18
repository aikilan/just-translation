import { TEST_PROFILE } from '../test-utils/provider';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SETTINGS,
  DEFAULT_TRANSLATION_PROMPT,
  MAX_TRANSLATION_PROMPT_CHARACTERS,
  getActiveProfile,
  isUrlAutoTranslated,
  isUrlExcluded,
  mergeSettings,
  normalizeApiUrl,
  validateSettings,
} from './settings';

describe('normalizeApiUrl', () => {
  it.each([
    ['https://api.openai.com', 'https://api.openai.com/v1/chat/completions'],
    ['https://example.com/openai/v1/', 'https://example.com/openai/v1/chat/completions'],
    ['https://example.com/v1/chat/completions/', 'https://example.com/v1/chat/completions'],
    [
      'https://example.com/v1/chat/completions?api-version=2026-08-01',
      'https://example.com/v1/chat/completions?api-version=2026-08-01',
    ],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeApiUrl(input)).toBe(expected);
  });
});

describe('validateSettings', () => {
  it('accepts a complete OpenAI-compatible configuration', () => {
    expect(
      validateSettings({
        ...DEFAULT_SETTINGS,
        profiles: [
          {
            ...TEST_PROFILE,
            apiUrl: 'https://gateway.example.com/v1',
            model: 'gpt-4.1-mini',
          },
        ],
      }),
    ).toEqual({ valid: true, errors: { profileErrors: {} } });
  });

  it('rejects unsafe URLs and missing required fields', () => {
    const result = validateSettings({
      ...DEFAULT_SETTINGS,
      profiles: [
        {
          ...TEST_PROFILE,
          apiUrl: 'ftp://example.com',
          model: ' ',
          translationPrompt: ' ',
        },
      ],
      targetLanguage: ' ',
    });

    expect(result.valid).toBe(false);
    expect(typeof result.errors.profileErrors[DEFAULT_SETTINGS.activeProfileId]?.apiUrl).toBe(
      'string',
    );
    expect(typeof result.errors.profileErrors[DEFAULT_SETTINGS.activeProfileId]?.model).toBe(
      'string',
    );
    expect(
      typeof result.errors.profileErrors[DEFAULT_SETTINGS.activeProfileId]?.translationPrompt,
    ).toBe('string');
    expect(typeof result.errors.targetLanguage).toBe('string');
  });

  it('rejects a translation prompt that would be repeated into oversized micro-batch requests', () => {
    const result = validateSettings({
      ...DEFAULT_SETTINGS,
      profiles: [
        {
          ...TEST_PROFILE,
          model: 'translation-model',
          translationPrompt: 'x'.repeat(MAX_TRANSLATION_PROMPT_CHARACTERS + 1),
        },
      ],
    });

    expect(
      result.errors.profileErrors[DEFAULT_SETTINGS.activeProfileId]?.translationPrompt,
    ).toContain(String(MAX_TRANSLATION_PROMPT_CHARACTERS));
  });

  it('rejects API keys over remote HTTP while allowing a loopback development API', () => {
    expect(
      validateSettings({
        ...DEFAULT_SETTINGS,
        profiles: [
          {
            ...TEST_PROFILE,
            apiUrl: 'http://gateway.example.com/v1',
            apiKey: 'secret',
            model: 'model',
          },
        ],
      }).errors.profileErrors[DEFAULT_SETTINGS.activeProfileId]?.apiUrl,
    ).toMatch(/HTTPS/u);

    expect(
      validateSettings({
        ...DEFAULT_SETTINGS,
        profiles: [
          {
            ...TEST_PROFILE,
            apiUrl: 'http://127.0.0.1:11434/v1',
            apiKey: 'local-secret',
            model: 'model',
          },
        ],
      }),
    ).toEqual({ valid: true, errors: { profileErrors: {} } });
  });

  it('normalizes corrupted storage values field by field', () => {
    expect(
      mergeSettings({
        profiles: 'legacy-single-profile',
        apiUrl: 'https://legacy.example.com/v1',
        model: 'legacy-model',
        displayMode: 'invalid',
        translateDynamicContent: 'yes',
        batchMaxCharacters: 20_000,
        batchMaxItems: 100,
        batchConcurrency: 5,
        excludedSites: ['example.com', 123],
      }),
    ).toEqual({
      ...DEFAULT_SETTINGS,
      excludedSites: ['example.com'],
    });
    expect(DEFAULT_SETTINGS).not.toHaveProperty('batchMaxCharacters');
    expect(DEFAULT_SETTINGS).not.toHaveProperty('batchMaxItems');
    expect(DEFAULT_SETTINGS).not.toHaveProperty('batchConcurrency');
  });

  it('supports multiple named profiles and resolves only the selected one', () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      profiles: [
        {
          ...TEST_PROFILE,
          id: 'deepseek',
          name: 'DeepSeek',
          apiUrl: 'https://api.deepseek.com/v1',
          apiKey: 'a',
          model: 'deepseek-chat',
          thinkingEnabled: true,
          translationPrompt: 'Use concise terminology.',
        },
        {
          ...TEST_PROFILE,
          id: 'local',
          name: '本地模型',
          apiUrl: 'http://127.0.0.1:11434/v1',
          apiKey: '',
          model: 'qwen3',
          thinkingEnabled: true,
          translationPrompt: 'Use natural Chinese.',
        },
      ],
      activeProfileId: 'local',
    };

    expect(validateSettings(settings).valid).toBe(true);
    expect(getActiveProfile(settings)).toMatchObject({ id: 'local', model: 'qwen3' });
  });

  it('initializes every stored profile without a prompt from the product default', () => {
    const settings = mergeSettings({
      ...DEFAULT_SETTINGS,
      profiles: [
        {
          provider: 'custom', protocol:'openai',
          id: 'stored-profile',
          name: '已有配置',
          apiUrl: 'https://gateway.example.com/v1',
          apiKey: '',
          model: 'translation-model',
        },
      ],
      activeProfileId: 'stored-profile',
    });

    expect(settings.profiles[0]?.translationPrompt).toBe(DEFAULT_TRANSLATION_PROMPT);
    expect(validateSettings(settings).valid).toBe(true);
  });
});

describe('isUrlExcluded', () => {
  it('supports exact hosts and wildcard subdomains without overmatching', () => {
    const patterns = ['example.com', '*.internal.test'];

    expect(isUrlExcluded('https://example.com/a', patterns)).toBe(true);
    expect(isUrlExcluded('https://docs.internal.test/a', patterns)).toBe(true);
    expect(isUrlExcluded('https://internal.test/a', patterns)).toBe(false);
    expect(isUrlExcluded('https://notexample.com/a', patterns)).toBe(false);
  });
});

describe('isUrlAutoTranslated', () => {
  it('matches the exact hostname across page navigation without matching sibling domains', () => {
    const sites = ['news.ycombinator.com'];

    expect(isUrlAutoTranslated('https://news.ycombinator.com/news', sites)).toBe(true);
    expect(isUrlAutoTranslated('https://news.ycombinator.com/news?p=2', sites)).toBe(true);
    expect(isUrlAutoTranslated('https://www.ycombinator.com/', sites)).toBe(false);
  });
});

describe('translation concurrency preference', () => {
  it('defaults to four and retains saved limits', () => {
    expect(mergeSettings(undefined).translationConcurrency).toBe(4);
    expect(mergeSettings({}).translationConcurrency).toBe(4);
    expect(mergeSettings({ translationConcurrency: 6 }).translationConcurrency).toBe(6);
    expect(mergeSettings({ translationConcurrency: 2 }).translationConcurrency).toBe(2);
  });
  it.each([0, -1, 7, 1.5, '2', null, NaN, Infinity])(
    'normalizes invalid stored concurrency %s',
    (value) => {
      expect(mergeSettings({ translationConcurrency: value }).translationConcurrency).toBe(4);
    },
  );
});

describe('translation retry preference', () => {
  it('defaults to one retry and preserves zero and supported counts', () => {
    expect(mergeSettings(undefined).translationRetryCount).toBe(1);
    expect(mergeSettings({}).translationRetryCount).toBe(1);
    for (const translationRetryCount of [0, 1, 2, 3, 4, 5]) {
      expect(mergeSettings({ translationRetryCount }).translationRetryCount).toBe(
        translationRetryCount,
      );
    }
  });
  it.each([-1, 6, 1.5, '2', null, NaN, Infinity])('normalizes invalid retry count %s', (value) => {
    expect(mergeSettings({ translationRetryCount: value }).translationRetryCount).toBe(1);
  });
});
