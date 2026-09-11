import { detectAll, toISO2 } from 'tinyld/light';

export interface LanguageScore {
  lang: string;
  accuracy: number;
}

export type LanguageDetector = (text: string) => LanguageScore[];

const TARGET_LANGUAGE_CODES: Readonly<Record<string, string>> = {
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
  ru: /\p{Script=Cyrillic}/u,
  ar: /\p{Script=Arabic}/u,
  hi: /\p{Script=Devanagari}/u,
};

/** Skips only declared or strongly detected target-language content to avoid false negatives. */
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
    return getChineseVariant(declaredLanguage ?? '') === targetVariant;
  }

  if (normalizeLanguageCode(declaredLanguage) === targetCode) return true;
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
