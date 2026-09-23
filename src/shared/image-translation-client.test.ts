import { describe, expect, it, vi } from 'vitest';
import { translateImage } from './image-translation-client';
import { TEST_PROFILE } from '../test-utils/provider';
import { completionResponse } from '../test-utils/sse';

const config = {
  ...TEST_PROFILE,
  model: 'vision',
  apiKey: 'secret-key',
  targetLanguage: 'Chinese',
};
const image = { mediaType: 'image/png' as const, data: 'iVBORw0KGgo=', width: 10, height: 10 };
const response = (text: string) => completionResponse([{ id: 'image', text }]);
const event = (type: string, value: object = {}) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`;

describe('image translation wire contract', () => {
  it('sends the image as an OpenAI content block and translates optional text with it', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response('图片译文'));
    expect(await translateImage(config, 'extra source', image, fetcher)).toEqual({
      status: 'translated',
      text: '图片译文',
    });
    const body = JSON.parse(fetcher.mock.calls[0][1]!.body as string) as {
      messages: { content: unknown[] }[];
    };
    expect(body.messages[1].content).toContainEqual({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' },
    });
    expect(body.messages[1].content).toContainEqual({ type: 'text', text: 'extra source' });
    expect(body.messages[0].content).toContain('untrusted');
  });
  it('sends Anthropic image sources and parses the existing Messages stream', async () => {
    const wire =
      event('message_start', { message: { role: 'assistant', content: [], stop_reason: null } }) +
      event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
      event('content_block_delta', {
        index: 0,
        delta: { type: 'text_delta', text: '{"translations":[{"id":"image","text":"翻译"}]}' },
      }) +
      event('content_block_stop', { index: 0 }) +
      event('message_delta', { delta: { stop_reason: 'end_turn' } }) +
      event('message_stop');
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(wire, { headers: { 'content-type': 'text/event-stream' } }));
    expect(
      await translateImage({ ...config, protocol: 'anthropic' }, '', image, fetcher),
    ).toMatchObject({ status: 'translated', text: '翻译' });
    const body = JSON.parse(fetcher.mock.calls[0][1]!.body as string) as {
      messages: { content: unknown[] }[];
    };
    expect(body.messages[0].content[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: image.data },
    });
  });
  it('distinguishes a valid no-text result from malformed or missing output', async () => {
    expect(
      await translateImage(config, '', image, vi.fn().mockResolvedValue(response(''))),
    ).toEqual({ status: 'no-text', text: '' });
    await expect(
      translateImage(
        config,
        '',
        image,
        vi.fn().mockResolvedValue(completionResponse([])),
        undefined,
        { maxRetries: 0 },
      ),
    ).rejects.toThrow();
    await expect(
      translateImage(
        config,
        '',
        image,
        vi.fn().mockResolvedValue(completionResponse([{ id: 'wrong', text: 'translated' }])),
        undefined,
        { maxRetries: 0 },
      ),
    ).rejects.toThrow();
  });
  it('does not retry unsupported input and never exposes raw keys or image bytes in errors', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(`unsupported secret-key ${image.data}`, { status: 400 }));
    const error = await translateImage(config, '', image, fetcher, undefined, {
      maxRetries: 3,
    }).catch((reason: unknown) => reason);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(String(error)).not.toContain(config.apiKey);
    expect(String(error)).not.toContain(image.data);
  });
  it('re-enters shared admission on rate limits and stops retrying on cancellation', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '2' } }))
      .mockResolvedValueOnce(response('ok'));
    const onRateLimit = vi.fn();
    const scheduleAttempt = vi.fn(
      (attempt: (signal?: AbortSignal) => Promise<Record<string, string>>) => attempt(),
    );
    const sleep = vi.fn().mockResolvedValue(undefined);
    await translateImage(config, '', image, fetcher, undefined, {
      maxRetries: 1,
      onRateLimit,
      scheduleAttempt,
      sleep,
    });
    expect(scheduleAttempt).toHaveBeenCalledTimes(2);
    expect(onRateLimit).toHaveBeenCalledWith(2000);
    const controller = new AbortController();
    controller.abort();
    fetcher.mockClear();
    await expect(translateImage(config, '', image, fetcher, controller.signal)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('redacts stream errors even when they echo only part of an image or credential', async () => {
    const wire = `data: ${JSON.stringify({ error: { message: 'bad payload iVBORw0K secret-' } })}\n\n`;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(wire, { headers: { 'content-type': 'text/event-stream' } }));
    const error = await translateImage(config, '', image, fetcher).catch(
      (reason: unknown) => reason,
    );
    expect(String(error)).not.toContain('iVBORw0K');
    expect(String(error)).not.toContain('secret-');
  });
});
