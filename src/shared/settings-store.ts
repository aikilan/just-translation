import {
  SETTINGS_STORAGE_KEY,
  getSettingsValidationMessage,
  mergeSettings,
  validateSettings,
  type TranslatorSettings,
} from './settings';

export async function getSettings(): Promise<TranslatorSettings> {
  const stored = await chrome.storage.local.get(SETTINGS_STORAGE_KEY);
  const storedSettings = stored[SETTINGS_STORAGE_KEY];
  const settings = mergeSettings(storedSettings);
  if (requiresDefaultPromptWrite(storedSettings)) {
    await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: settings });
  }
  return settings;
}

export async function saveSettings(settings: TranslatorSettings): Promise<TranslatorSettings> {
  const normalized: TranslatorSettings = {
    ...settings,
    profiles: settings.profiles.map((profile) => ({
      ...profile,
      id: profile.id.trim(),
      name: profile.name.trim(),
      apiUrl: profile.apiUrl.trim(),
      model: profile.model.trim(),
      translationPrompt: profile.translationPrompt.trim(),
    })),
    activeProfileId: settings.activeProfileId.trim(),
    targetLanguage: settings.targetLanguage.trim(),
    excludedSites: settings.excludedSites.map((site) => site.trim()).filter(Boolean),
    autoTranslateSites: [...new Set(
      settings.autoTranslateSites.map((site) => site.trim().toLowerCase()).filter(Boolean),
    )],
  };
  const validation = validateSettings(normalized);
  if (!validation.valid) {
    throw new Error(getSettingsValidationMessage(validation) ?? '设置无效');
  }
  await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: normalized });
  return normalized;
}

export async function initializeSettings(): Promise<void> {
  await getSettings();
}

/** Detects the only invalid persisted state that initialization repairs automatically. */
function requiresDefaultPromptWrite(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.profiles) || value.profiles.length === 0) return true;
  return value.profiles.some(
    (profile) =>
      !isRecord(profile) ||
      typeof profile.translationPrompt !== 'string' ||
      !profile.translationPrompt.trim(),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
