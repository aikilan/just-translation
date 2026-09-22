import { message, LocalizedError } from './i18n';
/** Provider selection is explicit; model names and gateway hostnames never select credentials. */
export type ProviderId =
  | 'gemini'
  | 'grok'
  | 'openai'
  | 'anthropic'
  | 'kimi'
  | 'glm'
  | 'mimo'
  | 'deepseek'
  | 'qwen'
  | 'custom';
export type ApiProtocol = 'openai' | 'anthropic';
export const THINKING_CONTROLS = [
  'auto',
  'default',
  'thinking',
  'reasoning_effort',
  'enable_thinking',
  'anthropic-adaptive',
  'anthropic-budget',
] as const;
export type ThinkingControl = (typeof THINKING_CONTROLS)[number];
export const REASONING_EFFORTS = [
  'default',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
export interface ProviderOptions {
  provider: ProviderId | null;
  protocol: ApiProtocol | null;
  thinkingControl: ThinkingControl;
  reasoningEffort: ReasoningEffort;
  thinkingBudgetTokens: number;
  maxOutputTokens: number | null;
}
export interface ModelOptions extends ProviderOptions {
  model: string;
  thinkingEnabled: boolean;
}
export const DEFAULT_PROVIDER_OPTIONS: ProviderOptions = {
  provider: null,
  protocol: 'openai',
  thinkingControl: 'auto',
  reasoningEffort: 'default',
  thinkingBudgetTokens: 2048,
  maxOutputTokens: null,
};
export interface ProviderDefinition {
  id: ProviderId;
  name: string;
  endpoints: Partial<Record<ApiProtocol, string>>;
  source: string;
}
export const PROVIDERS: readonly ProviderDefinition[] = [
  {
    id: 'gemini',
    name: 'Google Gemini',
    endpoints: { openai: 'https://generativelanguage.googleapis.com/v1beta/openai' },
    source: 'https://ai.google.dev/gemini-api/docs/openai',
  },
  {
    id: 'grok',
    name: 'xAI Grok',
    endpoints: { openai: 'https://api.x.ai/v1' },
    source: 'https://docs.x.ai/developers/model-capabilities/text/reasoning',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    endpoints: { openai: 'https://api.openai.com/v1' },
    source: 'https://developers.openai.com/api/docs/models',
  },
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    endpoints: {
      openai: 'https://api.anthropic.com/v1',
      anthropic: 'https://api.anthropic.com/v1',
    },
    source: 'https://platform.claude.com/docs/en/build-with-claude/thinking',
  },
  {
    id: 'kimi',
    name: '月之暗面 Kimi',
    endpoints: {
      openai: 'https://api.moonshot.cn/v1',
      anthropic: 'https://api.moonshot.cn/anthropic',
    },
    source: 'https://platform.kimi.ai/docs/guide/use-thinking-models',
  },
  {
    id: 'glm',
    name: '智谱 GLM',
    endpoints: {
      openai: 'https://open.bigmodel.cn/api/paas/v4',
      anthropic: 'https://open.bigmodel.cn/api/anthropic',
    },
    source: 'https://docs.bigmodel.cn/cn/guide/capabilities/thinking',
  },
  {
    id: 'mimo',
    name: '小米 MiMo',
    endpoints: {
      openai: 'https://api.xiaomimimo.com/v1',
      anthropic: 'https://api.xiaomimimo.com/anthropic',
    },
    source: 'https://mimo.mi.com/docs/en-US/api/chat/anthropic-api',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    endpoints: {
      openai: 'https://api.deepseek.com/v1',
      anthropic: 'https://api.deepseek.com/anthropic',
    },
    source: 'https://api-docs.deepseek.com/guides/thinking_mode/',
  },
  {
    id: 'qwen',
    name: '阿里云 Qwen',
    endpoints: {
      openai: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      anthropic: 'https://dashscope.aliyuncs.com/apps/anthropic',
    },
    source: 'https://www.alibabacloud.com/help/zh/model-studio/anthropic-api-messages',
  },
  { id: 'custom', name: '自定义供应商', endpoints: {}, source: '' },
];
export type ThinkingCapability = 'toggle' | 'always' | 'none';
export interface ModelCapability {
  id: string;
  provider: ProviderId;
  capability: ThinkingCapability;
  control: Exclude<ThinkingControl, 'auto'>;
  efforts: readonly ReasoningEffort[];
  defaultThinking: boolean;
  defaultEffort?: ReasoningEffort;
  maxOutputTokens: number;
  source: string;
}
/** Exact, documented model IDs only. Add dated aliases explicitly rather than guessing prefixes. */
function models(
  provider: ProviderId,
  ids: string[],
  control: ModelCapability['control'],
  capability: ThinkingCapability = 'toggle',
  efforts: ReasoningEffort[] = [],
  maxOutputTokens = 65536,
  defaultThinking = true,
  defaultEffort?: ReasoningEffort,
): ModelCapability[] {
  return ids.map((id) => ({
    id,
    provider,
    control,
    capability,
    efforts,
    maxOutputTokens,
    defaultThinking,
    defaultEffort,
    source: PROVIDERS.find((p) => p.id === provider)!.source,
  }));
}
export const MODELS: readonly ModelCapability[] = [
  ...models('glm', ['glm-4.5', 'glm-4.5-air'], 'thinking', 'toggle', [], 98304),
  ...models('qwen', ['qwen-plus', 'qwen-flash'], 'enable_thinking', 'toggle', [], 32768),
  ...models('mimo', ['mimo-v2.5'], 'thinking', 'toggle', [], 32768),
  ...models('mimo', ['mimo-v2.5-pro'], 'thinking', 'toggle', [], 131072),
  ...models(
    'deepseek',
    ['deepseek-flash', 'deepseek-v4-pro'],
    'thinking',
    'toggle',
    ['low', 'high', 'max'],
    65536,
    true,
    'high',
  ),
  ...models('glm', ['glm-4.6', 'glm-4.7', 'glm-5', 'glm-5.1'], 'thinking', 'toggle', [], 131072),
  ...models('glm', ['glm-5.2'], 'thinking', 'toggle', ['high', 'max'], 131072, true, 'max'),
  ...models('kimi', ['kimi-k2.5', 'kimi-k2.6'], 'thinking', 'toggle', [], 32768),
  ...models('kimi', ['kimi-k2.7-code', 'kimi-k2.7-code-highspeed'], 'default', 'always', [], 32768),
  ...models(
    'kimi',
    ['kimi-k3'],
    'reasoning_effort',
    'always',
    ['low', 'high', 'max'],
    65536,
    true,
    'max',
  ),
  ...models(
    'openai',
    ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano'],
    'default',
    'none',
    [],
    // GPT-4.1 family: https://developers.openai.com/api/docs/models/gpt-4.1
    32768,
    false,
  ),
  ...models('openai', ['gpt-4o', 'gpt-4o-mini'], 'default', 'none', [], 16384, false),
  ...models(
    'openai',
    ['gpt-5.1'],
    'reasoning_effort',
    'toggle',
    ['low', 'medium', 'high'],
    128000,
    false,
  ),
  ...models(
    'openai',
    ['gpt-5.2', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano'],
    'reasoning_effort',
    'toggle',
    ['low', 'medium', 'high', 'xhigh'],
    128000,
    false,
  ),
  ...models(
    'openai',
    ['gpt-5.5'],
    'reasoning_effort',
    'toggle',
    ['low', 'medium', 'high', 'xhigh'],
    128000,
    true,
    'medium',
  ),
  ...models(
    'openai',
    ['gpt-5.6', 'gpt-5.6-sol'],
    'reasoning_effort',
    'toggle',
    ['low', 'medium', 'high', 'xhigh', 'max'],
    128000,
    true,
    'medium',
  ),
  ...models(
    'openai',
    ['gpt-6-astra'],
    'reasoning_effort',
    'always',
    ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    128000,
    true,
    'medium',
  ),
  ...models(
    'gemini',
    ['gemini-2.5-flash'],
    'reasoning_effort',
    'toggle',
    ['low', 'medium', 'high'],
    65536,
  ),
  ...models(
    'gemini',
    ['gemini-2.5-flash-lite'],
    'reasoning_effort',
    'toggle',
    ['low', 'medium', 'high'],
    65536,
    false,
  ),
  ...models(
    'gemini',
    ['gemini-2.5-pro', 'gemini-3-pro-preview'],
    'reasoning_effort',
    'always',
    ['low', 'high'],
    65536,
  ),
  ...models(
    'gemini',
    ['gemini-3.1-pro-preview', 'gemini-3.7-flash', 'gemini-3.8-flash'],
    'reasoning_effort',
    'always',
    ['low', 'medium', 'high'],
    65536,
  ),
  ...models(
    'gemini',
    [
      'gemini-3-flash-preview',
      'gemini-3.1-flash-lite-preview',
      'gemini-3.5-flash',
      'gemini-3.6-flash',
    ],
    'reasoning_effort',
    'always',
    ['minimal', 'low', 'medium', 'high'],
    65536,
  ),
  ...models(
    'grok',
    ['grok-4.5'],
    'reasoning_effort',
    'always',
    ['low', 'medium', 'high'],
    131072,
    true,
    'high',
  ),
  ...models(
    'grok',
    ['grok-4.6'],
    'reasoning_effort',
    'always',
    ['low', 'medium', 'high', 'xhigh'],
    131072,
    true,
    'high',
  ),
  ...models('anthropic', ['claude-haiku-4-5'], 'anthropic-budget', 'toggle', [], 64000, false),
  ...models(
    'anthropic',
    ['claude-opus-4-5'],
    'anthropic-budget',
    'toggle',
    ['low', 'medium', 'high'],
    64000,
    false,
  ),
  ...models(
    'anthropic',
    ['claude-sonnet-4-6'],
    'anthropic-adaptive',
    'toggle',
    ['low', 'medium', 'high'],
    128000,
    false,
  ),
  ...models(
    'anthropic',
    ['claude-opus-4-6'],
    'anthropic-adaptive',
    'toggle',
    ['low', 'medium', 'high', 'max'],
    128000,
    false,
  ),
  ...models(
    'anthropic',
    ['claude-opus-4-7', 'claude-opus-4-8', 'claude-sonnet-5'],
    'anthropic-adaptive',
    'toggle',
    ['low', 'medium', 'high', 'xhigh', 'max'],
    128000,
    false,
  ),
  ...models(
    'anthropic',
    ['claude-opus-5'],
    'anthropic-adaptive',
    'toggle',
    ['low', 'medium', 'high', 'xhigh', 'max'],
    128000,
    true,
  ),
  ...models(
    'anthropic',
    ['claude-fable-5', 'claude-mythos-5', 'claude-mythos-preview'],
    'anthropic-adaptive',
    'always',
    ['low', 'medium', 'high', 'xhigh', 'max'],
    128000,
    true,
  ),
  ...models(
    'qwen',
    ['qwen3.5-plus', 'qwen3.6-plus', 'qwen3.7-plus', 'qwen3.7-max'],
    'enable_thinking',
    'toggle',
    [],
    65536,
  ),
  ...models(
    'qwen',
    ['qwen3.8-max', 'qwen3.8-flash'],
    'enable_thinking',
    'toggle',
    ['low', 'medium', 'xhigh'],
    65536,
  ),
  ...models('qwen', ['qwen3-coder-plus', 'qwen3-coder-next'], 'default', 'none', [], 65536, false),
  ...models('qwen', ['qwen3-235b-a22b-thinking-2507'], 'default', 'always', [], 65536),
];
export function isProvider(value: unknown): value is ProviderId {
  return PROVIDERS.some((p) => p.id === value);
}
export function isProtocol(value: unknown): value is ApiProtocol {
  return value === 'openai' || value === 'anthropic';
}
/** Protocol rules apply only to exact catalog IDs and documented official combinations. */
export function getModelCapability(
  provider: ProviderId | null,
  model: string,
  protocol: ApiProtocol = 'openai',
): ModelCapability | undefined {
  const entry = MODELS.find((m) => m.provider === provider && m.id === model.trim());
  if (!entry) return undefined;
  if (protocol === 'openai') {
    // Claude's shim documents thinking, but explicitly ignores reasoning_effort;
    // output_config.effort is only documented for Messages. Manual overrides remain explicit.
    return provider === 'anthropic'
      ? {
          ...entry,
          efforts: [],
          source: 'https://platform.claude.com/docs/en/cli-sdks-libraries/libraries/openai-sdk',
        }
      : entry;
  }
  if (!PROVIDERS.find((p) => p.id === provider)?.endpoints.anthropic) return undefined;
  if (provider === 'kimi' && entry.id === 'kimi-k3')
    return {
      ...entry,
      control: 'thinking',
      capability: 'toggle',
      source: 'https://platform.kimi.ai/docs/guide/claude-code-kimi',
    };
  if (entry.control === 'enable_thinking') return { ...entry, control: 'thinking' };
  return entry;
}
export function allowedThinkingControls(protocol: ApiProtocol | null): readonly ThinkingControl[] {
  return protocol === 'anthropic'
    ? ['auto', 'default', 'thinking', 'anthropic-adaptive', 'anthropic-budget']
    : THINKING_CONTROLS;
}
/** A bare origin uses /v1; explicit prefixes are preserved, including Gemini and GLM API versions. */
export function normalizeEndpoint(input: string, protocol: ApiProtocol): string {
  const url = new URL(input.trim());
  const path = url.pathname.replace(/\/+$/u, '');
  const full = path.endsWith('/chat/completions')
    ? 'openai'
    : path.endsWith('/messages')
      ? 'anthropic'
      : undefined;
  if (full && full !== protocol) throw new LocalizedError(message('API 地址与接入协议不匹配'));
  if (!full)
    url.pathname =
      protocol === 'openai'
        ? `${path || '/v1'}/chat/completions`
        : `${path.endsWith('/v1') ? path : `${path}/v1`}/messages`;
  else url.pathname = path;
  url.hash = '';
  return url.toString();
}
export interface ResolvedProviderOptions {
  control: Exclude<ThinkingControl, 'auto'>;
  capability: ThinkingCapability | 'unknown';
  efforts: readonly ReasoningEffort[];
  parameters: Record<string, unknown>;
  maxOutputTokens: number;
}
/** Resolves only the active strategy. The disabled request never carries stale effort or budget. */
export function resolveProviderOptions(
  options: ModelOptions,
  fullDocument = false,
): ResolvedProviderOptions {
  if (!isProvider(options.provider) || !isProtocol(options.protocol))
    throw new LocalizedError(message('请补全供应商与接入协议'));
  if (
    !THINKING_CONTROLS.includes(options.thinkingControl) ||
    !allowedThinkingControls(options.protocol).includes(options.thinkingControl)
  )
    throw new LocalizedError(message('思考控制方式与接入协议不匹配'));
  if (!REASONING_EFFORTS.includes(options.reasoningEffort))
    throw new LocalizedError(message('思考强度无效'));
  if (typeof options.thinkingEnabled !== 'boolean')
    throw new LocalizedError(message('思考开关无效'));
  const model = getModelCapability(options.provider, options.model, options.protocol);
  if (
    options.maxOutputTokens !== null &&
    (!Number.isInteger(options.maxOutputTokens) ||
      options.maxOutputTokens < 1 ||
      options.maxOutputTokens > 1_000_000)
  )
    throw new LocalizedError(message('输出上限必须为 1–1000000 的整数'));
  if (model && options.maxOutputTokens !== null && options.maxOutputTokens > model.maxOutputTokens)
    throw new LocalizedError(message('输出上限超过模型限制'));
  const maxOutputTokens =
    options.maxOutputTokens ??
    Math.min(fullDocument ? 65536 : 8192, model?.maxOutputTokens ?? 8192);
  const control =
    options.thinkingControl === 'auto' ? (model?.control ?? 'default') : options.thinkingControl;
  const capability =
    options.thinkingControl === 'auto'
      ? (model?.capability ?? 'unknown')
      : control === 'default'
        ? 'unknown'
        : 'toggle';
  const efforts =
    options.thinkingControl === 'auto'
      ? (model?.efforts ?? [])
      : ['reasoning_effort', 'anthropic-adaptive', 'thinking', 'enable_thinking'].includes(control)
        ? REASONING_EFFORTS.filter((e) => e !== 'default')
        : [];
  if (capability === 'always' && !options.thinkingEnabled)
    throw new LocalizedError(message('此模型始终思考，无法关闭'));
  if (capability === 'none' || control === 'default')
    return { control, capability, efforts, parameters: {}, maxOutputTokens };
  const parameters: Record<string, unknown> = {};
  if (!options.thinkingEnabled) {
    if (control === 'reasoning_effort') parameters.reasoning_effort = 'none';
    else if (control === 'enable_thinking') parameters.enable_thinking = false;
    else parameters.thinking = { type: 'disabled' };
    return { control, capability, efforts, parameters, maxOutputTokens };
  }
  if (options.reasoningEffort !== 'default' && !efforts.includes(options.reasoningEffort))
    throw new LocalizedError(message('此模型或控制方式不支持所选思考强度'));
  // A manual strategy overrides the catalog, including the vendor's default-on behavior.
  const effort =
    options.reasoningEffort === 'default'
      ? control === 'reasoning_effort' &&
        (options.thinkingControl !== 'auto' || model?.defaultThinking === false)
        ? 'low'
        : undefined
      : options.reasoningEffort;
  if (control === 'reasoning_effort') {
    if (effort) parameters.reasoning_effort = effort;
  } else if (control === 'enable_thinking') parameters.enable_thinking = true;
  else if (control === 'anthropic-budget') {
    if (
      !Number.isInteger(options.thinkingBudgetTokens) ||
      options.thinkingBudgetTokens < 1024 ||
      options.thinkingBudgetTokens >= maxOutputTokens
    )
      throw new LocalizedError(message('思考预算必须至少 1024 且小于输出上限'));
    parameters.thinking = { type: 'enabled', budget_tokens: options.thinkingBudgetTokens };
  } else parameters.thinking = { type: control === 'anthropic-adaptive' ? 'adaptive' : 'enabled' };
  if (effort && control !== 'reasoning_effort') {
    if (
      options.protocol === 'anthropic' ||
      control === 'anthropic-adaptive' ||
      (options.provider === 'anthropic' && control === 'anthropic-budget')
    )
      parameters.output_config = { effort };
    else parameters.reasoning_effort = effort;
  }
  return { control, capability, efforts, parameters, maxOutputTokens };
}

export type ConfiguredProviderOptions = ProviderOptions & {
  provider: ProviderId;
  protocol: ApiProtocol;
};
/** Narrows the storage/UI draft at the trusted request boundary. */
export function configuredProviderOptions(options: ProviderOptions): ConfiguredProviderOptions {
  if (!isProvider(options.provider) || !isProtocol(options.protocol))
    throw new LocalizedError(message('请补全供应商与接入协议'));
  return { ...options, provider: options.provider, protocol: options.protocol };
}
/** Session data is a strict snapshot, never defaulted or upgraded while requests are in progress. */
export function parseConfiguredProviderOptions(
  value: Record<string, unknown>,
): ConfiguredProviderOptions | undefined {
  if (
    !isProvider(value.provider) ||
    !isProtocol(value.protocol) ||
    !(THINKING_CONTROLS as readonly unknown[]).includes(value.thinkingControl) ||
    !(REASONING_EFFORTS as readonly unknown[]).includes(value.reasoningEffort) ||
    typeof value.thinkingBudgetTokens !== 'number' ||
    (value.maxOutputTokens !== null && typeof value.maxOutputTokens !== 'number')
  )
    return undefined;
  return {
    provider: value.provider,
    protocol: value.protocol,
    thinkingControl: value.thinkingControl as ThinkingControl,
    reasoningEffort: value.reasoningEffort as ReasoningEffort,
    thinkingBudgetTokens: value.thinkingBudgetTokens,
    maxOutputTokens: value.maxOutputTokens,
  };
}
