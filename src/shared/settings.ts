export type DisplayMode = 'bilingual' | 'translation';

export interface TranslationProfile {
  id: string;
  name: string;
  apiUrl: string;
  apiKey: string;
  model: string;
  translationPrompt: string;
}

export interface TranslatorSettings {
  profiles: TranslationProfile[];
  activeProfileId: string;
  targetLanguage: string;
  displayMode: DisplayMode;
  translateDynamicContent: boolean;
  /** Maximum concurrent batches in a page translation operation. */
  translationConcurrency: number;
  excludedSites: string[];
  autoTranslateSites: string[];
}

export type TranslationProfileValidationErrors = Partial<
  Record<'name' | 'apiUrl' | 'model' | 'translationPrompt', string>
>;

export interface SettingsValidationErrors {
  profiles?: string;
  activeProfileId?: string;
  targetLanguage?: string;
  profileErrors: Record<string, TranslationProfileValidationErrors>;
}

export interface SettingsValidationResult {
  valid: boolean;
  errors: SettingsValidationErrors;
}

export const SETTINGS_STORAGE_KEY = 'translatorSettings';
export const MAX_TRANSLATION_CONCURRENCY = 6;
export const DEFAULT_PROFILE_ID = 'profile-default';
export const MAX_TRANSLATION_PROMPT_CHARACTERS = 8_000;
export const DEFAULT_TRANSLATION_PROMPT = [
  'You are a professional webpage translator.',
  'Translate every segment naturally and accurately into {{targetLanguage}}.',
  'Preserve meaning, tone, names, numbers, URLs, placeholders, and inline formatting markers.',
].join(' ');

export const DEFAULT_SETTINGS: TranslatorSettings = {
  profiles: [
    {
      id: DEFAULT_PROFILE_ID,
      name: '默认配置',
      apiUrl: 'https://api.openai.com/v1',
      apiKey: '',
      model: '',
      translationPrompt: DEFAULT_TRANSLATION_PROMPT,
    },
  ],
  activeProfileId: DEFAULT_PROFILE_ID,
  targetLanguage: 'Simplified Chinese',
  displayMode: 'bilingual',
  translateDynamicContent: true,
  translationConcurrency: 6,
  excludedSites: [],
  autoTranslateSites: [],
};

/** Converts a base URL or v1 URL into the one Chat Completions endpoint we support. */
export function normalizeApiUrl(input: string): string {
  const url = new URL(input.trim());
  const pathname = url.pathname.replace(/\/+$/u, '');
  if (pathname.endsWith('/chat/completions')) url.pathname = pathname;
  else if (pathname.endsWith('/v1')) url.pathname = `${pathname}/chat/completions`;
  else url.pathname = `${pathname}/v1/chat/completions`;
  url.hash = '';
  return url.toString();
}

/** Returns the selected profile without silently falling back to another provider. */
export function getActiveProfile(
  settings: TranslatorSettings,
  profileId = settings.activeProfileId,
): TranslationProfile | undefined {
  return settings.profiles.find((profile) => profile.id === profileId);
}

export function validateTranslationProfile(
  profile: TranslationProfile,
): TranslationProfileValidationErrors {
  const errors: TranslationProfileValidationErrors = {};
  if (!profile.name.trim()) errors.name = '请填写配置名称';
  try {
    const url = new URL(normalizeApiUrl(profile.apiUrl));
    if (!['https:', 'http:'].includes(url.protocol)) errors.apiUrl = '只支持 HTTP 或 HTTPS 地址';
    else if (url.protocol === 'http:' && profile.apiKey.trim() && !isLoopbackHost(url.hostname)) {
      errors.apiUrl = '携带 API Key 时必须使用 HTTPS（localhost 除外）';
    }
  } catch {
    errors.apiUrl = '请输入有效的 API 地址';
  }
  if (!profile.model.trim()) errors.model = '请填写模型名称';
  if (!profile.translationPrompt.trim()) errors.translationPrompt = '请填写翻译 Prompt';
  else if (profile.translationPrompt.length > MAX_TRANSLATION_PROMPT_CHARACTERS) {
    errors.translationPrompt = `翻译 Prompt 不能超过 ${MAX_TRANSLATION_PROMPT_CHARACTERS} 个字符`;
  }
  return errors;
}

export function validateSettings(settings: TranslatorSettings): SettingsValidationResult {
  const errors: SettingsValidationErrors = { profileErrors: {} };
  if (settings.profiles.length === 0) errors.profiles = '至少保留一个翻译配置';
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const profile of settings.profiles) {
    const profileErrors = validateTranslationProfile(profile);
    if (!profile.id.trim() || ids.has(profile.id)) errors.profiles = '翻译配置 ID 必须唯一';
    ids.add(profile.id);
    const normalizedName = profile.name.trim().toLowerCase();
    if (normalizedName && names.has(normalizedName)) errors.profiles = '翻译配置名称不能重复';
    names.add(normalizedName);
    if (Object.keys(profileErrors).length > 0) errors.profileErrors[profile.id] = profileErrors;
  }
  if (!getActiveProfile(settings)) errors.activeProfileId = '当前翻译配置不存在';
  if (!settings.targetLanguage.trim()) errors.targetLanguage = '请填写目标语言';
  return {
    valid:
      Object.keys(errors.profileErrors).length === 0 &&
      !errors.profiles &&
      !errors.activeProfileId &&
      !errors.targetLanguage,
    errors,
  };
}

/** Picks the first actionable validation message for UI and runtime responses. */
export function getSettingsValidationMessage(result: SettingsValidationResult): string | undefined {
  if (result.errors.profiles) return result.errors.profiles;
  if (result.errors.activeProfileId) return result.errors.activeProfileId;
  if (result.errors.targetLanguage) return result.errors.targetLanguage;
  for (const profileErrors of Object.values(result.errors.profileErrors)) {
    const message =
      profileErrors.name ??
      profileErrors.apiUrl ??
      profileErrors.model ??
      profileErrors.translationPrompt;
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

export function mergeSettings(value: unknown): TranslatorSettings {
  if (!isRecord(value)) return cloneDefaultSettings();
  const profiles = Array.isArray(value.profiles)
    ? value.profiles.filter(isRecord).map((profile) => ({
        id: readString(profile.id, ''),
        name: readString(profile.name, ''),
        apiUrl: readString(profile.apiUrl, ''),
        apiKey: readString(profile.apiKey, ''),
        model: readString(profile.model, ''),
        // A blank Prompt is never a valid saved state; initialize it from the product default.
        translationPrompt: readTranslationPrompt(profile.translationPrompt),
      }))
    : [];
  const resolvedProfiles = profiles.length > 0 ? profiles : cloneDefaultSettings().profiles;
  return {
    profiles: resolvedProfiles,
    activeProfileId: readString(
      value.activeProfileId,
      resolvedProfiles[0]?.id ?? DEFAULT_PROFILE_ID,
    ),
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
  if (!value || value.includes('/') || value.includes(':')) throw new Error('站点域名无效');
  const hostname = new URL(`https://${value}`).hostname.toLowerCase();
  if (hostname !== value) throw new Error('站点域名无效');
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
  if (wildcard && !allowWildcard) throw new Error('自动翻译仅支持精确域名');
  const host = wildcard ? value.slice(2) : value;
  if (
    !/^[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?$/u.test(host) ||
    host.includes('..') ||
    host
      .split('.')
      .some((label) => label.startsWith('-') || label.endsWith('-') || label.length > 63) ||
    host.length > 253
  ) {
    throw new Error('请输入有效域名，不包含协议、路径或端口');
  }
  return `${wildcard ? '*.' : ''}${normalizeHostname(host)}`;
}

function cloneDefaultSettings(): TranslatorSettings {
  return {
    ...DEFAULT_SETTINGS,
    profiles: DEFAULT_SETTINGS.profiles.map((profile) => ({ ...profile })),
  };
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
