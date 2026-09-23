import { describe, expect, it } from 'vitest';

import { TEST_PROFILE } from '../test-utils/provider';
import {
  DEFAULT_SETTINGS,
  SETTINGS_SCHEMA_VERSION,
  mergeSettings,
  type TranslatorSettings,
} from './settings';

describe('translation engine settings schema', () => {
  it('uses Google for a fresh install without requiring an API profile', () => {
    expect(mergeSettings(undefined)).toMatchObject({
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      activeTranslator: { kind: 'builtin', engine: 'google-free' },
    });
  });

  it('migrates an existing active AI profile without changing site or reading preferences', () => {
    const legacy = {
      ...DEFAULT_SETTINGS,
      schemaVersion: undefined,
      activeTranslator: undefined,
      activeProfileId: 'existing-ai',
      profiles: [{ ...TEST_PROFILE, id: 'existing-ai', model: 'existing-model' }],
      targetLanguage: 'Japanese',
      autoTranslateSites: ['news.example.com'],
      excludedSites: ['bank.example.com'],
    };

    const migrated = mergeSettings(legacy);

    expect(migrated.activeTranslator).toEqual({ kind: 'ai', profileId: 'existing-ai' });
    expect(migrated.profiles).toEqual(legacy.profiles);
    expect(migrated.targetLanguage).toBe('Japanese');
    expect(migrated.autoTranslateSites).toEqual(['news.example.com']);
    expect(migrated.excludedSites).toEqual(['bank.example.com']);
    expect(migrated).not.toHaveProperty('activeProfileId');
  });

  it('keeps an invalid legacy AI profile selected so an automatic site never changes recipient', () => {
    const migrated = mergeSettings({
      profiles: [{ ...TEST_PROFILE, id: 'incomplete', model: '' }],
      activeProfileId: 'incomplete',
      autoTranslateSites: ['private.example.com'],
    });

    expect(migrated.activeTranslator).toEqual({ kind: 'ai', profileId: 'incomplete' });
    expect(migrated.autoTranslateSites).toEqual(['private.example.com']);
  });

  it('normalizes a v2 selection idempotently and rejects malformed discriminants', () => {
    const settings: TranslatorSettings = {
      ...DEFAULT_SETTINGS,
      activeTranslator: { kind: 'builtin', engine: 'microsoft-free' },
    };
    expect(mergeSettings(settings)).toEqual(settings);
    expect(
      mergeSettings({ ...settings, activeTranslator: { kind: 'builtin', engine: 'unknown' } })
        .activeTranslator,
    ).toEqual(DEFAULT_SETTINGS.activeTranslator);
  });
});
