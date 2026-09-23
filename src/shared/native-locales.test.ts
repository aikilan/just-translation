import { expect, it } from 'vitest';
import { nativeLocaleMessages } from './native-locales';
import definition from '../../manifest.config';
const manifest = definition as chrome.runtime.ManifestV3;

it('generates complete native metadata from the same catalogs and shares simplified Chinese across regions', () => {
  const locales = nativeLocaleMessages();
  expect(Object.keys(locales).sort()).toEqual(['ar', 'de', 'en', 'fr', 'zh_CN', 'zh_TW']);
  expect(locales.zh_CN).toEqual(locales.zh_TW);
  expect(locales.en.extensionName.message).toBe('Just Translate');
  expect(locales.zh_CN.extensionName.message).toBe('只是翻译');
  expect(locales.en.extensionDescription.message).toContain('Google');
  expect(locales.en.extensionDescription.message).toContain('Microsoft');
  expect(manifest.default_locale).toBe('en');
  for (const name of [
    manifest.name,
    manifest.description,
    manifest.action?.default_title,
    manifest.commands?.['translate-page'].description,
  ]) {
    const key = name?.match(/^__MSG_(\w+)__$/u)?.[1];
    expect(key).toBeTruthy();
    for (const messages of Object.values(locales)) expect(messages[key!].message).toBeTruthy();
  }
});
