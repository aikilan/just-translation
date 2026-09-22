import { message, LocalizedError, isUiLanguage, type UiLanguage } from '../shared/i18n';
import type {
  PublicTranslatorSettings,
  ReadingPreferences,
  SiteRuleUpdate,
} from '../shared/messages';
import {
  getActiveProfile,
  isValidTranslationConcurrency,
  isValidTranslationRetryCount,
  MAX_TRANSLATION_RETRY_COUNT,
  MAX_TRANSLATION_CONCURRENCY,
  normalizeTranslationProfile,
  normalizeSiteRule,
  validateTranslationProfile,
  type TranslationProfile,
  type TranslatorSettings,
} from '../shared/settings';
import { getSettings, updateStoredSettings } from '../shared/settings-store';

export async function readPublicSettings(): Promise<PublicTranslatorSettings> {
  return toPublicSettings(await getSettings());
}

/** Saves exactly one profile; editing a profile never implicitly activates it. */
export async function saveTranslationProfile(
  profile: TranslationProfile,
): Promise<PublicTranslatorSettings> {
  const normalized = normalizeTranslationProfile(profile);
  const error = Object.values(validateTranslationProfile(normalized))[0];
  if (error) throw new LocalizedError(error);
  if (!normalized.id) throw new LocalizedError(message('配置 ID 不能为空'));
  return toPublicSettings(
    await updateStoredSettings((settings) => {
      if (
        settings.profiles.some(
          (item) =>
            item.id !== normalized.id && item.name.toLowerCase() === normalized.name.toLowerCase(),
        )
      ) {
        throw new LocalizedError(message('翻译配置名称不能重复'));
      }
      const exists = settings.profiles.some((item) => item.id === normalized.id);
      return {
        ...settings,
        profiles: exists
          ? settings.profiles.map((item) => (item.id === normalized.id ? normalized : item))
          : [...settings.profiles, normalized],
      };
    }),
  );
}

export async function deleteTranslationProfile(
  profileId: string,
): Promise<PublicTranslatorSettings> {
  return toPublicSettings(
    await updateStoredSettings((settings) => {
      if (!getActiveProfile(settings, profileId))
        throw new LocalizedError(message('翻译配置不存在'));
      if (settings.profiles.length <= 1) throw new LocalizedError(message('至少保留一个 AI 配置'));
      if (settings.activeProfileId === profileId)
        throw new LocalizedError(message('请先启用其他配置，再删除当前配置'));
      return { ...settings, profiles: settings.profiles.filter((item) => item.id !== profileId) };
    }),
  );
}

export async function selectActiveProfile(profileId: string): Promise<PublicTranslatorSettings> {
  return toPublicSettings(
    await updateStoredSettings((settings) => {
      const profile = getActiveProfile(settings, profileId);
      if (!profile) throw new LocalizedError(message('翻译配置不存在'));
      const error = Object.values(validateTranslationProfile(profile))[0];
      if (error) throw new LocalizedError(error);
      return { ...settings, activeProfileId: profileId };
    }),
  );
}

/** Preference validation is independent of draft or unconfigured AI profiles. */
export async function updateReadingPreferences(
  patch: Partial<ReadingPreferences>,
): Promise<PublicTranslatorSettings> {
  return toPublicSettings(
    await updateStoredSettings((settings) => {
      const next = { ...settings };
      if (patch.targetLanguage !== undefined) {
        if (typeof patch.targetLanguage !== 'string' || !patch.targetLanguage.trim())
          throw new LocalizedError(message('请填写目标语言'));
        next.targetLanguage = patch.targetLanguage.trim();
      }
      if (patch.displayMode !== undefined) {
        if (patch.displayMode !== 'bilingual' && patch.displayMode !== 'translation')
          throw new LocalizedError(message('展示方式无效'));
        next.displayMode = patch.displayMode;
      }
      if (patch.translateDynamicContent !== undefined) {
        if (typeof patch.translateDynamicContent !== 'boolean')
          throw new LocalizedError(message('动态翻译设置无效'));
        next.translateDynamicContent = patch.translateDynamicContent;
      }
      if (patch.translationConcurrency !== undefined) {
        if (!isValidTranslationConcurrency(patch.translationConcurrency))
          throw new LocalizedError(
            message('翻译并发数必须是 1–{{p0}} 的整数', { p0: MAX_TRANSLATION_CONCURRENCY }),
          );
        next.translationConcurrency = patch.translationConcurrency;
      }
      if (patch.translationRetryCount !== undefined) {
        if (!isValidTranslationRetryCount(patch.translationRetryCount))
          throw new LocalizedError(
            message('翻译失败重试次数必须是 0–{{p0}} 的整数', { p0: MAX_TRANSLATION_RETRY_COUNT }),
          );
        next.translationRetryCount = patch.translationRetryCount;
      }
      return next;
    }),
  );
}

/** Individual rule operations avoid overwriting rules added by another open extension page. */
export async function updateSiteRule(rule: SiteRuleUpdate): Promise<PublicTranslatorSettings> {
  if (rule.list !== 'excludedSites' && rule.list !== 'autoTranslateSites')
    throw new LocalizedError(message('站点规则类型无效'));
  if (typeof rule.enabled !== 'boolean') throw new LocalizedError(message('站点规则操作无效'));
  const hostname = normalizeSiteRule(rule.hostname, rule.list === 'excludedSites');
  return toPublicSettings(
    await updateStoredSettings((settings) => {
      const sites = new Set(settings[rule.list]);
      if (rule.enabled) sites.add(hostname);
      else sites.delete(hostname);
      return { ...settings, [rule.list]: [...sites] };
    }),
  );
}

export function setSiteAutoTranslation(
  hostname: string,
  enabled: boolean,
): Promise<PublicTranslatorSettings> {
  return updateSiteRule({ list: 'autoTranslateSites', hostname, enabled });
}

/** Only non-secret configuration metadata may be sent to popup or content scripts. */
export function toPublicSettings(settings: TranslatorSettings): PublicTranslatorSettings {
  const profiles = settings.profiles.map((profile) => {
    const configurationError =
      Object.values(validateTranslationProfile(profile))[0] ??
      (settings.targetLanguage.trim() ? undefined : message('请填写目标语言'));
    return {
      id: profile.id,
      name: profile.name,
      configured: !configurationError,
      configurationError,
    };
  });
  const activeProfile = profiles.find((profile) => profile.id === settings.activeProfileId);
  return {
    profiles,
    uiLanguage: settings.uiLanguage,
    activeProfileId: settings.activeProfileId,
    configured: activeProfile?.configured ?? false,
    configurationError:
      activeProfile?.configurationError ??
      (activeProfile ? undefined : message('当前翻译配置不存在')),
    targetLanguage: settings.targetLanguage,
    displayMode: settings.displayMode,
    translateDynamicContent: settings.translateDynamicContent,
    translationConcurrency: settings.translationConcurrency,
    translationRetryCount: settings.translationRetryCount,
    excludedSites: settings.excludedSites,
    autoTranslateSites: settings.autoTranslateSites,
  };
}

/** Validates at the trusted write boundary and preserves concurrent changes to all other settings. */
export async function updateUiLanguage(uiLanguage: UiLanguage): Promise<PublicTranslatorSettings> {
  if (!isUiLanguage(uiLanguage)) throw new LocalizedError(message('界面语言无效'));
  return toPublicSettings(await updateStoredSettings((current) => ({ ...current, uiLanguage })));
}
