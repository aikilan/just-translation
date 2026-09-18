import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_PROVIDER_OPTIONS } from './providers';
import { translateBatch, translateFullDocument } from './translation-client';

const config = {
  ...DEFAULT_PROVIDER_OPTIONS,
  provider: 'mimo' as const,
  protocol: 'anthropic' as const,
  apiUrl: 'https://api.xiaomimimo.com/anthropic',
  apiKey: 'test-key',
  model: 'mimo-v2.5',
  thinkingEnabled: true,
  targetLanguage: 'Chinese',
  translationPrompt: 'Translate',
};
const segments = [
  { requestId: 'a', unitId: 'a', partIndex: 0, text: 'Hello' },
  { requestId: 'b', unitId: 'b', partIndex: 0, text: 'World' },
];
const event = (type: string, value: object = {}) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`;
const start = event('message_start', {
  message: { type: 'message', role: 'assistant', content: [], stop_reason: null },
});
const block = (index: number, text: string) =>
  event('content_block_start', { index, content_block: { type: 'text', text: '' } }) +
  event('content_block_delta', { index, delta: { type: 'text_delta', text } }) +
  event('content_block_stop', { index });
const end = event('message_delta', { delta: { stop_reason: 'end_turn' } }) + event('message_stop');
const response = (wire: string) =>
  new Response(wire, { headers: { 'content-type': 'text/event-stream' } });
describe('Anthropic translation transport', () => {
  it('sends correct MiMo headers/body, ignores thinking and reads multiple text blocks', async () => {
    const thinking =
      event('content_block_start', {
        index: 0,
        content_block: { type: 'thinking', thinking: '' },
      }) +
      event('content_block_delta', {
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'not translation' },
      }) +
      event('content_block_stop', { index: 0 });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        response(
          start +
            thinking +
            block(1, '{"translations":[{"id":"a","text":"你好"},') +
            block(2, '{"id":"b","text":"世界"}]}') +
            end,
        ),
      );
    expect(await translateBatch(config, segments, fetcher)).toEqual({
      translations: { a: '你好', b: '世界' },
      failures: {},
    });
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('https://api.xiaomimimo.com/anthropic/v1/messages');
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer test-key' });
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({ max_tokens: 8192, stream: true, thinking: { type: 'enabled' } });
    expect(typeof body.system).toBe('string');
    expect(body.messages).toMatchObject([{ role: 'user' }]);
  });
  it('keeps completed IDs and retries only missing IDs after premature EOF', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(start + block(0, '{"translations":[{"id":"a","text":"甲"},')))
      .mockResolvedValueOnce(
        response(start + block(0, '{"translations":[{"id":"b","text":"乙"}]}') + end),
      );
    expect(
      (await translateBatch(config, segments, fetcher, undefined, { baseRetryDelayMs: 0 }))
        .translations,
    ).toEqual({ a: '甲', b: '乙' });
    expect(fetcher.mock.calls[1][1]?.body).not.toContain('Hello');
  });
  it.each([
    start + block(0, '{"translations":[]}') + event('message_stop'),
    start +
      event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'oops' } }) +
      end,
    start + event('error', { error: { type: 'overloaded_error', message: 'busy' } }),
    start +
      event('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'tool' } }),
  ])('rejects invalid lifecycle and provider failures', async (wire) => {
    await expect(
      translateBatch(
        config,
        segments,
        vi.fn<typeof fetch>().mockResolvedValue(response(wire)),
        undefined,
        { maxRetries: 0 },
      ),
    ).rejects.toThrow();
  });
  it('fails whole-document output atomically on max_tokens', async () => {
    await expect(
      translateFullDocument(
        config,
        [{ id: 'a', text: 'Hello' }],
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            response(
              start +
                block(0, '{"translations":[{"id":"a","text":"甲"}]}') +
                event('message_delta', { delta: { stop_reason: 'max_tokens' } }) +
                event('message_stop'),
            ),
          ),
      ),
    ).rejects.toThrow('截断');
  });
});

it('decodes UTF-8 split across every byte and publishes text before message_stop', async () => {
  const { readTranslationStream } = await import('./translation-stream');
  let streamController: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
    },
  });
  const onItem = vi.fn();
  const pending = readTranslationStream(
    new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
    'anthropic',
    onItem,
  );
  const wire = start + block(0, '{"translations":[{"id":"a","text":"你好🌍"}]}');
  for (const byte of new TextEncoder().encode(wire)) streamController!.enqueue(Uint8Array.of(byte));
  await vi.waitFor(() => expect(onItem).toHaveBeenCalledWith({ id: 'a', text: '你好🌍' }));
  streamController!.enqueue(new TextEncoder().encode(end));
  streamController!.close();
  await pending;
});
it('cancels an Anthropic reader and does not retry an aborted request', async () => {
  const controller = new AbortController();
  const cancel = vi.fn();
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      new Response(new ReadableStream<Uint8Array>({ cancel }), {
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
  const pending = translateBatch(config, segments, fetcher, controller.signal);
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  controller.abort();
  await expect(pending).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(cancel).toHaveBeenCalled();
});
