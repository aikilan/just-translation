import { renderMessage } from './i18n';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROVIDER_OPTIONS,
  PROVIDERS,
  normalizeEndpoint,
  resolveProviderOptions,
  getModelCapability,
} from './providers';
import { mergeSettings, validateTranslationProfile } from './settings';

const base = {
  ...DEFAULT_PROVIDER_OPTIONS,
  provider: 'mimo' as const,
  protocol: 'openai' as const,
  model: 'mimo-v2.5',
  thinkingEnabled: true,
};
describe('provider and protocol contract', () => {
  it('offers all nine providers and custom without advertising fake Anthropic endpoints', () => {
    expect(PROVIDERS.map((p) => p.id)).toEqual([
      'gemini',
      'grok',
      'openai',
      'anthropic',
      'kimi',
      'glm',
      'mimo',
      'deepseek',
      'qwen',
      'custom',
    ]);
    expect(PROVIDERS.find((p) => p.id === 'gemini')?.endpoints.anthropic).toBeUndefined();
  });
  it.each([
    [
      'https://generativelanguage.googleapis.com/v1beta/openai/',
      'openai',
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    ],
    [
      'https://open.bigmodel.cn/api/paas/v4',
      'openai',
      'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    ],
    [
      'https://api.xiaomimimo.com/anthropic',
      'anthropic',
      'https://api.xiaomimimo.com/anthropic/v1/messages',
    ],
    [
      'https://gateway.test/prefix/v1/messages?x=1',
      'anthropic',
      'https://gateway.test/prefix/v1/messages?x=1',
    ],
    ['https://api.openai.com', 'openai', 'https://api.openai.com/v1/chat/completions'],
  ] as const)('resolves %s using %s', (url, protocol, expected) =>
    expect(normalizeEndpoint(url, protocol)).toBe(expected),
  );
  it('rejects a full endpoint for the wrong protocol', () => {
    expect(() => normalizeEndpoint('https://example.com/v1/messages', 'openai')).toThrow('协议');
    expect(() => normalizeEndpoint('https://example.com/v1/chat/completions', 'anthropic')).toThrow(
      '协议',
    );
  });
  it.each([
    ['mimo', 'mimo-v2.5', 'thinking'],
    ['deepseek', 'deepseek-v4-pro', 'thinking'],
    ['kimi', 'kimi-k2.6', 'thinking'],
    ['glm', 'glm-5.1', 'thinking'],
    ['qwen', 'qwen3.7-plus', 'enable_thinking'],
    ['openai', 'gpt-5.4', 'reasoning_effort'],
    ['gemini', 'gemini-2.5-flash', 'reasoning_effort'],
    ['anthropic', 'claude-sonnet-4-6', 'anthropic-adaptive'],
  ] as const)('maps %s/%s to its actual control', (provider, model, control) => {
    expect(resolveProviderOptions({ ...base, provider, model }).control).toBe(control);
  });
  it('enables models whose API defaults off and never equates low with off', () => {
    expect(
      resolveProviderOptions({ ...base, provider: 'openai', model: 'gpt-5.4' }).parameters,
    ).toEqual({ reasoning_effort: 'low' });
    expect(
      resolveProviderOptions({
        ...base,
        provider: 'openai',
        model: 'gpt-5.4',
        thinkingEnabled: false,
        reasoningEffort: 'high',
      }).parameters,
    ).toEqual({ reasoning_effort: 'none' });
    expect(() =>
      resolveProviderOptions({
        ...base,
        provider: 'grok',
        model: 'grok-4.6',
        thinkingEnabled: false,
      }),
    ).toThrow('关闭');
  });
  it('does not guess unknown model prefixes but permits explicit manual control', () => {
    expect(getModelCapability('openai', 'gpt-5.4-mystery')).toBeUndefined();
    expect(resolveProviderOptions({ ...base, model: 'private-alias' }).parameters).toEqual({});
    expect(
      resolveProviderOptions({
        ...base,
        model: 'private-alias',
        thinkingControl: 'enable_thinking',
        thinkingEnabled: false,
      }).parameters,
    ).toEqual({ enable_thinking: false });
  });
  it('checks effort, protocol and effective output budget before HTTP', () => {
    expect(() => resolveProviderOptions({ ...base, reasoningEffort: 'ultra' })).toThrow('强度');
    expect(() =>
      resolveProviderOptions({
        ...base,
        protocol: 'anthropic',
        thinkingControl: 'reasoning_effort',
      }),
    ).toThrow('协议');
    expect(() =>
      resolveProviderOptions({
        ...base,
        thinkingControl: 'anthropic-budget',
        maxOutputTokens: 2048,
        thinkingBudgetTokens: 2048,
      }),
    ).toThrow('预算');
    expect(
      resolveProviderOptions({ ...base, protocol: 'anthropic', model: 'unknown' }).maxOutputTokens,
    ).toBe(8192);
    expect(resolveProviderOptions({ ...base, protocol: 'anthropic' }, true).maxOutputTokens).toBe(
      32768,
    );
  });
  it('retains old profile values and requires explicit provider/protocol completion', () => {
    const p = mergeSettings({
      profiles: [
        {
          id: 'old',
          name: 'Old',
          apiUrl: 'https://api.xiaomimimo.com/v1',
          apiKey: 'secret',
          model: 'mimo-v2.5',
          translationPrompt: 'Translate',
          thinkingEnabled: false,
        },
      ],
    }).profiles[0];
    expect(p).toMatchObject({
      provider: null,
      protocol: null,
      apiKey: 'secret',
      thinkingEnabled: false,
    });
    expect(typeof renderMessage(validateTranslationProfile(p).provider)).toBe('string');
    expect(typeof renderMessage(validateTranslationProfile(p).protocol)).toBe('string');
  });
});

describe('model-specific protocol differences', () => {
  it('does not invent automatic parameters for unsupported official combinations', () => {
    expect(
      resolveProviderOptions({
        ...base,
        provider: 'gemini',
        model: 'gemini-2.5-flash',
        protocol: 'anthropic',
      }).parameters,
    ).toEqual({});
  });
  it('allows Kimi K3 Anthropic thinking to be disabled without guessing its OpenAI behavior', () => {
    expect(
      resolveProviderOptions({
        ...base,
        provider: 'kimi',
        model: 'kimi-k3',
        protocol: 'anthropic',
        thinkingEnabled: false,
      }).parameters,
    ).toEqual({ thinking: { type: 'disabled' } });
  });
  it('maps Qwen effort without sending the obsolete budget at the same time', () => {
    expect(
      resolveProviderOptions({
        ...base,
        provider: 'qwen',
        model: 'qwen3.8-max',
        protocol: 'anthropic',
        reasoningEffort: 'medium',
      }).parameters,
    ).toEqual({ thinking: { type: 'enabled' }, output_config: { effort: 'medium' } });
  });
  it('does not advertise xhigh on GPT-5.1 but includes documented Opus efforts', () => {
    expect(getModelCapability('openai', 'gpt-5.1')?.efforts).not.toContain('xhigh');
    expect(getModelCapability('anthropic', 'claude-opus-4-7', 'anthropic')?.efforts).toContain(
      'max',
    );
  });
});

it('retains an actionable protocol mismatch validation message', () => {
  const { provider, protocol } = base;
  const errors = validateTranslationProfile({
    ...mergeSettings({}).profiles[0],
    ...base,
    provider,
    protocol,
    name: 'Test',
    apiUrl: 'https://relay.test/v1/messages',
  });
  expect(renderMessage(errors.apiUrl)).toContain('协议');
});

it('uses model output caps instead of grouping an entire brand under one cap', () => {
  expect(
    resolveProviderOptions(
      { ...base, provider: 'qwen', model: 'qwen-plus', protocol: 'anthropic' },
      true,
    ).maxOutputTokens,
  ).toBe(32768);
  expect(getModelCapability('glm', 'glm-4.5')?.maxOutputTokens).toBe(98304);
  expect(
    resolveProviderOptions(
      { ...base, provider: 'anthropic', model: 'claude-sonnet-4-6', protocol: 'anthropic' },
      true,
    ).maxOutputTokens,
  ).toBe(65536);
});

it('does not advertise undocumented effort support in the Claude OpenAI shim', () => {
  expect(
    resolveProviderOptions({ ...base, provider: 'anthropic', model: 'claude-opus-4-7' }).efforts,
  ).toEqual([]);
  expect(() =>
    resolveProviderOptions({
      ...base,
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      reasoningEffort: 'high',
    }),
  ).toThrow('强度');
});

it.each(['mimo-v2.5', 'private-alias'])(
  'explicitly enables manual reasoning_effort for %s',
  (model) => {
    const options = { ...base, model, thinkingControl: 'reasoning_effort' as const };
    expect(resolveProviderOptions(options).parameters).toEqual({ reasoning_effort: 'low' });
    expect(resolveProviderOptions({ ...options, reasoningEffort: 'high' }).parameters).toEqual({
      reasoning_effort: 'high',
    });
    expect(
      resolveProviderOptions({ ...options, thinkingEnabled: false, reasoningEffort: 'high' })
        .parameters,
    ).toEqual({ reasoning_effort: 'none' });
  },
);

it('preserves service defaults for automatic always-thinking models', () => {
  expect(
    resolveProviderOptions({ ...base, provider: 'grok', model: 'grok-4.6' }).parameters,
  ).toEqual({});
});

it.each([
  ['gpt-4.1', 32768],
  ['gpt-4.1-mini', 32768],
  ['gpt-4.1-nano', 32768],
  ['gpt-4o', 16384],
  ['gpt-4o-mini', 16384],
] as const)('validates the documented output limit of %s', (model, limit) => {
  const options = { ...base, provider: 'openai' as const, model };
  expect(resolveProviderOptions({ ...options, maxOutputTokens: limit }).maxOutputTokens).toBe(
    limit,
  );
  expect(() => resolveProviderOptions({ ...options, maxOutputTokens: limit + 1 })).toThrow(
    '输出上限超过模型限制',
  );
});
