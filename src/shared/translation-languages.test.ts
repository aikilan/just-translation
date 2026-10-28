import { afterEach, describe, expect, it } from 'vitest';

import { setUiLanguage } from './i18n';
import {
  TRANSLATION_LANGUAGES,
  isPresetTranslationLanguage,
  isTargetLanguage,
  languageCodeLabel,
  sortedRuleLanguageCodes,
  sortedTranslationLanguages,
  translationLanguageLabel,
} from './translation-languages';

describe('translation language presets', () => {
  afterEach(() => setUiLanguage('zh-CN'));

  it('keeps unique ids and request-safe engine codes', () => {
    const ids = TRANSLATION_LANGUAGES.map((language) => language.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(TRANSLATION_LANGUAGES.length).toBeGreaterThan(80);
    for (const language of TRANSLATION_LANGUAGES) {
      for (const code of [language['google-free'], language['microsoft-free']]) {
        if (code) expect(code).toMatch(/^[A-Za-z]{2,3}(?:-[A-Za-z]{2,8})?$/u);
      }
      expect(language['google-free'] ?? language['microsoft-free']).toBeTruthy();
    }
  });

  it('keeps the original eight presets selectable by both free engines', () => {
    for (const id of [
      'Simplified Chinese',
      'English',
      'Japanese',
      'Korean',
      'French',
      'German',
      'Spanish',
      'Arabic',
    ]) {
      const language = TRANSLATION_LANGUAGES.find((item) => item.id === id);
      expect(language?.common).toBe(true);
      expect(language?.['google-free']).toBeTruthy();
      expect(language?.['microsoft-free']).toBeTruthy();
    }
  });

  it('localizes preset names with the browser catalog and keeps custom names verbatim', () => {
    setUiLanguage('zh-CN');
    expect(translationLanguageLabel('Simplified Chinese')).toBe('简体中文');
    expect(translationLanguageLabel('Japanese')).toBe('日语');
    setUiLanguage('fr');
    expect(translationLanguageLabel('English')).toBe('Anglais');
    expect(translationLanguageLabel('Klingon')).toBe('Klingon');
    expect(isPresetTranslationLanguage('Klingon')).toBe(false);
  });

  it('lists common presets first and sorts the rest by localized name', () => {
    setUiLanguage('en');
    const { common, others } = sortedTranslationLanguages();
    expect(common[0].id).toBe('Simplified Chinese');
    const labels = others.map((language) => translationLanguageLabel(language.id));
    const collator = new Intl.Collator('en');
    expect(labels).toEqual([...labels].sort((left, right) => collator.compare(left, right)));
  });

  it('compares Chinese scripts when deciding a page is already in the target', () => {
    expect(isTargetLanguage('zh-Hant', 'Simplified Chinese')).toBe(false);
    expect(isTargetLanguage('zh-Hans', 'Simplified Chinese')).toBe(true);
    expect(isTargetLanguage('zh-TW', 'Traditional Chinese')).toBe(true);
    // A bare rule code names no script, so it never conflicts with a Chinese target.
    expect(isTargetLanguage('zh', 'Simplified Chinese')).toBe(false);
    expect(isTargetLanguage('en', 'English')).toBe(true);
    expect(isTargetLanguage('en', 'Klingon')).toBe(false);
  });

  it('memoizes sorted lists per UI locale and labels rule codes', () => {
    setUiLanguage('en');
    expect(sortedTranslationLanguages()).toBe(sortedTranslationLanguages());
    expect(sortedRuleLanguageCodes()).toBe(sortedRuleLanguageCodes());
    expect(sortedRuleLanguageCodes()).toContain('zh');
    expect(languageCodeLabel('ja')).toBe('Japanese');
    setUiLanguage('zh-CN');
    expect(languageCodeLabel('ja')).toBe('日语');
  });
});
