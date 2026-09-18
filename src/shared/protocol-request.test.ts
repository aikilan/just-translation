import { describe, it, expect } from 'vitest';
import { buildProtocolRequest } from './protocol-request';
import { DEFAULT_PROVIDER_OPTIONS } from './providers';
const config = {
  ...DEFAULT_PROVIDER_OPTIONS,
  provider: 'mimo' as const,
  protocol: 'openai' as const,
  apiUrl: 'https://api.xiaomimimo.com/v1',
  apiKey: 'key',
  model: 'mimo-v2.5',
  thinkingEnabled: true,
};
describe('protocol request adapters', () => {
  it.each([
    ['mimo', 'https://api.xiaomimimo.com/anthropic', 'Authorization', 'Bearer key'],
    ['kimi', 'https://api.moonshot.ai/anthropic', 'Authorization', 'Bearer key'],
    ['qwen', 'https://dashscope.aliyuncs.com/apps/anthropic', 'Authorization', 'Bearer key'],
    ['anthropic', 'https://api.anthropic.com/v1', 'x-api-key', 'key'],
    ['glm', 'https://open.bigmodel.cn/api/anthropic', 'x-api-key', 'key'],
    ['deepseek', 'https://api.deepseek.com/anthropic', 'x-api-key', 'key'],
    ['mimo', 'https://relay.test/anthropic', 'x-api-key', 'key'],
  ] as const)('uses %s endpoint authentication', (provider, apiUrl, header, value) => {
    const request = buildProtocolRequest(
      { ...config, provider, apiUrl, protocol: 'anthropic' },
      'instructions',
      'content',
    );
    expect(request.headers[header]).toBe(value);
    expect(request.headers['anthropic-version']).toBe('2023-06-01');
    expect(request.body).toMatchObject({
      system: 'instructions',
      max_tokens: 8192,
      messages: [{ role: 'user', content: 'content' }],
    });
    expect(
      Object.hasOwn(request.headers, header === 'Authorization' ? 'x-api-key' : 'Authorization'),
    ).toBe(false);
  });
  it('uses provider-specific output fields and explicitly budgets the Claude OpenAI shim', () => {
    expect(buildProtocolRequest({ ...config, maxOutputTokens: 4096 }, 's', 'c').body).toMatchObject(
      { max_tokens: 4096 },
    );
    expect(
      buildProtocolRequest(
        { ...config, provider: 'openai', model: 'gpt-5.4', maxOutputTokens: 4096 },
        's',
        'c',
      ).body,
    ).toMatchObject({ max_completion_tokens: 4096 });
    expect(
      buildProtocolRequest(
        { ...config, provider: 'anthropic', model: 'claude-haiku-4-5' },
        's',
        'c',
      ).body,
    ).toMatchObject({ max_tokens: 8192, thinking: { type: 'enabled', budget_tokens: 2048 } });
  });
  it('keeps protocol-specific thinking and effort separate', () => {
    expect(
      buildProtocolRequest(
        {
          ...config,
          provider: 'qwen',
          model: 'qwen3.8-max',
          protocol: 'anthropic',
          reasoningEffort: 'medium',
        },
        's',
        'c',
      ).body,
    ).toMatchObject({ thinking: { type: 'enabled' }, output_config: { effort: 'medium' } });
  });
  it.each([
    ['custom', 'alias', false, null, 8192],
    ['custom', 'alias', true, null, 8192],
    ['mimo', 'mimo-v2.5-pro', true, null, 65536],
    ['custom', 'alias', false, 10000, 10000],
  ] as const)(
    'sends the validated budget output cap for %s/%s full=%s override=%s',
    (provider, model, full, maxOutputTokens, expected) => {
      const settings = {
        ...config,
        provider,
        model,
        apiUrl: 'https://relay.test/v1',
        thinkingControl: 'anthropic-budget' as const,
        thinkingBudgetTokens: 6000,
        maxOutputTokens,
      };
      const { body } = buildProtocolRequest(settings, 's', 'c', full);
      expect(body).toMatchObject({
        max_tokens: expected,
        thinking: { type: 'enabled', budget_tokens: 6000 },
      });
      expect(() =>
        buildProtocolRequest({ ...settings, thinkingBudgetTokens: expected }, 's', 'c', full),
      ).toThrow('预算');
    },
  );
  it('drops the budget and its implicit output cap when disabled or when switching strategies', () => {
    const settings = {
      ...config,
      provider: 'custom' as const,
      model: 'alias',
      thinkingControl: 'anthropic-budget' as const,
    };
    const disabled = buildProtocolRequest({ ...settings, thinkingEnabled: false }, 's', 'c').body;
    expect(disabled.thinking).toEqual({ type: 'disabled' });
    expect(disabled).not.toHaveProperty('max_tokens');
    const switched = buildProtocolRequest(
      { ...settings, thinkingControl: 'thinking' },
      's',
      'c',
    ).body;
    expect(switched.thinking).toEqual({ type: 'enabled' });
    expect(switched).not.toHaveProperty('max_tokens');
  });
});
