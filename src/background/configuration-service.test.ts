import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_SETTINGS, SETTINGS_STORAGE_KEY } from '../shared/settings';
import {
  readPublicSettings,
  saveAndReadPublicSettings,
  selectActiveProfile,
  setSiteAutoTranslation,
} from './configuration-service';

describe('configuration service', () => {
  let stored: Record<string, unknown>;

  beforeEach(() => {
    stored = {};
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn((key: string) => Promise.resolve({ [key]: stored[key] })),
          set: vi.fn((values: Record<string, unknown>) => {
            Object.assign(stored, values);
            return Promise.resolve();
          }),
        },
      },
    });
  });

  it('persists settings and returns the same configured state used by the popup', async () => {
    const publicSettings = await saveAndReadPublicSettings({
      ...DEFAULT_SETTINGS,
      profiles: [
        {
          ...DEFAULT_SETTINGS.profiles[0],
          apiUrl: ' https://api.deepseek.com/v1 ',
          apiKey: 'secret',
          model: ' deepseek-v4-flash ',
        },
      ],
    });

    expect(publicSettings.configured).toBe(true);
    expect(publicSettings).not.toHaveProperty('batchMaxCharacters');
    expect(publicSettings).not.toHaveProperty('batchMaxItems');
    expect(publicSettings).not.toHaveProperty('batchConcurrency');
    expect(stored[SETTINGS_STORAGE_KEY]).toMatchObject({
      profiles: [
        expect.objectContaining({
          apiUrl: 'https://api.deepseek.com/v1',
          model: 'deepseek-v4-flash',
        }),
      ],
    });
    await expect(readPublicSettings()).resolves.toEqual(publicSettings);
  });

  it('rejects a save when storage cannot read back the values that were written', async () => {
    stored[SETTINGS_STORAGE_KEY] = DEFAULT_SETTINGS;
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn((key: string) => Promise.resolve({ [key]: stored[key] })),
          set: vi.fn().mockResolvedValue(undefined),
        },
      },
    });

    await expect(
      saveAndReadPublicSettings({
        ...DEFAULT_SETTINGS,
        profiles: [
          {
            ...DEFAULT_SETTINGS.profiles[0],
            apiUrl: 'https://api.deepseek.com/v1',
            apiKey: 'secret',
            model: 'deepseek-v4-flash',
          },
        ],
      }),
    ).rejects.toThrow(/回读不一致/u);
  });

  it('returns the exact validation reason when stored configuration is incomplete', async () => {
    stored[SETTINGS_STORAGE_KEY] = DEFAULT_SETTINGS;

    await expect(readPublicSettings()).resolves.toMatchObject({
      configured: false,
      configurationError: '请填写模型名称',
    });
  });

  it('switches the active profile without exposing provider secrets', async () => {
    stored[SETTINGS_STORAGE_KEY] = {
      ...DEFAULT_SETTINGS,
      profiles: [
        {
          ...DEFAULT_SETTINGS.profiles[0],
          id: 'one',
          name: '配置一',
          apiUrl: 'https://one.example.com/v1',
          apiKey: 'secret-one',
          model: 'model-one',
        },
        {
          ...DEFAULT_SETTINGS.profiles[0],
          id: 'two',
          name: '配置二',
          apiUrl: 'https://two.example.com/v1',
          apiKey: 'secret-two',
          model: 'model-two',
        },
      ],
      activeProfileId: 'one',
    };

    const publicSettings = await selectActiveProfile('two');

    expect(publicSettings.activeProfileId).toBe('two');
    expect(publicSettings.profiles.map((profile) => profile.name)).toEqual(['配置一', '配置二']);
    expect(publicSettings).not.toHaveProperty('apiKey');
    expect(JSON.stringify(publicSettings)).not.toContain('secret-two');
    expect(stored[SETTINGS_STORAGE_KEY]).toMatchObject({ activeProfileId: 'two' });
  });

  it('marks and unmarks an exact hostname for automatic translation', async () => {
    stored[SETTINGS_STORAGE_KEY] = {
      ...DEFAULT_SETTINGS,
      profiles: [{ ...DEFAULT_SETTINGS.profiles[0], model: 'configured-model' }],
    };

    await expect(setSiteAutoTranslation('News.YCombinator.com', true)).resolves.toMatchObject({
      autoTranslateSites: ['news.ycombinator.com'],
    });
    await expect(setSiteAutoTranslation('news.ycombinator.com', false)).resolves.toMatchObject({
      autoTranslateSites: [],
    });
  });
});
