import { describe, expect, it } from 'vitest';

import {
  BUILTIN_TRANSLATOR_LIMITS,
  DEFAULT_ACTIVE_TRANSLATOR,
  activeTranslatorName,
  activeTranslatorEquals,
  activeTranslatorKey,
  builtinTranslatorLabel,
  builtinTranslatorName,
  parseActiveTranslatorKey,
  resolveBuiltinTargetLanguage,
} from './translation-engines';

describe('built-in translation engines', () => {
  it('defaults new installations to the Google free engine', () => {
    expect(DEFAULT_ACTIVE_TRANSLATOR).toEqual({ kind: 'builtin', engine: 'google-free' });
    expect(activeTranslatorKey(DEFAULT_ACTIVE_TRANSLATOR)).toBe('builtin:google-free');
  });

  it.each([
    ['Simplified Chinese', 'zh-CN', 'zh-Hans'],
    ['English', 'en', 'en'],
    ['Japanese', 'ja', 'ja'],
    ['Korean', 'ko', 'ko'],
    ['French', 'fr', 'fr'],
    ['German', 'de', 'de'],
    ['Spanish', 'es', 'es'],
    ['Arabic', 'ar', 'ar'],
  ])('maps %s to exact Google and Microsoft codes', (language, google, microsoft) => {
    expect(resolveBuiltinTargetLanguage('google-free', language)).toBe(google);
    expect(resolveBuiltinTargetLanguage('microsoft-free', language)).toBe(microsoft);
  });

  it('rejects custom language names instead of guessing a provider code', () => {
    expect(resolveBuiltinTargetLanguage('google-free', 'Portuguese')).toBeUndefined();
    expect(resolveBuiltinTargetLanguage('microsoft-free', '粤语')).toBeUndefined();
  });

  it('uses conservative non-streaming request limits for both free engines', () => {
    expect(BUILTIN_TRANSLATOR_LIMITS).toEqual({
      maxCharacters: 1_000,
      maxItems: 1,
      maxConcurrency: 2,
    });
  });

  it('compares discriminated identities without conflating AI profile and engine ids', () => {
    expect(
      activeTranslatorEquals(
        { kind: 'ai', profileId: 'google-free' },
        { kind: 'builtin', engine: 'google-free' },
      ),
    ).toBe(false);
    expect(
      activeTranslatorEquals(
        { kind: 'ai', profileId: 'profile-a' },
        { kind: 'ai', profileId: 'profile-a' },
      ),
    ).toBe(true);
    expect(builtinTranslatorLabel('microsoft-free')).toContain('Microsoft');
    expect(builtinTranslatorName('google-free')).toBe('Google');
    expect(
      activeTranslatorName({ kind: 'ai', profileId: 'profile-a' }, [
        { id: 'profile-a', name: 'Private AI' },
      ]),
    ).toBe('Private AI');
  });

  it('round-trips only valid engine selector values', () => {
    expect(parseActiveTranslatorKey('builtin:microsoft-free')).toEqual({
      kind: 'builtin',
      engine: 'microsoft-free',
    });
    expect(parseActiveTranslatorKey('ai:profile-a')).toEqual({
      kind: 'ai',
      profileId: 'profile-a',
    });
    expect(parseActiveTranslatorKey('builtin:unknown')).toBeUndefined();
    expect(parseActiveTranslatorKey('ai:')).toBeUndefined();
  });
});
