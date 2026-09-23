import {
  message,
  LocalizedError,
  toUiMessage,
  type UiMessage,
  t,
  isUiLanguage,
  type UiLanguage,
} from './i18n';
import {
  DEFAULT_PROVIDER_OPTIONS,
  isProvider,
  isProtocol,
  normalizeEndpoint,
  resolveProviderOptions,
  THINKING_CONTROLS,
  REASONING_EFFORTS,
  type ProviderOptions,
  type ApiProtocol,
  type ThinkingControl,
  type ReasoningEffort,
} from './providers';
import {
  DEFAULT_ACTIVE_TRANSLATOR,
  isActiveTranslator,
  type ActiveTranslator,
} from './translation-engines';
export type DisplayMode = 'bilingual' | 'translation';

export interface TranslationProfile extends ProviderOptions {
  id: string;
  name: string;
  apiUrl: string;
  apiKey: string;
  model: string;
  /** Per-profile reasoning preference, resolved using the selected provider and protocol. */
  thinkingEnabled: boolean;
  /** Explicit choice for custom endpoints/models; official presets use the capability catalog. */
  imageInputEnabled: boolean;
  translationPrompt: string;
}

export interface TranslatorSettings {
  schemaVersion: typeof SETTINGS_SCHEMA_VERSION;
  /** Interface preference, independent of translation target and session identity. */
  uiLanguage: UiLanguage;
  profiles: TranslationProfile[];
  activeTranslator: ActiveTranslator;
  targetLanguage: string;
  displayMode: DisplayMode;
  translateDynamicContent: boolean;
  /** Maximum concurrent batches in a page translation operation. */
  translationConcurrency: number;
  /** Additional attempts per ordinary translation batch; zero disables automatic retry. */
  translationRetryCount: number;
  /** Hard deadline of an admitted full-document request, independent of idle protection. */
  fullDocumentTimeoutMinutes: number;
  excludedSites: string[];
  autoTranslateSites: string[];
}

export type TranslationProfileValidationErrors = Partial<
  Record<
    | 'name'
    | 'apiUrl'
    | 'model'
    | 'translationPrompt'
    | 'thinkingEnabled'
    | 'imageInputEnabled'
    | 'provider'
    | 'protocol'
    | 'thinkingControl',
    UiMessage
  >
>;

export interface SettingsValidationErrors {
  profiles?: UiMessage;
  activeTranslator?: UiMessage;
  targetLanguage?: UiMessage;
  profileErrors: Record<string, TranslationProfileValidationErrors>;
}

export interface SettingsValidationResult {
  valid: boolean;
  errors: SettingsValidationErrors;
}

export const SETTINGS_STORAGE_KEY = 'translatorSettings';
export const SETTINGS_SCHEMA_VERSION = 2 as const;
export const MAX_TRANSLATION_CONCURRENCY = 6;
export const MAX_TRANSLATION_RETRY_COUNT = 5;
export function isValidFullDocumentTimeout(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 2 && value <= 60;
}
export const DEFAULT_PROFILE_ID = 'profile-default';
export const MAX_TRANSLATION_PROMPT_CHARACTERS = 8_000;
export const DEFAULT_TRANSLATION_PROMPT = [
  'You are a professional webpage translator.',
  'Translate every segment naturally and accurately into {{targetLanguage}}.',
  'Preserve meaning, tone, names, numbers, URLs, placeholders, and inline formatting markers.',
].join(' ');

export const DEFAULT_SETTINGS: TranslatorSettings = {
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  uiLanguage: 'system',
  profiles: [
    {
      ...DEFAULT_PROVIDER_OPTIONS,
      id: DEFAULT_PROFILE_ID,
      name: '默认配置',
      apiUrl: '',
      apiKey: '',
      model: '',
      thinkingEnabled: false,
      imageInputEnabled: false,
      translationPrompt: DEFAULT_TRANSLATION_PROMPT,
    },
  ],
  activeTranslator: { ...DEFAULT_ACTIVE_TRANSLATOR },
  targetLanguage: 'Simplified Chinese',
  displayMode: 'bilingual',
  translateDynamicContent: true,
  translationConcurrency: 4,
  translationRetryCount: 1,
  fullDocumentTimeoutMinutes: 10,
  excludedSites: [],
  autoTranslateSites: [],
};

/** Normalizes the endpoint using the explicitly selected wire protocol. */
export function normalizeApiUrl(input: string, protocol: ApiProtocol = 'openai'): string {
  return normalizeEndpoint(input, protocol);
}

/** Returns the selected profile without silently falling back to another provider. */
export function getActiveProfile(
  settings: TranslatorSettings,
  profileId = settings.activeTranslator.kind === 'ai'
    ? settings.activeTranslator.profileId
    : undefined,
): TranslationProfile | undefined {
  if (!profileId) return undefined;
  return settings.profiles.find((profile) => profile.id === profileId);
}

export function validateTranslationProfile(
  profile: TranslationProfile,
): TranslationProfileValidationErrors {
  const errors: TranslationProfileValidationErrors = {};
  if (!isProvider(profile.provider)) errors.provider = message('请补全供应商');
  if (!isProtocol(profile.protocol)) errors.protocol = message('请补全接入协议');
  if (!profile.name.trim()) errors.name = message('请填写配置名称');
  try {
    const url = new URL(normalizeApiUrl(profile.apiUrl, profile.protocol ?? 'openai'));
    if (!['https:', 'http:'].includes(url.protocol))
      errors.apiUrl = message('只支持 HTTP 或 HTTPS 地址');
    else if (url.protocol === 'http:' && profile.apiKey.trim() && !isLoopbackHost(url.hostname)) {
      errors.apiUrl = message('携带 API Key 时必须使用 HTTPS（localhost 除外）');
    }
  } catch (error) {
    errors.apiUrl =
      error instanceof TypeError
        ? message('请输入有效的 API 地址')
        : error instanceof Error
          ? toUiMessage(error)
          : message('请输入有效的 API 地址');
  }
  if (!profile.model.trim()) errors.model = message('请填写模型名称');
  if (typeof profile.thinkingEnabled !== 'boolean')
    errors.thinkingEnabled = message('思考开关必须为开启或关闭');
  if (typeof profile.imageInputEnabled !== 'boolean')
    errors.imageInputEnabled = message('图片输入开关必须为开启或关闭');
  if (!profile.translationPrompt.trim()) errors.translationPrompt = message('请填写翻译 Prompt');
  else if (profile.translationPrompt.length > MAX_TRANSLATION_PROMPT_CHARACTERS) {
    errors.translationPrompt = message('翻译 Prompt 不能超过 {{p0}} 个字符', {
      p0: MAX_TRANSLATION_PROMPT_CHARACTERS,
    });
  }
  if (isProvider(profile.provider) && isProtocol(profile.protocol)) {
    try {
      resolveProviderOptions(profile);
    } catch (error) {
      errors.thinkingControl =
        error instanceof Error ? toUiMessage(error) : message('思考设置无效');
    }
  }
  return errors;
}

export function validateSettings(settings: TranslatorSettings): SettingsValidationResult {
  const errors: SettingsValidationErrors = { profileErrors: {} };
  if (settings.profiles.length === 0) errors.profiles = message('至少保留一个翻译配置');
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const profile of settings.profiles) {
    const profileErrors = validateTranslationProfile(profile);
    if (!profile.id.trim() || ids.has(profile.id))
      errors.profiles = message('翻译配置 ID 必须唯一');
    ids.add(profile.id);
    const normalizedName = profile.name.trim().toLowerCase();
    if (normalizedName && names.has(normalizedName))
      errors.profiles = message('翻译配置名称不能重复');
    names.add(normalizedName);
    if (Object.keys(profileErrors).length > 0) errors.profileErrors[profile.id] = profileErrors;
  }
  if (settings.activeTranslator.kind === 'ai' && !getActiveProfile(settings))
    errors.activeTranslator = message('当前翻译配置不存在');
  if (!settings.targetLanguage.trim()) errors.targetLanguage = message('请填写目标语言');
  return {
    valid:
      Object.keys(errors.profileErrors).length === 0 &&
      !errors.profiles &&
      !errors.activeTranslator &&
      !errors.targetLanguage,
    errors,
  };
}

/** Picks the first actionable validation message for UI and runtime responses. */
export function getSettingsValidationMessage(
  result: SettingsValidationResult,
): UiMessage | undefined {
  if (result.errors.profiles) return result.errors.profiles;
  if (result.errors.activeTranslator) return result.errors.activeTranslator;
  if (result.errors.targetLanguage) return result.errors.targetLanguage;
  for (const profileErrors of Object.values(result.errors.profileErrors)) {
    const message =
      profileErrors.provider ??
      profileErrors.protocol ??
      profileErrors.thinkingControl ??
      profileErrors.name ??
      profileErrors.apiUrl ??
      profileErrors.model ??
      profileErrors.translationPrompt ??
      profileErrors.thinkingEnabled ??
      profileErrors.imageInputEnabled;
    if (message) return message;
  }
  return undefined;
}

/** Accept only supported integer limits at storage and runtime-message boundaries. */
export function isValidTranslationConcurrency(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_TRANSLATION_CONCURRENCY
  );
}

/** Validates the shared retry budget at storage and runtime-message boundaries. */
export function isValidTranslationRetryCount(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_TRANSLATION_RETRY_COUNT
  );
}

export function mergeSettings(value: unknown): TranslatorSettings {
  if (!isRecord(value)) return cloneDefaultSettings();
  const profiles = Array.isArray(value.profiles)
    ? value.profiles.filter(isRecord).map((profile) => ({
        ...DEFAULT_PROVIDER_OPTIONS,
        provider: isProvider(profile.provider) ? profile.provider : null,
        protocol: isProtocol(profile.protocol) ? profile.protocol : null,
        thinkingControl: (THINKING_CONTROLS as readonly unknown[]).includes(profile.thinkingControl)
          ? (profile.thinkingControl as ThinkingControl)
          : 'auto',
        reasoningEffort: (REASONING_EFFORTS as readonly unknown[]).includes(profile.reasoningEffort)
          ? (profile.reasoningEffort as ReasoningEffort)
          : 'default',
        thinkingBudgetTokens:
          typeof profile.thinkingBudgetTokens === 'number' ? profile.thinkingBudgetTokens : 2048,
        maxOutputTokens:
          typeof profile.maxOutputTokens === 'number' ? profile.maxOutputTokens : null,
        id: readString(profile.id, ''),
        name: readString(profile.name, ''),
        apiUrl: readString(profile.apiUrl, ''),
        apiKey: readString(profile.apiKey, ''),
        model: readString(profile.model, ''),
        thinkingEnabled:
          typeof profile.thinkingEnabled === 'boolean' ? profile.thinkingEnabled : false,
        imageInputEnabled: profile.imageInputEnabled === true,
        // A blank Prompt is never a valid saved state; initialize it from the product default.
        translationPrompt: readTranslationPrompt(profile.translationPrompt),
      }))
    : [];
  const resolvedProfiles = profiles.length > 0 ? profiles : cloneDefaultSettings().profiles;
  const activeTranslator = isActiveTranslator(value.activeTranslator)
    ? cloneActiveTranslator(value.activeTranslator)
    : typeof value.activeProfileId === 'string' && value.activeProfileId.trim()
      ? ({ kind: 'ai', profileId: value.activeProfileId } satisfies ActiveTranslator)
      : cloneActiveTranslator(DEFAULT_ACTIVE_TRANSLATOR);
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    profiles: resolvedProfiles,
    uiLanguage: isUiLanguage(value.uiLanguage) ? value.uiLanguage : 'system',
    activeTranslator,
    targetLanguage: readString(value.targetLanguage, DEFAULT_SETTINGS.targetLanguage),
    displayMode:
      value.displayMode === 'bilingual' || value.displayMode === 'translation'
        ? value.displayMode
        : DEFAULT_SETTINGS.displayMode,
    translateDynamicContent:
      typeof value.translateDynamicContent === 'boolean'
        ? value.translateDynamicContent
        : DEFAULT_SETTINGS.translateDynamicContent,
    translationConcurrency: isValidTranslationConcurrency(value.translationConcurrency)
      ? value.translationConcurrency
      : DEFAULT_SETTINGS.translationConcurrency,
    translationRetryCount: isValidTranslationRetryCount(value.translationRetryCount)
      ? value.translationRetryCount
      : DEFAULT_SETTINGS.translationRetryCount,
    fullDocumentTimeoutMinutes: isValidFullDocumentTimeout(value.fullDocumentTimeoutMinutes)
      ? value.fullDocumentTimeoutMinutes
      : DEFAULT_SETTINGS.fullDocumentTimeoutMinutes,
    excludedSites: readStringArray(value.excludedSites),
    autoTranslateSites: readStringArray(value.autoTranslateSites),
  };
}

/** Matches exact hosts and explicit wildcard subdomains such as *.example.com. */
export function isUrlExcluded(url: string, patterns: string[]): boolean {
  const hostname = readHostname(url);
  if (!hostname) return false;
  return patterns.some((rawPattern) => {
    const pattern = rawPattern.trim().toLowerCase();
    if (!pattern) return false;
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1);
      return hostname.endsWith(suffix) && hostname !== pattern.slice(2);
    }
    return hostname === pattern;
  });
}

/** Auto translation is intentionally exact-host only, so a rule cannot expand unexpectedly. */
export function isUrlAutoTranslated(url: string, sites: string[]): boolean {
  const hostname = readHostname(url);
  return Boolean(hostname && sites.some((site) => site.trim().toLowerCase() === hostname));
}

export function normalizeHostname(input: string): string {
  const value = input.trim().toLowerCase().replace(/\.$/u, '');
  if (!value || value.includes('/') || value.includes(':'))
    throw new LocalizedError(message('站点域名无效'));
  const hostname = new URL(`https://${value}`).hostname.toLowerCase();
  if (hostname !== value) throw new LocalizedError(message('站点域名无效'));
  return hostname;
}

/** Normalizes user-entered values once at the profile persistence boundary. */
export function normalizeTranslationProfile(profile: TranslationProfile): TranslationProfile {
  return {
    ...profile,
    id: profile.id.trim(),
    name: profile.name.trim(),
    apiUrl: profile.apiUrl.trim(),
    model: profile.model.trim(),
    translationPrompt: profile.translationPrompt.trim(),
  };
}

/** Validates a hostname, allowing an explicit wildcard only for exclusion rules. */
export function normalizeSiteRule(input: string, allowWildcard: boolean): string {
  const value = input.trim().toLowerCase().replace(/\.$/u, '');
  const wildcard = value.startsWith('*.');
  if (wildcard && !allowWildcard) throw new LocalizedError(message('自动翻译仅支持精确域名'));
  const host = wildcard ? value.slice(2) : value;
  if (
    !/^[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?$/u.test(host) ||
    host.includes('..') ||
    host
      .split('.')
      .some((label) => label.startsWith('-') || label.endsWith('-') || label.length > 63) ||
    host.length > 253
  ) {
    throw new LocalizedError(message('请输入有效域名，不包含协议、路径或端口'));
  }
  return `${wildcard ? '*.' : ''}${normalizeHostname(host)}`;
}

function cloneDefaultSettings(): TranslatorSettings {
  return {
    ...DEFAULT_SETTINGS,
    activeTranslator: cloneActiveTranslator(DEFAULT_SETTINGS.activeTranslator),
    profiles: DEFAULT_SETTINGS.profiles.map((profile) => ({ ...profile, name: t('默认配置') })),
  };
}

function cloneActiveTranslator(translator: ActiveTranslator): ActiveTranslator {
  return translator.kind === 'builtin'
    ? { kind: 'builtin', engine: translator.engine }
    : { kind: 'ai', profileId: translator.profileId };
}

function readTranslationPrompt(value: unknown): string {
  const prompt = readString(value, '');
  return prompt.trim() ? prompt : DEFAULT_TRANSLATION_PROMPT;
}

function readHostname(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || hostname.startsWith('127.');
}

function readString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}
