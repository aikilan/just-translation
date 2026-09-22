import { TEST_PROFILE } from '../test-utils/provider';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { completionResponse, contentEvent, sseEvent, STREAM_END } from '../test-utils/sse';
import { translateBatch, type TranslationRequestOptions } from './translation-client';

const settings = { ...TEST_PROFILE, model: 'test', targetLanguage: 'Chinese' };
const segments = ['a', 'b', 'c'].map((id) => ({
  requestId: `${id}:0`,
  unitId: id,
  partIndex: 0,
  text: `Paragraph ${id}`,
}));
const encoder = new TextEncoder();

function controlledStream() {
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        source = controller;
      },
      cancel,
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
  return { response, source, cancel, push: (text: string) => source.enqueue(encoder.encode(text)) };
}

function request(response: Response, options: TranslationRequestOptions = {}) {
  return translateBatch(
    settings,
    segments,
    vi.fn<typeof fetch>().mockResolvedValue(response),
    undefined,
    { maxRetries: 0, ...options },
  );
}

describe('incremental Chat Completions translation', () => {
  afterEach(() => vi.restoreAllMocks());

  it('publishes a complete validated item before the body ends, never a partial string', async () => {
    const stream = controlledStream();
    const publish = vi.fn();
    const result = request(stream.response, { onTranslations: publish });
    stream.push(contentEvent('{"translations":[{"id":"a:0","text":"第一'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(publish).not.toHaveBeenCalled();
    stream.push(contentEvent('段"},{"id":"b:0","text":"第二'));
    try {
      await vi.waitFor(() => expect(publish).toHaveBeenCalledExactlyOnceWith({ 'a:0': '第一段' }));
    } finally {
      stream.push(contentEvent('段"},{"id":"c:0","text":"第三段"}]}') + STREAM_END);
      stream.source.close();
    }
    expect(await result).toEqual({
      translations: { 'a:0': '第一段', 'b:0': '第二段', 'c:0': '第三段' },
      failures: {},
    });
    expect(publish).toHaveBeenCalledTimes(3);
  });

  it('handles every UTF-8 byte boundary, escaped JSON, CRLF and multiple SSE events', async () => {
    const text = '中文😀 "quoted" \\ path\nbrace } and ] inside text';
    const wire =
      ': heartbeat\r\n\r\n' +
      sseEvent({ choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }) +
      contentEvent(
        JSON.stringify({
          translations: segments.map(({ requestId }) => ({ id: requestId, text })),
        }),
      ) +
      sseEvent({ choices: [], usage: { completion_tokens: 12 } }) +
      STREAM_END;
    const bytes = encoder.encode(wire.replace(/(?<!\r)\n/gu, '\r\n'));
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
          controller.close();
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
    expect((await request(response)).translations).toEqual(
      Object.fromEntries(segments.map(({ requestId }) => [requestId, text])),
    );
  });

  it('preserves a UTF-16 surrogate pair split between content events', async () => {
    const response = new Response(
      contentEvent('{"translations":[{"id":"a:0","text":"emoji \ud83d') +
        contentEvent('\ude00"},{"id":"b:0","text":"乙"},{"id":"c:0","text":"丙"}]}') +
        STREAM_END,
      { headers: { 'content-type': 'text/event-stream' } },
    );
    expect((await request(response)).translations['a:0']).toBe('emoji 😀');
  });

  it.each(['length', 'done-before-json-end', 'eof-without-done'])(
    'never accepts the unfinished item on %s',
    async (ending) => {
      const wire =
        contentEvent('{"translations":[{"id":"a:0","text":"甲"},{"id":"b:0","text":"半句') +
        (ending === 'length'
          ? sseEvent({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] })
          : ending === 'done-before-json-end'
            ? STREAM_END
            : '');
      const result = await request(
        new Response(wire, { headers: { 'content-type': 'text/event-stream' } }),
      );
      expect(result.translations).toEqual({ 'a:0': '甲' });
      expect(Object.keys(result.failures)).toEqual(['b:0', 'c:0']);
    },
  );

  it('uses the attempt timeout signal to cancel body reads and retain only previously validated items', async () => {
    const stream = controlledStream();
    const timeout = new AbortController();
    const publish = vi.fn();
    const result = request(stream.response, {
      scheduleAttempt: (attempt) => attempt(timeout.signal),
      onTranslations: publish,
    });
    stream.push(contentEvent('{"translations":[{"id":"a:0","text":"甲"},'));
    await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());
    timeout.abort(new Error('API 请求超时'));
    const output = await result;
    expect(output.translations).toEqual({ 'a:0': '甲' });
    expect(output.failures['b:0']).toEqual({ text: 'API 请求超时' });
    expect(stream.cancel).toHaveBeenCalledOnce();
  });

  it('accepts split JSON fences and multiline SSE data without repairing incomplete JSON', async () => {
    const stream = controlledStream();
    const result = request(stream.response);
    for (const part of [
      '`',
      '``j',
      'son\n',
      JSON.stringify({
        translations: segments.map(({ requestId }) => ({ id: requestId, text: '译文' })),
      }),
      '\n`',
      '``',
    ]) {
      stream.push(contentEvent(part));
    }
    stream.push(
      'data: {"choices":\ndata: [{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    );
    stream.source.close();
    expect((await result).failures).toEqual({});
  });

  it('retries a disconnected response with only outstanding ids through the same admission queue', async () => {
    const stream = controlledStream();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(stream.response)
      .mockResolvedValueOnce(
        completionResponse([
          { id: 'b:0', text: '第二段' },
          { id: 'c:0', text: '第三段' },
        ]),
      );
    const publish = vi.fn();
    const admit = vi.fn((attempt: (signal?: AbortSignal) => Promise<Record<string, string>>) =>
      attempt(),
    );
    const result = translateBatch(settings, segments, fetcher, undefined, {
      maxRetries: 1,
      sleep: vi.fn().mockResolvedValue(undefined),
      scheduleAttempt: admit,
      onTranslations: publish,
    });
    stream.push(
      contentEvent('{"translations":[{"id":"a:0","text":"第一段"},{"id":"b:0","text":"废弃半句'),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    stream.source.error(new TypeError('disconnected'));
    expect(await result).toEqual({
      translations: { 'a:0': '第一段', 'b:0': '第二段', 'c:0': '第三段' },
      failures: {},
    });
    expect(admit).toHaveBeenCalledTimes(2);
    expect(requestIds(fetcher.mock.calls[1]?.[1])).toEqual(['b:0', 'c:0']);
    expect(
      publish.mock.calls.filter(([value]) => Object.hasOwn(value as object, 'a:0')),
    ).toHaveLength(1);
    expect(JSON.stringify(publish.mock.calls)).not.toContain('废弃半句');
  });

  it('keeps the successful prefix in the final response when retries are exhausted', async () => {
    const stream = controlledStream();
    const result = request(stream.response);
    stream.push(
      contentEvent('{"translations":[{"id":"a:0","text":"第一段"},{"id":"b:0","text":"未完'),
    );
    stream.source.close();
    const output = await result;
    expect(output.translations).toEqual({ 'a:0': '第一段' });
    expect(Object.keys(output.failures)).toEqual(['b:0', 'c:0']);
  });

  it.each(['duplicate', 'unknown'])(
    'retries only outstanding IDs after a late %s without overwriting accepted results',
    async (kind) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          completionResponse([
            { id: 'a:0', text: '第一段' },
            { id: kind === 'duplicate' ? 'a:0' : 'foreign:0', text: '不可信覆盖' },
            { id: 'b:0', text: '不应继续接收' },
          ]),
        )
        .mockResolvedValueOnce(
          completionResponse([
            { id: 'b:0', text: '第二段' },
            { id: 'c:0', text: '第三段' },
          ]),
        );
      const publish = vi.fn();
      const output = await translateBatch(settings, segments, fetcher, undefined, {
        onTranslations: publish,
        sleep: vi.fn().mockResolvedValue(undefined),
      });
      expect(output.translations).toEqual({ 'a:0': '第一段', 'b:0': '第二段', 'c:0': '第三段' });
      expect(output.failures).toEqual({});
      expect(publish).toHaveBeenCalledTimes(3);
      expect(publish).toHaveBeenNthCalledWith(1, { 'a:0': '第一段' });
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(requestIds(fetcher.mock.calls[1][1])).toEqual(['b:0', 'c:0']);
    },
  );

  it('reports a bad tail only to diagnostics when all individual items already succeeded', async () => {
    const diagnostic = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const response = completionResponse([
      ...segments.map(({ requestId }) => ({ id: requestId, text: '有效译文' })),
      { id: 'a:0', text: '覆盖' },
    ]);
    expect((await request(response)).failures).toEqual({});
    expect(diagnostic).toHaveBeenCalled();
  });

  it.each([
    [
      'plain JSON',
      new Response('{"choices":[]}', { headers: { 'content-type': 'application/json' } }),
      /SSE|流式/u,
    ],
    [
      'missing body',
      new Response(null, { headers: { 'content-type': 'text/event-stream' } }),
      /流式|响应体/u,
    ],
    [
      'malformed event',
      new Response('data: {oops}\n\n', { headers: { 'content-type': 'text/event-stream' } }),
      /流式|JSON/u,
    ],
    [
      'missing choices',
      new Response(sseEvent({ nope: true }), { headers: { 'content-type': 'text/event-stream' } }),
      /choices/u,
    ],
    [
      'wrong root',
      new Response(contentEvent('{"other":[]}') + STREAM_END, {
        headers: { 'content-type': 'text/event-stream' },
      }),
      /translations/u,
    ],
  ])(
    'rejects %s with an actionable error and no non-streaming fallback',
    async (_name, response, error) => {
      const body = response.body ? await response.text() : null;
      const fetcher = vi
        .fn<typeof fetch>()
        .mockImplementation(() =>
          Promise.resolve(new Response(body, { headers: response.headers })),
        );
      await expect(
        translateBatch(settings, segments, fetcher, undefined, {
          sleep: vi.fn().mockResolvedValue(undefined),
        }),
      ).rejects.toThrow(error);
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(
        fetcher.mock.calls.every(
          ([, init]) =>
            typeof init?.body === 'string' && (JSON.parse(init.body) as { stream: boolean }).stream,
        ),
      ).toBe(true);
    },
  );

  it.each([
    { totalBytes: 10 * 1_048_576, accepted: true },
    { totalBytes: 10 * 1_048_576 + 1, accepted: false },
  ])(
    'enforces the 10 MiB batch stream limit at $totalBytes bytes',
    async ({ totalBytes, accepted }) => {
      const stream = controlledStream();
      const items = segments.map(({ requestId }) => ({ id: requestId, text: '译文' }));
      const completion = contentEvent(JSON.stringify({ translations: items })) + STREAM_END;
      let remainingBytes = totalBytes - encoder.encode(completion).byteLength;

      // Small SSE comments exercise cumulative wire bytes without exceeding event or JSON limits.
      while (remainingBytes > 65_536) {
        stream.push(`:${'x'.repeat(65_533)}\n\n`);
        remainingBytes -= 65_536;
      }
      stream.push(`:${'x'.repeat(remainingBytes - 3)}\n\n`);
      stream.push(completion);

      const result = request(stream.response);
      if (accepted) {
        await expect(result).resolves.toEqual({
          translations: Object.fromEntries(items.map(({ id, text }) => [id, text])),
          failures: {},
        });
      } else {
        await expect(result).rejects.toThrow('API 流式响应超过大小上限');
      }
      expect(stream.cancel).toHaveBeenCalledOnce();
    },
  );

  it('bounds buffered events instead of accumulating unbounded provider output', async () => {
    await expect(
      request(
        new Response(`data: ${'x'.repeat(262_145)}`, {
          headers: { 'content-type': 'text/event-stream' },
        }),
      ),
    ).rejects.toThrow('API 流式响应超过缓冲上限');
  });

  it('retries incomplete UTF-8 only once and retains its diagnostic', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() =>
      Promise.resolve(
        new Response(Uint8Array.of(0xe4, 0xb8), {
          headers: { 'content-type': 'text/event-stream' },
        }),
      ),
    );
    await expect(
      translateBatch(settings, segments, fetcher, undefined, {
        sleep: vi.fn().mockResolvedValue(undefined),
      }),
    ).rejects.toThrow('UTF-8');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('redacts a streamed provider error and does not retain the payload in diagnostics', async () => {
    const secret = 'private-test-secret';
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() =>
      Promise.resolve(
        new Response(sseEvent({ error: { message: `Rejected ${secret} ${'x'.repeat(1_000)}` } }), {
          headers: { 'content-type': 'text/event-stream' },
        }),
      ),
    );
    const error = await translateBatch({ ...settings, apiKey: secret }, segments, fetcher).catch(
      (value: unknown) => value,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(secret);
    expect((error as Error).message.length).toBeLessThanOrEqual(300);
  });

  it('cancels the reader on stop and ignores queued content without starting another attempt', async () => {
    const stream = controlledStream();
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(stream.response);
    const publish = vi.fn();
    const result = translateBatch(settings, segments, fetcher, controller.signal, {
      onTranslations: publish,
    });
    const rejected = expect(result).rejects.toThrow('stopped');
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort(new Error('stopped'));
    await rejected;
    expect(stream.cancel).toHaveBeenCalledOnce();
    expect(publish).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('records first content and first valid item separately from final response time', async () => {
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const stream = controlledStream();
    const onTiming = vi.fn();
    const result = request(stream.response, { onTiming });
    await new Promise((resolve) => setTimeout(resolve, 0));
    clock = 40;
    stream.push(contentEvent('{"translations":['));
    await new Promise((resolve) => setTimeout(resolve, 0));
    clock = 70;
    stream.push(
      contentEvent(
        segments.map(({ requestId }) => JSON.stringify({ id: requestId, text: '译文' })).join(','),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    clock = 200;
    stream.push(contentEvent(']}') + STREAM_END);
    stream.source.close();
    await result;
    expect(onTiming.mock.calls).toEqual([
      ['queue', 0],
      ['firstContent', 40],
      ['firstValidSegment', 70],
      ['request', 200],
    ]);
  });
});

function requestIds(init?: RequestInit): string[] {
  const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
    messages: { content: string }[];
  };
  const payload = JSON.parse(body.messages[1].content) as { segments: { id: string }[] };
  return payload.segments.map(({ id }) => id);
}
