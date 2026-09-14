import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_SETTINGS, DEFAULT_TRANSLATION_PROMPT, SETTINGS_STORAGE_KEY } from './settings';
import { getSettings, initializeSettings } from './settings-store';

describe('settings store initialization', () => {
  let stored: Record<string, unknown>;
  let storageSet: ReturnType<typeof vi.fn>;

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
});
