import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_SETTINGS, DEFAULT_TRANSLATION_PROMPT, SETTINGS_STORAGE_KEY } from './settings';
import { getSettings, initializeSettings, updateStoredSettings } from './settings-store';

describe('settings store initialization', () => {
  let stored: Record<string, unknown>;
  let storageSet: ReturnType<typeof vi.fn<(values: Record<string, unknown>) => Promise<void>>>;

  beforeEach(() => {
    stored = {};
    storageSet = vi.fn((values: Record<string, unknown>) => {
      Object.assign(stored, values);
      return Promise.resolve();
    });
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn((key: string) => Promise.resolve({ [key]: stored[key] })),
          set: storageSet,
        },
      },
    });
  });

  it('confirms equal profile values regardless of runtime property order', async () => {
    const profile = DEFAULT_SETTINGS.profiles[0];
    const reordered = Object.fromEntries(Object.entries(profile).reverse()) as typeof profile;
    await expect(
      updateStoredSettings((settings) => ({
        ...settings,
        profiles: [{ ...reordered, model: 'test-model' }],
      })),
    ).resolves.toMatchObject({ profiles: [{ model: 'test-model' }] });
  });

  it('still rejects an actual field mismatch after a storage write', async () => {
    storageSet.mockImplementation((values) => {
      Object.assign(stored, structuredClone(values));
      (stored[SETTINGS_STORAGE_KEY] as typeof DEFAULT_SETTINGS).targetLanguage = 'Wrong language';
      return Promise.resolve();
    });
    await expect(
      updateStoredSettings((settings) => ({ ...settings, targetLanguage: 'Japanese' })),
    ).rejects.toThrow('回读不一致');
  });

  it('normalizes read values without writing from the reading context', async () => {
    stored[SETTINGS_STORAGE_KEY] = {
      ...DEFAULT_SETTINGS,
      profiles: [
        {
          id: 'missing-prompt',
          name: '缺失 Prompt',
          apiUrl: 'https://one.example.com/v1',
          apiKey: '',
          model: 'model-one',
        },
        {
          id: 'blank-prompt',
          name: '空 Prompt',
          apiUrl: 'https://two.example.com/v1',
          apiKey: '',
          model: 'model-two',
          translationPrompt: '   ',
        },
      ],
      activeProfileId: 'missing-prompt',
    };

    const settings = await getSettings();

    expect(settings.profiles.map((profile) => profile.translationPrompt)).toEqual([
      DEFAULT_TRANSLATION_PROMPT,
      DEFAULT_TRANSLATION_PROMPT,
    ]);
    expect(storageSet).not.toHaveBeenCalled();
  });

  it('persists complete default settings when the extension has never been initialized', async () => {
    await initializeSettings();

    expect(stored[SETTINGS_STORAGE_KEY]).toEqual(DEFAULT_SETTINGS);
    expect(storageSet).toHaveBeenCalledOnce();
  });

  it('persists the one-time legacy AI selection migration without the removed field', async () => {
    stored[SETTINGS_STORAGE_KEY] = {
      ...DEFAULT_SETTINGS,
      activeTranslator: undefined,
      schemaVersion: undefined,
      activeProfileId: DEFAULT_SETTINGS.profiles[0].id,
      autoTranslateSites: ['private.example.com'],
    };

    await initializeSettings();

    expect(stored[SETTINGS_STORAGE_KEY]).toMatchObject({
      activeTranslator: { kind: 'ai', profileId: DEFAULT_SETTINGS.profiles[0].id },
      autoTranslateSites: ['private.example.com'],
    });
    expect(stored[SETTINGS_STORAGE_KEY]).not.toHaveProperty('activeProfileId');
  });
});
