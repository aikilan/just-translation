import { describe, expect, it, vi } from 'vitest';
import { translateBatch } from './openai-client';
import { DEFAULT_SETTINGS } from './settings';
import { completionResponse, contentEvent } from '../test-utils/sse';

const config = { ...DEFAULT_SETTINGS.profiles[0], model: 'test', targetLanguage: 'Chinese' };
const segments = ['a', 'b'].map((id) => ({
  requestId: `${id}:0`,
  unitId: id,
  partIndex: 0,
  text: `Paragraph ${id}`,
}));
const success = () =>
  completionResponse([
    { id: 'a:0', text: '甲' },
    { id: 'b:0', text: '乙' },
  ]);

describe('one automatic retry budget', () => {
  it.each([400, 401, 429, 500])(
    'automatically retries HTTP %i once without user input',
    async (status) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response('provider failure', { status }))
        .mockResolvedValueOnce(success());
      const sleep = vi.fn().mockResolvedValue(undefined);
      expect(await translateBatch(config, segments, fetcher, undefined, { sleep })).toEqual({
        translations: { 'a:0': '甲', 'b:0': '乙' },
        failures: {},
      });
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenCalledExactlyOnceWith(400, undefined);
    },
  );

  it.each(['network', 'stream', 'missing'])(
    'does not exceed two attempts for repeated %s failures',
    async (kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(() => {
        if (kind === 'network') return Promise.reject(new TypeError('network disconnected'));
        if (kind === 'missing') return Promise.resolve(completionResponse([]));
        return Promise.resolve(
          new Response('data: invalid\n\n', {
            headers: { 'content-type': 'text/event-stream' },
          }),
        );
      });
      const sleep = vi.fn().mockResolvedValue(undefined);
      const result = await translateBatch(config, segments, fetcher, undefined, { sleep }).catch(
        (error: unknown) => error,
      );
      if (kind === 'missing')
        expect(result).toMatchObject({
          translations: {},
          failures: { 'a:0': 'AI 返回中缺少该段译文', 'b:0': 'AI 返回中缺少该段译文' },
        });
      else expect(result).toBeInstanceOf(Error);
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenCalledOnce();
    },
  );

  it.each(['missing-then-network', 'network-then-missing'])(
    'shares the budget for %s instead of nesting retries',
    async (kind) => {
      const fetcher = vi.fn<typeof fetch>();
      if (kind === 'missing-then-network')
        fetcher
          .mockResolvedValueOnce(completionResponse([{ id: 'a:0', text: '甲' }]))
          .mockRejectedValue(new TypeError('network failed'));
      else
        fetcher
          .mockRejectedValueOnce(new TypeError('network failed'))
          .mockImplementation(() =>
            Promise.resolve(completionResponse([{ id: 'a:0', text: '甲' }])),
          );
      const result = await translateBatch(config, segments, fetcher, undefined, {
        sleep: vi.fn().mockResolvedValue(undefined),
      });
      expect(result.translations).toEqual({ 'a:0': '甲' });
      expect(Object.keys(result.failures)).toEqual(['b:0']);
      expect(fetcher).toHaveBeenCalledTimes(2);
      if (kind === 'missing-then-network') expect(ids(fetcher.mock.calls[1][1])).toEqual(['b:0']);
    },
  );

  it('retries an expired HTTP attempt using a fresh admission signal and only outstanding IDs', async () => {
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const cancel = vi.fn();
    const stream = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          source = controller;
        },
        cancel,
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(stream)
      .mockResolvedValueOnce(completionResponse([{ id: 'b:0', text: '乙' }]));
    const signals: AbortController[] = [];
    const publish = vi.fn();
    const work = translateBatch(config, segments, fetcher, undefined, {
      sleep: vi.fn().mockResolvedValue(undefined),
      onTranslations: publish,
      scheduleAttempt: (attempt) => {
        const controller = new AbortController();
        signals.push(controller);
        return attempt(controller.signal);
      },
    });
    source.enqueue(
      new TextEncoder().encode(contentEvent('{"translations":[{"id":"a:0","text":"甲"},')),
    );
    await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());
    signals[0].abort(new Error('API 请求超时'));
    expect(await work).toEqual({ translations: { 'a:0': '甲', 'b:0': '乙' }, failures: {} });
    expect(cancel).toHaveBeenCalledOnce();
    expect(signals).toHaveLength(2);
    expect(signals[1].signal.aborted).toBe(false);
    expect(ids(fetcher.mock.calls[1][1])).toEqual(['b:0']);
  });

  it('cancels the backoff timer without sending the automatic retry', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('disconnected'));
    const work = translateBatch(config, segments, fetcher, controller.signal);
    const rejected = expect(work).rejects.toThrow('stopped');
    try {
      await vi.advanceTimersByTimeAsync(100);
      controller.abort(new Error('stopped'));
      await rejected;
      await vi.advanceTimersByTimeAsync(1000);
      expect(fetcher).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

/** Inspect only synthetic request IDs; no credentials are included in test diagnostics. */
function ids(init?: RequestInit): string[] {
  if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body');
  const body = JSON.parse(init.body) as { messages: { content: string }[] };
  return (JSON.parse(body.messages[1].content) as { segments: { id: string }[] }).segments.map(
    ({ id }) => id,
  );
}
