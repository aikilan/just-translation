import {
  normalizeEndpoint,
  resolveProviderOptions,
  type ModelOptions,
  type ConfiguredProviderOptions,
} from './providers';
import { imageDataUrl, type ImageInput } from './image-input';

/** Application-owned content parts; the adapter owns each provider's wire representation. */
export type ProtocolContent =
  string | readonly ({ type: 'text'; text: string } | { type: 'image'; image: ImageInput })[];

type RequestSettings = ModelOptions &
  ConfiguredProviderOptions & { apiUrl: string; apiKey: string };
export interface ProtocolRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** Adapts a fixed configuration and shared prompt to one wire protocol; no retries or model fallbacks. */
export function buildProtocolRequest(
  settings: RequestSettings,
  system: string,
  content: ProtocolContent,
  fullDocument = false,
): ProtocolRequest {
  const resolved = resolveProviderOptions(settings, fullDocument);
  const url = normalizeEndpoint(settings.apiUrl, settings.protocol);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const key = settings.apiKey.trim();
  const body: Record<string, unknown> = {
    model: settings.model.trim(),
    stream: true,
    ...resolved.parameters,
  };
  if (settings.protocol === 'openai') {
    if (key) headers.Authorization = `Bearer ${key}`;
    body.messages = [
      { role: 'system', content: system },
      {
        role: 'user',
        content:
          typeof content === 'string'
            ? content
            : content.map((part) =>
                part.type === 'text'
                  ? part
                  : { type: 'image_url', image_url: { url: imageDataUrl(part.image) } },
              ),
      },
    ];
    // OpenAI's reasoning models use max_completion_tokens; compatible vendors document max_tokens.
    // An active thinking budget must be validated against the output limit sent on the wire.
    if (
      settings.maxOutputTokens !== null ||
      settings.provider === 'anthropic' ||
      (resolved.control === 'anthropic-budget' && settings.thinkingEnabled)
    )
      body[settings.provider === 'openai' ? 'max_completion_tokens' : 'max_tokens'] =
        resolved.maxOutputTokens;
  } else {
    headers['anthropic-version'] = '2023-06-01';
    const host = new URL(url).hostname;
    const officialBearer =
      (settings.provider === 'mimo' && host === 'api.xiaomimimo.com') ||
      (settings.provider === 'kimi' && ['api.moonshot.ai', 'api.moonshot.cn'].includes(host)) ||
      (settings.provider === 'qwen' &&
        ['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com'].includes(host));
    if (key)
      headers[officialBearer ? 'Authorization' : 'x-api-key'] = officialBearer
        ? `Bearer ${key}`
        : key;
    if (host === 'api.anthropic.com') headers['anthropic-dangerous-direct-browser-access'] = 'true';
    body.system = system;
    body.messages = [
      {
        role: 'user',
        content:
          typeof content === 'string'
            ? content
            : content.map((part) =>
                part.type === 'text'
                  ? part
                  : {
                      type: 'image',
                      source: {
                        type: 'base64',
                        media_type: part.image.mediaType,
                        data: part.image.data,
                      },
                    },
              ),
      },
    ];
    body.max_tokens = resolved.maxOutputTokens;
  }
  return { url, headers, body };
}
