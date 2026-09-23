import { describe, expect, it } from 'vitest';
import { MODELS } from './providers';
import { DEFAULT_SETTINGS, mergeSettings, validateTranslationProfile } from './settings';
import { IMAGE_MODEL_CAPABILITIES, resolveImageInputCapability } from './image-capabilities';
import { toPublicSettings } from '../background/configuration-service';

const profile = {
  ...DEFAULT_SETTINGS.profiles[0],
  provider: 'mimo' as const,
  protocol: 'openai' as const,
  apiUrl: 'https://api.xiaomimimo.com/v1',
  model: 'mimo-v2.5',
  imageInputEnabled: false,
};

describe('image input capability ownership', () => {
  it.each(['https://api.openai.com/v1', 'https://api.openai.com/v1/chat/completions'])(
    'enables the documented GPT-5.6 Sol alias at %s without a manual override',
    (apiUrl) => {
      const profiles = ['gpt-5.6', 'gpt-5.6-sol'].map((model) => ({
        ...profile,
        provider: 'openai' as const,
        apiUrl,
        model,
        id: model,
        imageInputEnabled: false,
      }));
      for (const item of profiles)
        expect(resolveImageInputCapability(item)).toMatchObject({
          mode: 'catalog',
          supported: true,
        });
      expect(
        toPublicSettings({ ...DEFAULT_SETTINGS, profiles }).profiles.map(
          (item) => item.supportsImageInput,
        ),
      ).toEqual([true, true]);
    },
  );
  it('does not attribute a dated vision release to the text-only Qwen Max alias', () => {
    const qwen = {
      ...profile,
      provider: 'qwen' as const,
      apiUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen3.7-max',
    };
    expect(resolveImageInputCapability(qwen)).toMatchObject({ mode: 'catalog', supported: false });
    expect(resolveImageInputCapability({ ...qwen, model: 'qwen3.8-max' }).supported).toBe(true);
  });
  it('records an explicit documented decision for every built-in model without guessing prefixes', () => {
    for (const model of MODELS) {
      const entry = IMAGE_MODEL_CAPABILITIES.find(
        (item) => item.provider === model.provider && item.model === model.id,
      );
      expect(entry, `${model.provider}/${model.id}`).toBeDefined();
      expect(entry?.source).toMatch(/^https:\/\//u);
      expect(entry?.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    }
    expect(resolveImageInputCapability({ ...profile, model: 'mimo-v2.5-private' })).toMatchObject({
      mode: 'manual',
      supported: false,
    });
  });
  it('distinguishes vision and text models from the same provider on both documented protocols', () => {
    expect(resolveImageInputCapability(profile)).toMatchObject({
      mode: 'catalog',
      supported: true,
    });
    expect(
      resolveImageInputCapability({ ...profile, model: 'mimo-v2.5-pro', imageInputEnabled: true }),
    ).toMatchObject({ mode: 'catalog', supported: false });
    expect(
      resolveImageInputCapability({
        ...profile,
        protocol: 'anthropic',
        apiUrl: 'https://api.xiaomimimo.com/anthropic',
      }),
    ).toMatchObject({ mode: 'catalog', supported: true });
  });
  it('normalizes full official endpoints and requires manual consent for relays, aliases and custom providers', () => {
    expect(
      resolveImageInputCapability({ ...profile, apiUrl: `${profile.apiUrl}/chat/completions` })
        .supported,
    ).toBe(true);
    for (const change of [
      { apiUrl: 'https://relay.test/v1' },
      { provider: 'custom' as const },
      { model: 'alias' },
    ]) {
      expect(resolveImageInputCapability({ ...profile, ...change })).toMatchObject({
        mode: 'manual',
        supported: false,
      });
      expect(
        resolveImageInputCapability({ ...profile, ...change, imageInputEnabled: true }),
      ).toMatchObject({ mode: 'manual', supported: true });
    }
  });
  it('saves custom choices, initializes them disabled, and rejects malformed preferences', () => {
    const settings = mergeSettings({
      profiles: [{ ...profile, provider: 'custom', imageInputEnabled: true }],
    });
    expect(settings.profiles[0].imageInputEnabled).toBe(true);
    expect(
      mergeSettings({ profiles: [{ ...profile, imageInputEnabled: undefined }] }).profiles[0]
        .imageInputEnabled,
    ).toBe(false);
    expect(
      validateTranslationProfile({ ...profile, imageInputEnabled: 'true' as never }),
    ).toHaveProperty('imageInputEnabled');
  });
  it('publishes capability per profile even when the global translator is a free text engine', () => {
    const result = toPublicSettings({
      ...DEFAULT_SETTINGS,
      profiles: [profile, { ...profile, id: 'text', model: 'mimo-v2.5-pro' }],
    });
    expect(result.profiles.map((p) => p.supportsImageInput)).toEqual([true, false]);
    expect(result.profiles[0]).not.toHaveProperty('apiKey');
  });
});
