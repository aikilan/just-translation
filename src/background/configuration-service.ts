import type { PublicTranslatorSettings } from '../shared/messages';
import {
  getActiveProfile,
  normalizeHostname,
  validateTranslationProfile,
  type TranslatorSettings,
} from '../shared/settings';
import { getSettings, saveSettings } from '../shared/settings-store';

/** Reads the exact public configuration state consumed by popup and content scripts. */
export async function readPublicSettings(): Promise<PublicTranslatorSettings> {
  return toPublicSettings(await getSettings());
}

/** Persists first, then derives the response from the normalized stored value. */
export async function saveAndReadPublicSettings(
  settings: TranslatorSettings,
): Promise<PublicTranslatorSettings> {
  const savedSettings = await saveSettings(settings);
  const storedSettings = await getSettings();
  if (!areSettingsEqual(savedSettings, storedSettings)) {
    throw new Error('设置写入后回读不一致，请重新加载扩展后重试');
  }
  return toPublicSettings(storedSettings);
}

export async function selectActiveProfile(profileId: string): Promise<PublicTranslatorSettings> {
  const settings = await getSettings();
  if (!getActiveProfile(settings, profileId)) throw new Error('翻译配置不存在');
  return toPublicSettings(await saveSettings({ ...settings, activeProfileId: profileId }));
}

export async function setSiteAutoTranslation(
  hostname: string,
  enabled: boolean,
): Promise<PublicTranslatorSettings> {
  const normalizedHostname = normalizeHostname(hostname);
  const settings = await getSettings();
  const sites = new Set(settings.autoTranslateSites.map((site) => site.toLowerCase()));
  if (enabled) sites.add(normalizedHostname);
  else sites.delete(normalizedHostname);
  return toPublicSettings(await saveSettings({ ...settings, autoTranslateSites: [...sites] }));
}

export function toPublicSettings(settings: TranslatorSettings): PublicTranslatorSettings {
  const profiles = settings.profiles.map((profile) => {
    const profileErrors = validateTranslationProfile(profile);
    const targetError = settings.targetLanguage.trim() ? undefined : '请填写目标语言';
    const configurationError = Object.values(profileErrors)[0] ?? targetError;
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
    activeProfileId: settings.activeProfileId,
    configured: activeProfile?.configured ?? false,
    configurationError: activeProfile?.configurationError ?? '当前翻译配置不存在',
    targetLanguage: settings.targetLanguage,
    displayMode: settings.displayMode,
    translateDynamicContent: settings.translateDynamicContent,
    excludedSites: settings.excludedSites,
    autoTranslateSites: settings.autoTranslateSites,
  };
}

function areSettingsEqual(left: TranslatorSettings, right: TranslatorSettings): boolean {
  return (
    left.activeProfileId === right.activeProfileId &&
    left.profiles.length === right.profiles.length &&
    left.profiles.every((profile, index) => {
      const other = right.profiles[index];
      return other !== undefined && Object.keys(profile).every(
        (key) => profile[key as keyof typeof profile] === other[key as keyof typeof other],
      );
    }) &&
    left.targetLanguage === right.targetLanguage &&
    left.displayMode === right.displayMode &&
    left.translateDynamicContent === right.translateDynamicContent &&
    left.excludedSites.length === right.excludedSites.length &&
    left.excludedSites.every((site, index) => site === right.excludedSites[index]) &&
    left.autoTranslateSites.length === right.autoTranslateSites.length &&
    left.autoTranslateSites.every((site, index) => site === right.autoTranslateSites[index])
  );
}
