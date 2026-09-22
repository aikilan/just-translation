import { afterEach, describe, expect, it } from 'vitest';
import {
  resolveUiLocale,
  isUiLanguage,
  setUiLanguage,
  t,
  message,
  renderMessage,
  LocalizedError,
  toUiMessage,
  isUiMessage,
} from './i18n';
import { resources, UI_LOCALES } from './locales';
import { mergeSettings } from './settings';

afterEach(() => setUiLanguage('zh-CN'));

describe('UI localization', () => {
  it.each([
    ['zh-TW', 'zh-CN'],
    ['zh-Hant-HK', 'zh-CN'],
    ['zh_CN', 'zh-CN'],
    ['en-GB', 'en'],
    ['fr-CA', 'fr'],
    ['de-AT', 'de'],
    ['ar-EG', 'ar'],
    ['ja', 'en'],
  ])('resolves browser locale %s to %s', (browser, expected) => {
    expect(resolveUiLocale('system', browser)).toBe(expected);
    expect(resolveUiLocale('fr', browser)).toBe('fr');
  });
  it('validates explicit choices and defaults missing settings without changing translation settings', () => {
    expect(isUiLanguage('ar')).toBe(true);
    expect(isUiLanguage('system')).toBe(true);
    expect(isUiLanguage('ar-EG')).toBe(false);
    expect(isUiLanguage({})).toBe(false);
    expect(mergeSettings({ uiLanguage: 'invalid', targetLanguage: 'Japanese' })).toMatchObject({
      uiLanguage: 'system',
      targetLanguage: 'Japanese',
    });
    expect(mergeSettings({ uiLanguage: 'fr' }).uiLanguage).toBe('fr');
  });
  it('ships complete catalogs with matching interpolation variables', () => {
    const placeholders = (value: string) =>
      [...value.matchAll(/\{\{(\w+)\}\}/gu)].map((match) => match[1]).sort();
    const baseKeys = Object.keys(resources['zh-CN']).filter(
      (key) => !/_(zero|one|two|few|many|other)$/u.test(key),
    );
    for (const locale of UI_LOCALES) {
      for (const key of baseKeys) {
        const value = (resources[locale] as Record<string, string>)[key];
        expect(value, `${locale}: ${key}`).toBeTruthy();
        expect(placeholders(value)).toEqual(
          placeholders((resources['zh-CN'] as Record<string, string>)[key]),
        );
      }
    }
  });
  it('renders stored errors in the current locale and preserves external diagnostics', () => {
    const error = toUiMessage(new LocalizedError(message('请填写模型名称')));
    setUiLanguage('en');
    const wire: unknown = JSON.parse(JSON.stringify(error));
    expect(isUiMessage(wire)).toBe(true);
    if (!isUiMessage(wire)) throw new Error('Invalid test message');
    expect(renderMessage(wire)).toBe('Enter a model name');
    setUiLanguage('fr');
    expect(renderMessage(error)).toBe('Saisissez un nom de modèle');
    expect(renderMessage(toUiMessage(new Error('Provider diagnostic 429')))).toBe(
      'Provider diagnostic 429',
    );
  });
  it('uses Arabic plural categories and preserves zero counts', () => {
    setUiLanguage('ar');
    expect(new Set([0, 1, 2, 3, 11, 100].map((count) => t('siteCount', { count }))).size).toBe(6);
  });
  it('isolates external details embedded in Arabic product messages', () => {
    setUiLanguage('ar');
    const rendered = renderMessage(
      message('API 流式返回错误：{{p0}}', { p0: 'HTTP 429: rate limit' }),
    );
    expect(rendered).toContain('\u2068HTTP 429: rate limit\u2069');
  });
});
