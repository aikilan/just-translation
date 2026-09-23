export type BuiltinTranslatorId = 'google-free' | 'microsoft-free';

export type ActiveTranslator =
  { kind: 'builtin'; engine: BuiltinTranslatorId } | { kind: 'ai'; profileId: string };

export interface TranslationBatchLimits {
  maxCharacters: number;
  maxItems: number;
}

export interface BuiltinTranslatorLimits extends TranslationBatchLimits {
  maxConcurrency: number;
}

export const DEFAULT_ACTIVE_TRANSLATOR: ActiveTranslator = {
  kind: 'builtin',
  engine: 'google-free',
};

export const BUILTIN_TRANSLATOR_LIMITS: Readonly<BuiltinTranslatorLimits> = {
  maxCharacters: 1_000,
  maxItems: 1,
  maxConcurrency: 2,
};

const TARGET_LANGUAGE_CODES = {
  'Simplified Chinese': { 'google-free': 'zh-CN', 'microsoft-free': 'zh-Hans' },
  English: { 'google-free': 'en', 'microsoft-free': 'en' },
  Japanese: { 'google-free': 'ja', 'microsoft-free': 'ja' },
  Korean: { 'google-free': 'ko', 'microsoft-free': 'ko' },
  French: { 'google-free': 'fr', 'microsoft-free': 'fr' },
  German: { 'google-free': 'de', 'microsoft-free': 'de' },
  Spanish: { 'google-free': 'es', 'microsoft-free': 'es' },
  Arabic: { 'google-free': 'ar', 'microsoft-free': 'ar' },
} as const satisfies Record<string, Record<BuiltinTranslatorId, string>>;

export function isBuiltinTranslatorId(value: unknown): value is BuiltinTranslatorId {
  return value === 'google-free' || value === 'microsoft-free';
}

export function isActiveTranslator(value: unknown): value is ActiveTranslator {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const translator = value as Record<string, unknown>;
  return (
    (translator.kind === 'builtin' && isBuiltinTranslatorId(translator.engine)) ||
    (translator.kind === 'ai' &&
      typeof translator.profileId === 'string' &&
      Boolean(translator.profileId.trim()))
  );
}

export function activeTranslatorKey(translator: ActiveTranslator): string {
  return translator.kind === 'builtin'
    ? `builtin:${translator.engine}`
    : `ai:${translator.profileId}`;
}

/** Parses the public select value without allowing an unknown engine or an empty profile id. */
export function parseActiveTranslatorKey(value: string): ActiveTranslator | undefined {
  if (value.startsWith('builtin:')) {
    const engine = value.slice('builtin:'.length);
    return isBuiltinTranslatorId(engine) ? { kind: 'builtin', engine } : undefined;
  }
  if (value.startsWith('ai:')) {
    const profileId = value.slice('ai:'.length).trim();
    return profileId ? { kind: 'ai', profileId } : undefined;
  }
  return undefined;
}

export function activeTranslatorEquals(left: ActiveTranslator, right: ActiveTranslator): boolean {
  return activeTranslatorKey(left) === activeTranslatorKey(right);
}

export function builtinTranslatorLabel(engine: BuiltinTranslatorId): string {
  return engine === 'google-free'
    ? t('Google 翻译（非官方免费通道）')
    : t('Microsoft 翻译（非官方免费通道）');
}

/** Stable service name for compact recipient disclosures and translated selection metadata. */
export function builtinTranslatorName(engine: BuiltinTranslatorId): 'Google' | 'Microsoft' {
  return engine === 'google-free' ? 'Google' : 'Microsoft';
}

export function activeTranslatorName(
  translator: ActiveTranslator,
  profiles: readonly { id: string; name: string }[],
): string {
  if (translator.kind === 'builtin') return builtinTranslatorName(translator.engine);
  return profiles.find((profile) => profile.id === translator.profileId)?.name ?? t('AI 配置');
}

/** Free consumer endpoints accept only product-owned presets; custom names remain AI-only. */
export function resolveBuiltinTargetLanguage(
  engine: BuiltinTranslatorId,
  targetLanguage: string,
): string | undefined {
  return TARGET_LANGUAGE_CODES[targetLanguage as keyof typeof TARGET_LANGUAGE_CODES]?.[engine];
}
import { t } from './i18n';
