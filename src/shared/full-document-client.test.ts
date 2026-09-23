import { TEST_PROFILE } from '../test-utils/provider';
import { describe, expect, it, vi } from 'vitest';
import { translateFullDocument } from './translation-client';
import { completionResponse, contentEvent, sseEvent, STREAM_END } from '../test-utils/sse';

const settings = {
  ...TEST_PROFILE,
  thinkingEnabled: true,
  apiUrl: 'https://api.example.com/v1',
  apiKey: 'private-test-key',
  model: 'test',
  targetLanguage: 'Simplified Chinese',
  translationPrompt: 'Translate into {{targetLanguage}}.',
};
const units = Array.from({ length: 6 }, (_, i) => ({
  id: `p${i}`,
  text: i === 5 ? 'Same words.' : `Paragraph ${i}.`,
}));
const translations = units.map(({ id }) => ({ id, text: '译文。' }));
const stream = (body: string) =>
  new Response(body, { headers: { 'content-type': 'text/event-stream' } });

describe('full document request', () => {
  it('starts all request clocks after queue admission rather than while waiting', async () => {
    vi.useFakeTimers();
    try {
      let admit!: () => void;
      const queued = new Promise<void>((resolve) => {
        admit = resolve;
      });
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(completionResponse(translations));
      const work = translateFullDocument(settings, units, fetcher, undefined, {
        timeoutMs: 120_000,
        scheduleAttempt: async (attempt) => {
          await queued;
          return attempt(new AbortController().signal);
        },
      });
      await vi.advanceTimersByTimeAsync(700_000);
      expect(fetcher).not.toHaveBeenCalled();
      admit();
      await expect(work).resolves.toEqual(
        Object.fromEntries(translations.map(({ id, text }) => [id, text])),
      );
      expect(fetcher).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it.each(['openai', 'anthropic'] as const)(
    'keeps a progressing %s stream alive beyond two minutes',
    async (protocol) => {
      vi.useFakeTimers();
      try {
        let writer!: ReadableStreamDefaultController<Uint8Array>;
        const encode = (wire: string) => writer.enqueue(new TextEncoder().encode(wire));
        const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
          new Response(
            new ReadableStream<Uint8Array>({
              start(c) {
                writer = c;
              },
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          ),
        );
        const event = (type: string, value: object = {}) =>
          `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`;
        const work = translateFullDocument(
          { ...settings, protocol },
          [{ id: 'one', text: 'Source' }],
          fetcher,
        );
        await vi.advanceTimersByTimeAsync(0);
        if (protocol === 'anthropic')
          encode(
            event('message_start', {
              message: { type: 'message', role: 'assistant', content: [], stop_reason: null },
            }) +
              event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
          );
        for (const text of ['{"translations":[', '{"id":"one",', '"text":"', '译文"}]}']) {
          await vi.advanceTimersByTimeAsync(50_000);
          encode(
            protocol === 'openai'
              ? contentEvent(text)
              : event('content_block_delta', { index: 0, delta: { type: 'text_delta', text } }),
          );
          await vi.advanceTimersByTimeAsync(0);
        }
        encode(
          protocol === 'openai'
            ? STREAM_END
            : event('content_block_stop', { index: 0 }) +
                event('message_delta', { delta: { stop_reason: 'end_turn' } }) +
                event('message_stop'),
        );
        await expect(work).resolves.toEqual({ one: '译文' });
        expect(fetcher).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );
  it.each(['openai', 'anthropic'] as const)(
    'does not count %s reasoning, whitespace or usage as first translation output',
    async (protocol) => {
      vi.useFakeTimers();
      try {
        let writer!: ReadableStreamDefaultController<Uint8Array>;
        const cancel = vi.fn();
        const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
          new Response(
            new ReadableStream<Uint8Array>({
              start(c) {
                writer = c;
              },
              cancel,
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          ),
        );
        const work = translateFullDocument({ ...settings, protocol }, units, fetcher);
        const failed = expect(work).rejects.toThrow('首次');
        await vi.advanceTimersByTimeAsync(0);
        writer.enqueue(
          new TextEncoder().encode(
            protocol === 'openai'
              ? sseEvent({
                  choices: [
                    {
                      index: 0,
                      delta: { reasoning_content: 'thinking', content: ' ' },
                      finish_reason: null,
                    },
                  ],
                }) + sseEvent({ choices: [], usage: {} })
              : [
                  { type: 'message_start', message: { role: 'assistant', content: [] } },
                  { type: 'ping' },
                  { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
                  {
                    type: 'content_block_delta',
                    index: 0,
                    delta: { type: 'thinking_delta', thinking: 'thinking' },
                  },
                  { type: 'content_block_stop', index: 0 },
                  {
                    type: 'content_block_start',
                    index: 1,
                    content_block: { type: 'text', text: ' ' },
                  },
                  { type: 'message_delta', delta: {}, usage: { output_tokens: 20 } },
                ]
                  .map(sseEvent)
                  .join(''),
          ),
        );
        await vi.advanceTimersByTimeAsync(120_000);
        await failed;
        expect(cancel).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );
  it('sends every ordered paragraph once, including repeated text and an unsplit long paragraph', async () => {
    const input = [
      ...units,
      { id: 'repeat', text: units[5].text },
      { id: 'long', text: 'Long text. '.repeat(1000) },
    ];
    const fetcher = vi
      .fn()
      .mockResolvedValue(completionResponse(input.map(({ id }) => ({ id, text: '译文' }))));
    await translateFullDocument(settings, input, fetcher);
    expect(fetcher).toHaveBeenCalledOnce();
    const body = JSON.parse((fetcher.mock.calls[0][1] as RequestInit).body as string) as {
      messages: { content: string }[];
    };
    expect(JSON.parse(body.messages[1].content)).toEqual({
      segments: input.map(({ id, text }) => ({ id, group: id, part: 0, text })),
    });
    expect(body.messages[0].content).toContain('entire document');
  });

  it.each([
    [
      'missing paragraph',
      contentEvent(JSON.stringify({ translations: translations.slice(0, 5) })) + STREAM_END,
    ],
    [
      'empty paragraph',
      contentEvent(
        JSON.stringify({ translations: translations.map((t, i) => (i ? t : { ...t, text: '' })) }),
      ) + STREAM_END,
    ],
    [
      'duplicate id',
      contentEvent(JSON.stringify({ translations: [...translations, translations[0]] })) +
        STREAM_END,
    ],
    [
      'unknown id after all valid items',
      contentEvent(
        JSON.stringify({ translations: [...translations, { id: 'unknown', text: 'x' }] }),
      ) + STREAM_END,
    ],
    [
      'truncated output',
      contentEvent(JSON.stringify({ translations })) +
        sseEvent({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] }),
    ],
    ['missing normal end', contentEvent(JSON.stringify({ translations }))],
  ])('rejects the whole result without automatic retry: %s', async (_name, body) => {
    const fetcher = vi.fn().mockResolvedValue(stream(body));
    await expect(translateFullDocument(settings, units, fetcher)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([1, 47, 10000])(
    'rejects repeated root fields across SSE chunks of %s characters',
    async (size) => {
      const payload = `{"translations":${JSON.stringify(translations)},"translations":[]}`;
      let body = '';
      for (let i = 0; i < payload.length; i += size)
        body += contentEvent(payload.slice(i, i + size));
      const fetcher = vi.fn().mockResolvedValue(stream(body + STREAM_END));
      await expect(translateFullDocument(settings, units, fetcher)).rejects.toThrow();
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );

  it('does not resolve until the normal stream ending arrives', async () => {
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(value) {
          source = value;
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
    let complete = false;
    const result = translateFullDocument(settings, units, vi.fn().mockResolvedValue(response)).then(
      (value) => {
        complete = true;
        return value;
      },
    );
    source.enqueue(new TextEncoder().encode(contentEvent(JSON.stringify({ translations }))));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(complete).toBe(false);
    source.enqueue(new TextEncoder().encode(STREAM_END));
    source.close();
    await expect(result).resolves.toEqual(
      Object.fromEntries(translations.map((t) => [t.id, t.text])),
    );
  });

  it('rejects damaged protected markers and a request body over 1 MiB', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(completionResponse([{ id: 'p', text: 'lost marker' }]));
    await expect(
      translateFullDocument(settings, [{ id: 'p', text: 'Keep [[JT_KEEP_0]].' }], fetcher),
    ).rejects.toThrow();
    fetcher.mockClear();
    await expect(
      translateFullDocument(settings, [{ id: 'p', text: '文'.repeat(400_000) }], fetcher),
    ).rejects.toThrow('全文请求超过');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('uses separate full-document response limits without the small-batch JSON cap', async () => {
    const text = '译'.repeat(300_000);
    await expect(
      translateFullDocument(
        settings,
        [{ id: 'p', text: 'Source.' }],
        vi.fn().mockResolvedValue(completionResponse([{ id: 'p', text }])),
      ),
    ).resolves.toEqual({ p: text });
  });

  it.each(['event', 'json', 'stream'] as const)(
    'rejects a full response beyond its %s limit without another request',
    async (kind) => {
      const payload = JSON.stringify({
        translations: [{ id: 'p', text: 'x'.repeat(2 * 1_048_576) }],
      });
      const body =
        kind === 'event'
          ? contentEvent('x'.repeat(1_048_576))
          : kind === 'json'
            ? Array.from({ length: Math.ceil(payload.length / 400_000) }, (_, index) =>
                contentEvent(payload.slice(index * 400_000, (index + 1) * 400_000)),
              ).join('') + STREAM_END
            : ':'.padEnd(16 * 1_048_576 + 1, 'x');
      const fetcher = vi.fn().mockResolvedValue(stream(body));
      await expect(
        translateFullDocument(settings, [{ id: 'p', text: 'Source' }], fetcher),
      ).rejects.toThrow(/上限/);
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );

  it('reports model context limits separately and redacts provider errors', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: 'context_length_exceeded', message: 'private-test-key too long' },
        }),
        { status: 400 },
      ),
    );
    await expect(translateFullDocument(settings, units, fetcher)).rejects.toThrow('模型上下文');
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
