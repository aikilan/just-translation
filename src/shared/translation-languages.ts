import { t, type MessageKey } from './i18n';

/** Stable request values paired with product-owned display labels. */
export const TRANSLATION_LANGUAGES = [
  ['Simplified Chinese', '简体中文'],
  ['English', '英语'],
  ['Japanese', '日语'],
  ['Korean', '韩语'],
  ['French', '法语'],
  ['German', '德语'],
  ['Spanish', '西班牙语'],
  ['Arabic', '阿拉伯语'],
] as const satisfies readonly (readonly [string, MessageKey])[];

/** Localizes known presets while preserving user-entered custom language names verbatim. */
export function translationLanguageLabel(value: string): string {
  const label = TRANSLATION_LANGUAGES.find(([id]) => id === value)?.[1];
  return label ? t(label) : value;
}
