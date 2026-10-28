import { getUiLocale } from './i18n';
import type { BuiltinTranslatorId } from './translation-engines';

export interface TranslationLanguage {
  /** Stable stored value, cache identity and the name sent to AI prompts. */
  id: string;
  /** BCP 47 tag used for localized display names and local language checks. */
  code: string;
  /** Exact free-engine codes; a missing code means that engine cannot translate into it. */
  'google-free'?: string;
  'microsoft-free'?: string;
  /** Listed first in pickers. */
  common?: true;
}

type LanguageRow = [id: string, code: string, google: string | null, microsoft: string | null];

const row = ([id, code, google, microsoft]: LanguageRow, common = false): TranslationLanguage => ({
  id,
  code,
  ...(google ? { 'google-free': google } : {}),
  ...(microsoft ? { 'microsoft-free': microsoft } : {}),
  ...(common ? { common: true as const } : {}),
});

// Microsoft codes follow the public Translator `/languages?scope=translation` catalog; Google codes
// follow its published language table. Existing ids are unchanged so stored settings and caches stay valid.
const COMMON_ROWS: LanguageRow[] = [
  ['Simplified Chinese', 'zh-Hans', 'zh-CN', 'zh-Hans'],
  ['Traditional Chinese', 'zh-Hant', 'zh-TW', 'zh-Hant'],
  ['English', 'en', 'en', 'en'],
  ['Japanese', 'ja', 'ja', 'ja'],
  ['Korean', 'ko', 'ko', 'ko'],
  ['French', 'fr', 'fr', 'fr'],
  ['German', 'de', 'de', 'de'],
  ['Spanish', 'es', 'es', 'es'],
  ['Arabic', 'ar', 'ar', 'ar'],
];

const OTHER_ROWS: LanguageRow[] = [
  ['Afrikaans', 'af', 'af', 'af'],
  ['Albanian', 'sq', 'sq', 'sq'],
  ['Amharic', 'am', 'am', 'am'],
  ['Armenian', 'hy', 'hy', 'hy'],
  ['Assamese', 'as', 'as', 'as'],
  ['Azerbaijani', 'az', 'az', 'az'],
  ['Basque', 'eu', 'eu', 'eu'],
  ['Belarusian', 'be', 'be', 'be'],
  ['Bengali', 'bn', 'bn', 'bn'],
  ['Bosnian', 'bs', 'bs', 'bs'],
  ['Bulgarian', 'bg', 'bg', 'bg'],
  ['Burmese', 'my', 'my', 'my'],
  ['Cantonese', 'yue', 'yue', 'yue'],
  ['Catalan', 'ca', 'ca', 'ca'],
  ['Croatian', 'hr', 'hr', 'hr'],
  ['Czech', 'cs', 'cs', 'cs'],
  ['Danish', 'da', 'da', 'da'],
  ['Dutch', 'nl', 'nl', 'nl'],
  ['Esperanto', 'eo', 'eo', null],
  ['Estonian', 'et', 'et', 'et'],
  ['Filipino', 'fil', 'tl', 'fil'],
  ['Finnish', 'fi', 'fi', 'fi'],
  ['Galician', 'gl', 'gl', 'gl'],
  ['Georgian', 'ka', 'ka', 'ka'],
  ['Greek', 'el', 'el', 'el'],
  ['Gujarati', 'gu', 'gu', 'gu'],
  ['Haitian Creole', 'ht', 'ht', 'ht'],
  ['Hausa', 'ha', 'ha', 'ha'],
  ['Hebrew', 'he', 'iw', 'he'],
  ['Hindi', 'hi', 'hi', 'hi'],
  ['Hungarian', 'hu', 'hu', 'hu'],
  ['Icelandic', 'is', 'is', 'is'],
  ['Igbo', 'ig', 'ig', 'ig'],
  ['Indonesian', 'id', 'id', 'id'],
  ['Irish', 'ga', 'ga', 'ga'],
  ['Italian', 'it', 'it', 'it'],
  ['Kannada', 'kn', 'kn', 'kn'],
  ['Kazakh', 'kk', 'kk', 'kk'],
  ['Khmer', 'km', 'km', 'km'],
  ['Kyrgyz', 'ky', 'ky', 'ky'],
  ['Lao', 'lo', 'lo', 'lo'],
  ['Latin', 'la', 'la', null],
  ['Latvian', 'lv', 'lv', 'lv'],
  ['Lingala', 'ln', 'ln', 'ln'],
  ['Lithuanian', 'lt', 'lt', 'lt'],
  ['Luxembourgish', 'lb', 'lb', 'lb'],
  ['Macedonian', 'mk', 'mk', 'mk'],
  ['Malagasy', 'mg', 'mg', 'mg'],
  ['Malay', 'ms', 'ms', 'ms'],
  ['Malayalam', 'ml', 'ml', 'ml'],
  ['Maltese', 'mt', 'mt', 'mt'],
  ['Maori', 'mi', 'mi', 'mi'],
  ['Marathi', 'mr', 'mr', 'mr'],
  ['Mongolian', 'mn', 'mn', 'mn-Cyrl'],
  ['Nepali', 'ne', 'ne', 'ne'],
  ['Norwegian', 'no', 'no', 'nb'],
  ['Odia', 'or', 'or', 'or'],
  ['Pashto', 'ps', 'ps', 'ps'],
  ['Persian', 'fa', 'fa', 'fa'],
  ['Polish', 'pl', 'pl', 'pl'],
  ['Portuguese', 'pt', 'pt', 'pt'],
  ['European Portuguese', 'pt-PT', 'pt-PT', 'pt-PT'],
  ['Punjabi', 'pa', 'pa', 'pa'],
  ['Romanian', 'ro', 'ro', 'ro'],
  ['Russian', 'ru', 'ru', 'ru'],
  ['Samoan', 'sm', 'sm', 'sm'],
  ['Serbian', 'sr', 'sr', 'sr-Cyrl'],
  ['Sinhala', 'si', 'si', 'si'],
  ['Slovak', 'sk', 'sk', 'sk'],
  ['Slovenian', 'sl', 'sl', 'sl'],
  ['Somali', 'so', 'so', 'so'],
  ['Swahili', 'sw', 'sw', 'sw'],
  ['Swedish', 'sv', 'sv', 'sv'],
  ['Tamil', 'ta', 'ta', 'ta'],
  ['Tatar', 'tt', 'tt', 'tt'],
  ['Telugu', 'te', 'te', 'te'],
  ['Thai', 'th', 'th', 'th'],
  ['Tigrinya', 'ti', 'ti', 'ti'],
  ['Turkish', 'tr', 'tr', 'tr'],
  ['Turkmen', 'tk', 'tk', 'tk'],
  ['Ukrainian', 'uk', 'uk', 'uk'],
  ['Urdu', 'ur', 'ur', 'ur'],
  ['Uyghur', 'ug', 'ug', 'ug'],
  ['Uzbek', 'uz', 'uz', 'uz'],
  ['Vietnamese', 'vi', 'vi', 'vi'],
  ['Welsh', 'cy', 'cy', 'cy'],
  ['Xhosa', 'xh', 'xh', 'xh'],
  ['Yoruba', 'yo', 'yo', 'yo'],
  ['Zulu', 'zu', 'zu', 'zu'],
];

/** Product-owned presets. User-entered custom names remain AI-only and are never listed here. */
export const TRANSLATION_LANGUAGES: readonly TranslationLanguage[] = [
  ...COMMON_ROWS.map((value) => row(value, true)),
  ...OTHER_ROWS.map((value) => row(value)),
];

const BY_ID = new Map(TRANSLATION_LANGUAGES.map((language) => [language.id, language]));

export function findTranslationLanguage(id: string): TranslationLanguage | undefined {
  return BY_ID.get(id);
}

export function isPresetTranslationLanguage(id: string): boolean {
  return BY_ID.has(id);
}

export function builtinLanguageCode(engine: BuiltinTranslatorId, id: string): string | undefined {
  return BY_ID.get(id)?.[engine];
}

const displayNames = new Map<string, Intl.DisplayNames | null>();

/** Browser-localized, capitalized name for a BCP 47 tag; one formatter per UI locale. */
function displayLanguageName(code: string): string | undefined {
  const locale = getUiLocale();
  if (!displayNames.has(locale)) {
    try {
      displayNames.set(locale, new Intl.DisplayNames([locale], { type: 'language' }));
    } catch {
      displayNames.set(locale, null);
    }
  }
  try {
    const name = displayNames.get(locale)?.of(code);
    // French and others lowercase language names; a picker entry reads as a capitalized label.
    return name ? name.charAt(0).toLocaleUpperCase(locale) + name.slice(1) : undefined;
  } catch {
    return undefined;
  }
}

/** Localizes presets with the browser's own language names; custom names stay verbatim. */
export function translationLanguageLabel(value: string): string {
  const language = BY_ID.get(value);
  if (!language) return value;
  return displayLanguageName(language.code) ?? language.id;
}

export function languageCodeLabel(code: string): string {
  return displayLanguageName(code) ?? code;
}

/** Labels are computed once per sort, and each locale's order is computed once per session. */
function sortByLabel<T>(items: readonly T[], label: (item: T) => string): T[] {
  const collator = new Intl.Collator(getUiLocale());
  return items
    .map((item) => ({ item, label: label(item) }))
    .sort((left, right) => collator.compare(left.label, right.label))
    .map(({ item }) => item);
}

const sortedLanguages = new Map<
  string,
  { common: TranslationLanguage[]; others: TranslationLanguage[] }
>();

/** Common presets first, then the rest sorted by the localized name. */
export function sortedTranslationLanguages(): {
  common: TranslationLanguage[];
  others: TranslationLanguage[];
} {
  const locale = getUiLocale();
  let sorted = sortedLanguages.get(locale);
  if (!sorted) {
    sorted = {
      common: TRANSLATION_LANGUAGES.filter((language) => language.common),
      others: sortByLabel(
        TRANSLATION_LANGUAGES.filter((language) => !language.common),
        (language) => translationLanguageLabel(language.id),
      ),
    };
    sortedLanguages.set(locale, sorted);
  }
  return sorted;
}

const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  iw: 'he',
  in: 'id',
  ji: 'yi',
  jw: 'jv',
  tl: 'fil',
  nb: 'no',
  nn: 'no',
};

/** Primary language subtag used by language rules: `zh-Hant` → `zh`, legacy `iw` → `he`. */
export function normalizeLanguageCode(tag: string): string | undefined {
  const base = tag.trim().toLowerCase().replaceAll('_', '-').split('-')[0];
  if (!/^[a-z]{2,3}$/u.test(base) || base === 'und') return undefined;
  return LANGUAGE_ALIASES[base] ?? base;
}

/** Chinese script named by a tag's script or region subtag; a bare `zh` names neither. */
export function chineseScript(tag: string): 'Hans' | 'Hant' | undefined {
  const parts = tag.trim().toLowerCase().replaceAll('_', '-').split('-');
  if (parts[0] !== 'zh') return undefined;
  if (parts.includes('hans') || parts.some((part) => ['cn', 'sg'].includes(part))) return 'Hans';
  if (parts.includes('hant') || parts.some((part) => ['tw', 'hk', 'mo'].includes(part)))
    return 'Hant';
  return undefined;
}

/**
 * Whether a page tagged `tag` is already in the preset target. Chinese also compares scripts, so a
 * Traditional page still counts as foreign to a Simplified reader; an unknown script never matches.
 */
export function isTargetLanguage(tag: string, targetId: string): boolean {
  const target = BY_ID.get(targetId);
  if (!target) return false;
  const language = normalizeLanguageCode(tag);
  if (!language || language !== normalizeLanguageCode(target.code)) return false;
  if (language !== 'zh') return true;
  const script = chineseScript(tag);
  return Boolean(script && script === chineseScript(target.code));
}

/** One entry per primary language for automatic-translation rules. */
export const RULE_LANGUAGE_CODES: readonly string[] = [
  ...new Set(TRANSLATION_LANGUAGES.map(({ code }) => normalizeLanguageCode(code)!)),
];

const sortedRuleCodes = new Map<string, string[]>();

export function sortedRuleLanguageCodes(): readonly string[] {
  const locale = getUiLocale();
  let sorted = sortedRuleCodes.get(locale);
  if (!sorted) {
    sorted = sortByLabel(RULE_LANGUAGE_CODES, languageCodeLabel);
    sortedRuleCodes.set(locale, sorted);
  }
  return sorted;
}
