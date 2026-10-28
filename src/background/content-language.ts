import { detectAll, toISO2 } from 'tinyld/light';

import { TRANSLATION_LANGUAGES } from '../shared/translation-languages';

export interface LanguageScore {
  lang: string;
  accuracy: number;
}

export type LanguageDetector = (text: string) => LanguageScore[];

const TARGET_LANGUAGE_CODES: Readonly<Record<string, string>> = {
  ...Object.fromEntries(
    TRANSLATION_LANGUAGES.map(({ id, code }) => [id.toLowerCase(), code.split('-')[0]]),
  ),
  'simplified chinese': 'zh',
  'chinese (simplified)': 'zh',
  'traditional chinese': 'zh',
  'chinese (traditional)': 'zh',
  chinese: 'zh',
  'zh-cn': 'zh',
  'zh-hans': 'zh',
  'zh-tw': 'zh',
  'zh-hant': 'zh',
  english: 'en',
  japanese: 'ja',
  korean: 'ko',
  french: 'fr',
  german: 'de',
  spanish: 'es',
  portuguese: 'pt',
  italian: 'it',
  russian: 'ru',
  arabic: 'ar',
  hindi: 'hi',
};

const MINIMUM_DETECTION_LETTERS = 24;
const MINIMUM_TOP_ACCURACY = 0.9;
const MINIMUM_ACCURACY_LEAD = 0.2;

// Absence of a required script proves a miss without running the statistical detector.
// Mixed text still goes through the existing confidence checks; we never infer a skip here.
const TARGET_SCRIPTS: Readonly<Record<string, RegExp>> = {
  zh: /\p{Script=Han}/u,
  ja: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u,
  ko: /[\p{Script=Hangul}\p{Script=Han}]/u,
  yue: /\p{Script=Han}/u,
  ru: /\p{Script=Cyrillic}/u,
  uk: /\p{Script=Cyrillic}/u,
  be: /\p{Script=Cyrillic}/u,
  bg: /\p{Script=Cyrillic}/u,
  mk: /\p{Script=Cyrillic}/u,
  kk: /\p{Script=Cyrillic}/u,
  ky: /\p{Script=Cyrillic}/u,
  mn: /\p{Script=Cyrillic}/u,
  tt: /\p{Script=Cyrillic}/u,
  ar: /\p{Script=Arabic}/u,
  fa: /\p{Script=Arabic}/u,
  ur: /\p{Script=Arabic}/u,
  ps: /\p{Script=Arabic}/u,
  ug: /\p{Script=Arabic}/u,
  he: /\p{Script=Hebrew}/u,
  el: /\p{Script=Greek}/u,
  th: /\p{Script=Thai}/u,
  lo: /\p{Script=Lao}/u,
  km: /\p{Script=Khmer}/u,
  my: /\p{Script=Myanmar}/u,
  ka: /\p{Script=Georgian}/u,
  hy: /\p{Script=Armenian}/u,
  am: /\p{Script=Ethiopic}/u,
  ti: /\p{Script=Ethiopic}/u,
  hi: /\p{Script=Devanagari}/u,
  mr: /\p{Script=Devanagari}/u,
  ne: /\p{Script=Devanagari}/u,
  bn: /\p{Script=Bengali}/u,
  as: /\p{Script=Bengali}/u,
  pa: /\p{Script=Gurmukhi}/u,
  gu: /\p{Script=Gujarati}/u,
  or: /\p{Script=Oriya}/u,
  ta: /\p{Script=Tamil}/u,
  te: /\p{Script=Telugu}/u,
  kn: /\p{Script=Kannada}/u,
  ml: /\p{Script=Malayalam}/u,
  si: /\p{Script=Sinhala}/u,
};

/** Declarations describe the UI as often as the content; only corroborated text may be skipped. */
export function shouldSkipTargetLanguage(
  text: string,
  declaredLanguage: string | undefined,
  targetLanguage: string,
  detector: LanguageDetector = detectLanguages,
): boolean {
  const targetCode = resolveTargetLanguageCode(targetLanguage);
  if (!targetCode) return false;

  // Statistical zh detection cannot distinguish Hans/Hant. Explicit script conversion
  // must reach the AI unless the nearest declaration positively identifies the same variant.
  const targetVariant = getChineseVariant(targetLanguage);
  if (targetCode === 'zh' && targetVariant) {
    const letters = text.match(/\p{L}/gu) ?? [];
    return (
      getChineseVariant(declaredLanguage ?? '') === targetVariant &&
      /\p{Script=Han}/u.test(text) &&
      letters.every((letter) => /\p{Script=Han}/u.test(letter))
    );
  }

  const requiredScript = TARGET_SCRIPTS[targetCode];
  if (requiredScript && !requiredScript.test(text)) return false;
  const letterCount = text.match(/\p{L}/gu)?.length ?? 0;
  if (letterCount < MINIMUM_DETECTION_LETTERS) return false;

  const scores = detector(text)
    .map((score) => ({ ...score, lang: normalizeLanguageCode(score.lang) }))
    .filter((score): score is LanguageScore => Boolean(score.lang))
    .sort((left, right) => right.accuracy - left.accuracy);
  const [first, second] = scores;
  if (!first || first.lang !== targetCode) return false;
  return (
    first.accuracy >= MINIMUM_TOP_ACCURACY &&
    first.accuracy - (second?.accuracy ?? 0) >= MINIMUM_ACCURACY_LEAD
  );
}

function getChineseVariant(language: string): 'Hans' | 'Hant' | undefined {
  const normalized = language.trim().toLowerCase();
  if (['simplified chinese', 'chinese (simplified)'].includes(normalized)) return 'Hans';
  if (['traditional chinese', 'chinese (traditional)'].includes(normalized)) return 'Hant';
  if (!/^zh(?:-|$)/u.test(normalized)) return undefined;
  const parts = normalized.split('-');
  if (parts.includes('hans')) return 'Hans';
  if (parts.includes('hant')) return 'Hant';
  if (parts.some((part) => ['cn', 'sg'].includes(part))) return 'Hans';
  if (parts.some((part) => ['tw', 'hk', 'mo'].includes(part))) return 'Hant';
  return undefined;
}

function detectLanguages(text: string): LanguageScore[] {
  return detectAll(text).map((score) => ({
    lang: normalizeLanguageCode(toISO2(score.lang) || score.lang),
    accuracy: score.accuracy,
  }));
}

function resolveTargetLanguageCode(targetLanguage: string): string | undefined {
  const normalized = targetLanguage.trim().toLowerCase();
  return TARGET_LANGUAGE_CODES[normalized] ?? normalizeKnownLanguageCode(normalized);
}

function normalizeKnownLanguageCode(value: string): string | undefined {
  if (/^[a-z]{2}(?:-[a-z0-9]+)*$/u.test(value)) return value.split('-')[0];
  return undefined;
}

function normalizeLanguageCode(value: string | undefined): string {
  if (!value) return '';
  const normalized = value.trim().toLowerCase().split(/[-_]/u)[0];
  if (normalized.length === 3) return toISO2(normalized) || normalized;
  return normalized;
}
