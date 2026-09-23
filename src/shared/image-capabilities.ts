import { normalizeEndpoint, PROVIDERS, type ApiProtocol, type ProviderId } from './providers';
import type { TranslationProfile } from './settings';

type ImageSupport = 'supported' | 'unsupported' | 'unknown';
export interface ImageModelCapability {
  provider: ProviderId;
  model: string;
  support: ImageSupport;
  protocols: readonly ApiProtocol[];
  source: string;
  checkedAt: string;
}
function entries(
  provider: ProviderId,
  models: readonly string[],
  support: ImageSupport,
  protocols: readonly ApiProtocol[],
  source: string,
): ImageModelCapability[] {
  return models.map((model) => ({
    provider,
    model,
    support,
    protocols,
    source,
    checkedAt: '2026-09-23',
  }));
}

/** Exact documented IDs, not provider-wide guesses. Unknown is distinct from unsupported. */
export const IMAGE_MODEL_CAPABILITIES: readonly ImageModelCapability[] = [
  ...entries(
    'openai',
    [
      'gpt-4.1',
      'gpt-4.1-mini',
      'gpt-4.1-nano',
      'gpt-4o',
      'gpt-4o-mini',
      'gpt-5.1',
      'gpt-5.2',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.4-nano',
      'gpt-5.5',
      'gpt-5.6-sol',
      'gpt-6-astra',
    ],
    'supported',
    ['openai'],
    'https://developers.openai.com/api/docs/guides/images-vision',
  ),
  ...entries(
    'openai',
    ['gpt-5.6'],
    'supported',
    ['openai'],
    'https://developers.openai.com/api/docs/models/gpt-5.6-sol',
  ),
  ...entries(
    'gemini',
    [
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
      'gemini-2.5-pro',
      'gemini-3-pro-preview',
      'gemini-3.1-pro-preview',
      'gemini-3.7-flash',
      'gemini-3.8-flash',
      'gemini-3-flash-preview',
      'gemini-3.1-flash-lite-preview',
      'gemini-3.5-flash',
      'gemini-3.6-flash',
    ],
    'supported',
    ['openai'],
    'https://ai.google.dev/gemini-api/docs/openai#image-understanding',
  ),
  ...entries(
    'grok',
    ['grok-4.5', 'grok-4.6'],
    'supported',
    ['openai'],
    'https://docs.x.ai/developers/models',
  ),
  ...entries(
    'anthropic',
    [
      'claude-haiku-4-5',
      'claude-opus-4-5',
      'claude-sonnet-4-6',
      'claude-opus-4-6',
      'claude-opus-4-7',
      'claude-opus-4-8',
      'claude-sonnet-5',
      'claude-opus-5',
      'claude-fable-5',
      'claude-mythos-5',
      'claude-mythos-preview',
    ],
    'supported',
    ['openai', 'anthropic'],
    'https://platform.claude.com/docs/en/build-with-claude/vision',
  ),
  ...entries(
    'kimi',
    ['kimi-k2.6', 'kimi-k2.7-code', 'kimi-k2.7-code-highspeed', 'kimi-k3'],
    'supported',
    ['openai', 'anthropic'],
    'https://platform.kimi.ai/docs/models',
  ),
  ...entries(
    'glm',
    ['glm-4.5', 'glm-4.5-air'],
    'unsupported',
    ['openai', 'anthropic'],
    'https://docs.z.ai/guides/llm/glm-4.5',
  ),
  ...['glm-4.6', 'glm-4.7', 'glm-5', 'glm-5.1', 'glm-5.2'].flatMap((model) =>
    entries(
      'glm',
      [model],
      'unsupported',
      ['openai', 'anthropic'],
      `https://docs.z.ai/guides/llm/${model}`,
    ),
  ),
  ...entries(
    'mimo',
    ['mimo-v2.5'],
    'supported',
    ['openai', 'anthropic'],
    'https://mimo.mi.com/docs/en-US/quick-start/usage-guide/multimodal-understanding/image-understanding',
  ),
  ...entries(
    'mimo',
    ['mimo-v2.5-pro'],
    'unsupported',
    ['openai', 'anthropic'],
    'https://mimo.mi.com/models/en-US/mimo-v2.5-pro',
  ),
  ...entries(
    'deepseek',
    ['deepseek-flash'],
    'supported',
    ['openai', 'anthropic'],
    'https://api-docs.deepseek.com/guides/vision/',
  ),
  ...entries(
    'deepseek',
    ['deepseek-v4-pro'],
    'unsupported',
    ['openai', 'anthropic'],
    'https://api-docs.deepseek.com/quick_start/pricing/',
  ),
  ...['qwen-plus', 'qwen-flash', 'qwen3-coder-plus', 'qwen3-235b-a22b-thinking-2507'].flatMap(
    (model) =>
      entries(
        'qwen',
        [model],
        'unsupported',
        ['openai', 'anthropic'],
        `https://help.aliyun.com/en/model-studio/${model}`,
      ),
  ),
  ...entries(
    'qwen',
    ['qwen3-coder-next'],
    'unsupported',
    ['openai', 'anthropic'],
    'https://huggingface.co/Qwen/Qwen3-Coder-Next',
  ),
  // The undated alias is text-only; the dated 2026-06-08 release is a different model ID.
  ...entries(
    'qwen',
    ['qwen3.7-max'],
    'unsupported',
    ['openai', 'anthropic'],
    'https://www.alibabacloud.com/help/en/model-studio/text-generation',
  ),
  ...entries(
    'qwen',
    ['qwen3.5-plus', 'qwen3.6-plus', 'qwen3.7-plus', 'qwen3.8-max', 'qwen3.8-flash'],
    'supported',
    ['openai', 'anthropic'],
    'https://www.alibabacloud.com/help/en/model-studio/vision-model',
  ),
];

export interface ResolvedImageInputCapability {
  mode: 'catalog' | 'manual';
  supported: boolean;
  catalog?: ImageModelCapability;
}

/** Official presets use the catalog. Custom endpoints/aliases require the user's stored choice. */
export function resolveImageInputCapability(
  profile: Pick<
    TranslationProfile,
    'provider' | 'protocol' | 'apiUrl' | 'model' | 'imageInputEnabled'
  >,
): ResolvedImageInputCapability {
  const manual: ResolvedImageInputCapability = {
    mode: 'manual',
    supported: profile.imageInputEnabled === true,
  };
  if (!profile.provider || !profile.protocol) return { mode: 'manual', supported: false };
  const catalog = IMAGE_MODEL_CAPABILITIES.find(
    (entry) => entry.provider === profile.provider && entry.model === profile.model.trim(),
  );
  const official = PROVIDERS.find((provider) => provider.id === profile.provider)?.endpoints[
    profile.protocol
  ];
  if (!catalog || !official) return manual;
  try {
    if (
      normalizeEndpoint(profile.apiUrl, profile.protocol) !==
      normalizeEndpoint(official, profile.protocol)
    )
      return manual;
  } catch {
    return { mode: 'manual', supported: false };
  }
  return {
    mode: 'catalog',
    supported: catalog.support === 'supported' && catalog.protocols.includes(profile.protocol),
    catalog,
  };
}
