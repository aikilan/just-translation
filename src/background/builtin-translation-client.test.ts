import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderMessage } from '../shared/i18n';
import { BuiltinTranslationClient } from './builtin-translation-client';

const MICROSOFT_HTML = `
  <script>
    var params_AbusePreventionHelper = [1720000000000,"test-token",3600000];
    var _G = { IG:"0123456789ABCDEF0123456789ABCDEF" };
  </script>
  <div id="rich_tta" data-iid="translator.5028.1"></div>
`;

function response(body: BodyInit | null, init: ResponseInit & { url?: string } = {}): Response {
  const value = new Response(body, init);
  if (init.url) Object.defineProperty(value, 'url', { value: init.url });
  return value;
}

function requestUrl(value: Parameters<typeof fetch>[0]): string {
  if (typeof value === 'string') return value;
  return value instanceof URL ? value.href : value.url;
}

function requestBody(value: BodyInit | null | undefined): string {
  if (typeof value !== 'string') throw new Error('Expected a form-encoded string body');
  return value;
}

afterEach(() => vi.useRealTimers());

describe('BuiltinTranslationClient Google adapter', () => {
  it('calls a native-style fetch function without binding the client as its receiver', async () => {
    const fetcher = function (this: unknown): Promise<Response> {
      expect(this).toBe(globalThis);
      return Promise.resolve(
        response(JSON.stringify({ sentences: [{ trans: 'translated' }] }), { status: 200 }),
      );
    } as typeof fetch;

    await new BuiltinTranslationClient(fetcher).translate({
      engine: 'google-free',
      targetLanguageCode: 'en',
      text: 'bonjour',
    });
  });

  it('posts text in the body and parses every returned sentence', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response(
        JSON.stringify({
          sentences: [{ trans: '你好 ' }, { trans: '[[JT_KEEP_0]] 世界' }],
          src: 'en',
        }),
        { status: 200 },
      ),
    );
    const client = new BuiltinTranslationClient(fetcher);

    await expect(
      client.translate({
        engine: 'google-free',
        targetLanguageCode: 'zh-CN',
        text: 'Hello [[JT_KEEP_0]] world',
      }),
    ).resolves.toBe('你好 [[JT_KEEP_0]] 世界');

    const [url, init] = fetcher.mock.calls[0];
    expect(requestUrl(url)).toBe(
      'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t&dj=1',
    );
    expect(init).toMatchObject({ method: 'POST', credentials: 'omit', cache: 'no-store' });
    expect(new URLSearchParams(requestBody(init?.body)).get('q')).toBe('Hello [[JT_KEEP_0]] world');
    expect(requestUrl(url)).not.toContain('Hello');
  });

  it('rejects malformed, oversized and marker-damaging responses', async () => {
    const malformed = new BuiltinTranslationClient(
      vi.fn<typeof fetch>().mockResolvedValue(response('{"sentences":[]}', { status: 200 })),
    );
    await expect(
      malformed.translate({ engine: 'google-free', targetLanguageCode: 'en', text: 'bonjour' }),
    ).rejects.toThrow('手动重试或切换引擎');

    const oversized = new BuiltinTranslationClient(
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(response('x'.repeat(256 * 1024 + 1), { status: 200 })),
    );
    await expect(
      oversized.translate({ engine: 'google-free', targetLanguageCode: 'en', text: 'bonjour' }),
    ).rejects.toThrow('响应过大');

    const markers = new BuiltinTranslationClient(
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          response(JSON.stringify({ sentences: [{ trans: 'marker lost' }] }), { status: 200 }),
        ),
    );
    await expect(
      markers.translate({
        engine: 'google-free',
        targetLanguageCode: 'en',
        text: 'bonjour [[JT_KEEP_0]]',
      }),
    ).rejects.toThrow('保护标记');
  });

  it('accepts a valid response up to the documented 256 KiB byte limit', async () => {
    const translated = 'x'.repeat(150 * 1024);
    const client = new BuiltinTranslationClient(
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          response(JSON.stringify({ sentences: [{ trans: translated }] }), { status: 200 }),
        ),
    );
    await expect(
      client.translate({ engine: 'google-free', targetLanguageCode: 'en', text: 'bonjour' }),
    ).resolves.toBe(translated);
  });

  it('forwards cancellation to an in-flight Google request', async () => {
    const fetcher = vi.fn<typeof fetch>((_input, init) => {
      const signal = init?.signal;
      if (!(signal instanceof AbortSignal)) throw new Error('Expected an AbortSignal');
      return new Promise((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(signal.reason instanceof Error ? signal.reason : new Error('aborted')),
          { once: true },
        );
      });
    });
    const controller = new AbortController();
    const pending = new BuiltinTranslationClient(fetcher).translate(
      { engine: 'google-free', targetLanguageCode: 'en', text: 'bonjour' },
      controller.signal,
    );

    controller.abort(new Error('cancelled by user'));

    await expect(pending).rejects.toThrow('cancelled by user');
  });
});

describe('BuiltinTranslationClient Microsoft adapter', () => {
  it('uses the redirected Bing origin and never sends cookies', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response(MICROSOFT_HTML, { status: 200, url: 'https://cn.bing.com/translator' }),
      )
      .mockResolvedValueOnce(
        response(
          JSON.stringify([
            {
              detectedLanguage: { language: 'en', score: 1 },
              translations: [{ text: '你好 [[JT_KEEP_0]]', to: 'zh-Hans' }],
            },
          ]),
          { status: 200, url: 'https://cn.bing.com/ttranslatev3' },
        ),
      );
    const client = new BuiltinTranslationClient(fetcher, () => 1720000001000);

    await expect(
      client.translate({
        engine: 'microsoft-free',
        targetLanguageCode: 'zh-Hans',
        text: 'Hello [[JT_KEEP_0]]',
      }),
    ).resolves.toBe('你好 [[JT_KEEP_0]]');

    expect(fetcher.mock.calls[0]).toEqual([
      'https://www.bing.com/translator',
      expect.objectContaining({ method: 'GET', credentials: 'omit', cache: 'no-store' }),
    ]);
    const [url, init] = fetcher.mock.calls[1];
    expect(requestUrl(url)).toBe(
      'https://cn.bing.com/ttranslatev3?isVertical=1&IG=0123456789ABCDEF0123456789ABCDEF&IID=translator.5028.1',
    );
    expect(init).toMatchObject({ method: 'POST', credentials: 'omit', cache: 'no-store' });
    expect(Object.fromEntries(new URLSearchParams(requestBody(init?.body)))).toEqual({
      text: 'Hello [[JT_KEEP_0]]',
      fromLang: 'auto-detect',
      to: 'zh-Hans',
      token: 'test-token',
      key: '1720000000000',
    });
  });

  it('rejects an authentication redirect outside the exact Bing allowlist', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        response(MICROSOFT_HTML, { status: 200, url: 'https://bing.example.com/translator' }),
      );
    const client = new BuiltinTranslationClient(fetcher);

    await expect(
      client.translate({
        engine: 'microsoft-free',
        targetLanguageCode: 'en',
        text: 'bonjour',
      }),
    ).rejects.toThrow('安全校验');
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('shares one in-flight token fetch and refreshes only after expiry', async () => {
    let resolveAuth!: (value: Response) => void;
    const auth = new Promise<Response>((resolve) => {
      resolveAuth = resolve;
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => auth)
      .mockImplementation(() =>
        Promise.resolve(
          response(JSON.stringify([{ translations: [{ text: 'translated', to: 'en' }] }]), {
            status: 200,
            url: 'https://www.bing.com/ttranslatev3',
          }),
        ),
      );
    const client = new BuiltinTranslationClient(fetcher, () => 1720000001000);
    const request = {
      engine: 'microsoft-free' as const,
      targetLanguageCode: 'en',
      text: 'bonjour',
    };

    const first = client.translate(request);
    const second = client.translate(request);
    expect(fetcher).toHaveBeenCalledOnce();
    resolveAuth(response(MICROSOFT_HTML, { status: 200, url: 'https://www.bing.com/translator' }));
    await expect(Promise.all([first, second])).resolves.toEqual(['translated', 'translated']);
    expect(
      fetcher.mock.calls.filter(([url]) => requestUrl(url).endsWith('/translator')),
    ).toHaveLength(1);
  });

  it('isolates cancellation while concurrent Microsoft requests share one token refresh', async () => {
    let resolveAuth!: (value: Response) => void;
    const auth = new Promise<Response>((resolve) => {
      resolveAuth = resolve;
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => auth)
      .mockImplementation(() =>
        Promise.resolve(
          response(JSON.stringify([{ translations: [{ text: 'translated', to: 'en' }] }]), {
            status: 200,
            url: 'https://www.bing.com/ttranslatev3',
          }),
        ),
      );
    const client = new BuiltinTranslationClient(fetcher, () => 1_720_000_001_000);
    const firstController = new AbortController();
    const secondController = new AbortController();
    const request = {
      engine: 'microsoft-free' as const,
      targetLanguageCode: 'en',
      text: 'bonjour',
    };

    const first = client.translate(request, firstController.signal);
    const second = client.translate(request, secondController.signal);
    firstController.abort(new Error('cancel first only'));
    await expect(first).rejects.toThrow('cancel first only');
    resolveAuth(response(MICROSOFT_HTML, { status: 200, url: 'https://www.bing.com/translator' }));
    await expect(second).resolves.toBe('translated');
    expect(
      fetcher.mock.calls.filter(([url]) => requestUrl(url).endsWith('/translator')),
    ).toHaveLength(1);
  });

  it('times out a stalled Microsoft authentication request after 20 seconds', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>((_input, init) => {
      const signal = init?.signal;
      if (!(signal instanceof AbortSignal)) throw new Error('Expected an AbortSignal');
      return new Promise((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(signal.reason instanceof Error ? signal.reason : new Error('aborted')),
          { once: true },
        );
      });
    });
    const pending = new BuiltinTranslationClient(fetcher).translate({
      engine: 'microsoft-free',
      targetLanguageCode: 'en',
      text: 'bonjour',
    });
    const rejected = expect(pending).rejects.toThrow('超时');

    await vi.advanceTimersByTimeAsync(20_000);

    await rejected;
  });

  it('keeps the Microsoft timeout active while reading the authentication body', async () => {
    vi.useFakeTimers();
    const cancelBody = vi.fn();
    const stalledBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('<html>'));
      },
      cancel: cancelBody,
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response(stalledBody, { status: 200, url: 'https://www.bing.com/translator' }),
      )
      .mockResolvedValueOnce(
        response(MICROSOFT_HTML, { status: 200, url: 'https://www.bing.com/translator' }),
      )
      .mockResolvedValueOnce(
        response(JSON.stringify([{ translations: [{ text: 'translated', to: 'en' }] }]), {
          status: 200,
          url: 'https://www.bing.com/ttranslatev3',
        }),
      );
    const client = new BuiltinTranslationClient(fetcher, () => 1_720_000_001_000);
    const request = {
      engine: 'microsoft-free' as const,
      targetLanguageCode: 'en',
      text: 'bonjour',
    };
    const outcome = Promise.race([
      client.translate(request).then(
        () => 'resolved',
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve('still pending'), 20_001)),
    ]);

    await vi.advanceTimersByTimeAsync(20_001);

    await expect(outcome).resolves.toContain('超时');
    expect(cancelBody).toHaveBeenCalledOnce();
    await expect(client.translate(request)).resolves.toBe('translated');
  });

  it('applies Retry-After when the Microsoft authentication page is rate-limited', async () => {
    const onRateLimit = vi.fn();
    const client = new BuiltinTranslationClient(
      vi.fn<typeof fetch>().mockResolvedValue(
        response('limited', {
          status: 429,
          headers: { 'retry-after': '4' },
          url: 'https://www.bing.com/translator',
        }),
      ),
    );

    await expect(
      client.translate(
        { engine: 'microsoft-free', targetLanguageCode: 'en', text: 'bonjour' },
        undefined,
        { onRateLimit },
      ),
    ).rejects.toThrow('限流');
    expect(onRateLimit).toHaveBeenCalledWith(4_000);
  });

  it('refreshes the in-memory Microsoft token after its safety-adjusted TTL', async () => {
    let now = 1_720_000_001_000;
    const translation = () =>
      response(JSON.stringify([{ translations: [{ text: 'translated', to: 'en' }] }]), {
        status: 200,
        url: 'https://www.bing.com/ttranslatev3',
      });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response(MICROSOFT_HTML, { status: 200, url: 'https://www.bing.com/translator' }),
      )
      .mockResolvedValueOnce(translation())
      .mockResolvedValueOnce(
        response(MICROSOFT_HTML, { status: 200, url: 'https://www.bing.com/translator' }),
      )
      .mockResolvedValueOnce(translation());
    const client = new BuiltinTranslationClient(fetcher, () => now);
    const request = {
      engine: 'microsoft-free' as const,
      targetLanguageCode: 'en',
      text: 'bonjour',
    };

    await client.translate(request);
    now += 3_540_001;
    await client.translate(request);
    expect(
      fetcher.mock.calls.filter(([url]) => requestUrl(url).endsWith('/translator')),
    ).toHaveLength(2);
  });

  it('accepts bounded authentication HTML and rejects content above 2 MiB', async () => {
    const withinLimit = `${' '.repeat(1_200_000)}${MICROSOFT_HTML}`;
    const validFetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response(withinLimit, { status: 200, url: 'https://www.bing.com/translator' }),
      )
      .mockResolvedValueOnce(
        response(JSON.stringify([{ translations: [{ text: 'translated', to: 'en' }] }]), {
          status: 200,
          url: 'https://www.bing.com/ttranslatev3',
        }),
      );
    await expect(
      new BuiltinTranslationClient(validFetcher, () => 1_720_000_001_000).translate({
        engine: 'microsoft-free',
        targetLanguageCode: 'en',
        text: 'bonjour',
      }),
    ).resolves.toBe('translated');

    const oversized = new BuiltinTranslationClient(
      vi.fn<typeof fetch>().mockResolvedValue(
        response(`${MICROSOFT_HTML}${' '.repeat(2 * 1024 * 1024)}`, {
          status: 200,
          url: 'https://www.bing.com/translator',
        }),
      ),
    );
    await expect(
      oversized.translate({
        engine: 'microsoft-free',
        targetLanguageCode: 'en',
        text: 'bonjour',
      }),
    ).rejects.toThrow('响应过大');
  });

  it('invalidates the Microsoft token after 401 and exposes rate-limit delay', async () => {
    const onRateLimit = vi.fn();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response(MICROSOFT_HTML, { status: 200, url: 'https://www.bing.com/translator' }),
      )
      .mockResolvedValueOnce(response('unauthorized', { status: 401 }))
      .mockResolvedValueOnce(
        response(MICROSOFT_HTML, { status: 200, url: 'https://www.bing.com/translator' }),
      )
      .mockResolvedValueOnce(response('limited', { status: 429, headers: { 'retry-after': '3' } }));
    const client = new BuiltinTranslationClient(fetcher, () => 1720000001000);
    const request = {
      engine: 'microsoft-free' as const,
      targetLanguageCode: 'en',
      text: 'bonjour',
    };

    await expect(client.translate(request)).rejects.toThrow('401');
    await expect(client.translate(request, undefined, { onRateLimit })).rejects.toThrow('限流');
    expect(
      fetcher.mock.calls.filter(([url]) => requestUrl(url).endsWith('/translator')),
    ).toHaveLength(2);
    expect(onRateLimit).toHaveBeenCalledWith(3_000);
  });
});

it('turns an opaque transport failure into actionable free-channel guidance', async () => {
  const client = new BuiltinTranslationClient(
    vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed')),
  );

  await expect(
    client.translate({ engine: 'google-free', targetLanguageCode: 'en', text: 'bonjour' }),
  ).rejects.toThrow('手动重试或切换引擎');
});

it('rejects oversized input before any network request', async () => {
  const fetcher = vi.fn<typeof fetch>();
  const client = new BuiltinTranslationClient(fetcher);
  await expect(
    client.translate({
      engine: 'google-free',
      targetLanguageCode: 'en',
      text: 'x'.repeat(1_001),
    }),
  ).rejects.toSatisfy(
    (error: unknown) =>
      error instanceof Error && renderMessage({ text: error.message }).includes('1000'),
  );
  expect(fetcher).not.toHaveBeenCalled();
});
