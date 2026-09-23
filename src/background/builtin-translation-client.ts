import { message, LocalizedError } from '../shared/i18n';
import { preservesProtectedMarkers } from '../shared/protected-markers';
import { BUILTIN_TRANSLATOR_LIMITS, type BuiltinTranslatorId } from '../shared/translation-engines';

const GOOGLE_TRANSLATE_URL = 'https://translate.googleapis.com/translate_a/single';
const MICROSOFT_TRANSLATOR_URL = 'https://www.bing.com/translator';
const MICROSOFT_ALLOWED_HOSTS = new Set(['www.bing.com', 'cn.bing.com']);
const TRANSLATION_RESPONSE_LIMIT_BYTES = 256 * 1024;
const MICROSOFT_AUTH_RESPONSE_LIMIT_BYTES = 2 * 1024 * 1024;
const MICROSOFT_EXPIRY_MARGIN_MS = 60_000;
const BUILTIN_REQUEST_TIMEOUT_MS = 20_000;

export interface BuiltinTranslationRequest {
  engine: BuiltinTranslatorId;
  targetLanguageCode: string;
  text: string;
}

export interface BuiltinTranslationOptions {
  onRateLimit?: (delayMs: number) => void;
}

interface MicrosoftAuthentication {
  origin: string;
  key: string;
  token: string;
  ig: string;
  iid: string;
  expiresAt: number;
}

/** Executes only the two fixed, credential-free consumer translation protocols. */
export class BuiltinTranslationClient {
  private microsoftAuthentication: MicrosoftAuthentication | undefined;
  private microsoftAuthenticationPromise: Promise<MicrosoftAuthentication> | undefined;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;

  constructor(fetcher: typeof fetch = fetch, now: () => number = Date.now) {
    // Web API methods reject arbitrary receivers; bind once to the active Window/Worker global.
    this.fetcher = fetcher.bind(globalThis);
    this.now = now;
  }

  async translate(
    request: BuiltinTranslationRequest,
    signal?: AbortSignal,
    options: BuiltinTranslationOptions = {},
  ): Promise<string> {
    validateRequest(request);
    signal?.throwIfAborted();
    try {
      const translation =
        request.engine === 'google-free'
          ? await this.translateWithGoogle(request, signal, options)
          : await this.translateWithMicrosoft(request, signal, options);
      if (!translation.trim()) throw new LocalizedError(message('免费翻译通道未返回译文'));
      if (!preservesProtectedMarkers(request.text, translation))
        throw new LocalizedError(message('免费翻译通道损坏了保护标记'));
      return translation;
    } catch (error) {
      // Preserve product-owned diagnostics and cancellation; normalize opaque network failures.
      if (error instanceof LocalizedError || signal?.aborted) throw error;
      throw new LocalizedError(message('免费翻译通道暂时不可用，请稍后手动重试或切换引擎'));
    }
  }

  private async translateWithGoogle(
    request: BuiltinTranslationRequest,
    signal: AbortSignal | undefined,
    options: BuiltinTranslationOptions,
  ): Promise<string> {
    const url = new URL(GOOGLE_TRANSLATE_URL);
    url.search = new URLSearchParams({
      client: 'gtx',
      sl: 'auto',
      tl: request.targetLanguageCode,
      dt: 't',
      dj: '1',
    }).toString();
    const response = await this.fetcher(url.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: new URLSearchParams({ q: request.text }).toString(),
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal,
    });
    assertSuccessfulResponse(response, options.onRateLimit);
    const payload = parseJson(
      await readBoundedText(response, TRANSLATION_RESPONSE_LIMIT_BYTES, signal),
      '免费翻译通道返回格式无效',
    );
    if (!isRecord(payload) || !Array.isArray(payload.sentences) || payload.sentences.length === 0)
      throw new LocalizedError(message('免费翻译通道返回格式无效'));
    const translations = payload.sentences.map((sentence) =>
      isRecord(sentence) && typeof sentence.trans === 'string' ? sentence.trans : undefined,
    );
    if (translations.some((translation) => translation === undefined))
      throw new LocalizedError(message('免费翻译通道返回格式无效'));
    return translations.join('');
  }

  private async translateWithMicrosoft(
    request: BuiltinTranslationRequest,
    signal: AbortSignal | undefined,
    options: BuiltinTranslationOptions,
  ): Promise<string> {
    const authentication = await this.getMicrosoftAuthentication(signal, options.onRateLimit);
    signal?.throwIfAborted();
    const url = new URL('/ttranslatev3', authentication.origin);
    url.search = new URLSearchParams({
      isVertical: '1',
      IG: authentication.ig,
      IID: authentication.iid,
    }).toString();
    const response = await this.fetcher(url.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: new URLSearchParams({
        text: request.text,
        fromLang: 'auto-detect',
        to: request.targetLanguageCode,
        token: authentication.token,
        key: authentication.key,
      }).toString(),
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal,
    });
    if (response.status === 401 || response.status === 403) {
      if (this.microsoftAuthentication === authentication) this.microsoftAuthentication = undefined;
    }
    assertSuccessfulResponse(response, options.onRateLimit);
    const payload = parseJson(
      await readBoundedText(response, TRANSLATION_RESPONSE_LIMIT_BYTES, signal),
      '免费翻译通道返回格式无效',
    );
    if (!Array.isArray(payload) || !isRecord(payload[0]) || !Array.isArray(payload[0].translations))
      throw new LocalizedError(message('免费翻译通道返回格式无效'));
    const translations: unknown[] = payload[0].translations;
    const item = translations.find(
      (translation) =>
        isRecord(translation) &&
        translation.to === request.targetLanguageCode &&
        typeof translation.text === 'string',
    );
    if (!isRecord(item) || typeof item.text !== 'string')
      throw new LocalizedError(message('免费翻译通道返回格式无效'));
    return item.text;
  }

  private getMicrosoftAuthentication(
    signal?: AbortSignal,
    onRateLimit?: (delayMs: number) => void,
  ): Promise<MicrosoftAuthentication> {
    if (this.microsoftAuthentication && this.microsoftAuthentication.expiresAt > this.now()) {
      return Promise.resolve(this.microsoftAuthentication);
    }
    this.microsoftAuthentication = undefined;
    this.microsoftAuthenticationPromise ??= this.loadMicrosoftAuthentication(onRateLimit).finally(
      () => {
        this.microsoftAuthenticationPromise = undefined;
      },
    );
    return waitForSignal(this.microsoftAuthenticationPromise, signal);
  }

  private async loadMicrosoftAuthentication(
    onRateLimit?: (delayMs: number) => void,
  ): Promise<MicrosoftAuthentication> {
    // Token refresh is shared across tabs. One caller cancelling must not abort another caller's refresh.
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new LocalizedError(message('API 请求超时'))),
      BUILTIN_REQUEST_TIMEOUT_MS,
    );
    try {
      const response = await this.fetcher(MICROSOFT_TRANSLATOR_URL, {
        method: 'GET',
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'follow',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      });
      assertSuccessfulResponse(response, onRateLimit);
      const responseUrl = parseMicrosoftTranslatorUrl(response.url);
      const html = await readBoundedText(
        response,
        MICROSOFT_AUTH_RESPONSE_LIMIT_BYTES,
        controller.signal,
      );
      const helper =
        /params_AbusePreventionHelper\s*=\s*\[\s*(\d{10,16})\s*,\s*"([^"\\\r\n]{1,512})"\s*,\s*(\d{4,9})\s*\]/u.exec(
          html,
        );
      const ig = /\bIG\s*:\s*"([A-Fa-f0-9]{16,64})"/u.exec(html)?.[1];
      const iid =
        /<[^>]*(?=[^>]*\bid=["']rich_tta["'])(?=[^>]*\bdata-iid=["']([^"']{1,128})["'])[^>]*>/iu.exec(
          html,
        )?.[1];
      if (!helper || !ig || !iid)
        throw new LocalizedError(message('Microsoft 免费通道鉴权格式已变更'));
      const ttlMs = Number(helper[3]);
      if (!Number.isSafeInteger(ttlMs) || ttlMs <= MICROSOFT_EXPIRY_MARGIN_MS || ttlMs > 86_400_000)
        throw new LocalizedError(message('Microsoft 免费通道鉴权格式已变更'));
      const authentication: MicrosoftAuthentication = {
        origin: responseUrl.origin,
        key: helper[1],
        token: helper[2],
        ig,
        iid,
        expiresAt: this.now() + ttlMs - MICROSOFT_EXPIRY_MARGIN_MS,
      };
      this.microsoftAuthentication = authentication;
      return authentication;
    } catch (error) {
      // Some stream implementations reject with AbortError instead of the product timeout reason.
      if (controller.signal.aborted && controller.signal.reason instanceof Error)
        throw controller.signal.reason;
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

function waitForSignal<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      const reason: unknown = signal.reason;
      reject(
        reason instanceof Error
          ? reason
          : new DOMException('The request was aborted', 'AbortError'),
      );
    };
    signal.addEventListener('abort', abort, { once: true });
    void work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function validateRequest(request: BuiltinTranslationRequest): void {
  if (!request.text.trim()) throw new LocalizedError(message('请选择需要翻译的文字'));
  if (request.text.length > BUILTIN_TRANSLATOR_LIMITS.maxCharacters)
    throw new LocalizedError(
      message('免费翻译通道单次最多支持 {{p0}} 个字符', {
        p0: BUILTIN_TRANSLATOR_LIMITS.maxCharacters,
      }),
    );
  if (!/^[A-Za-z]{2,3}(?:-[A-Za-z]{2,8})?$/u.test(request.targetLanguageCode))
    throw new LocalizedError(message('免费翻译通道不支持当前目标语言'));
}

function parseMicrosoftTranslatorUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new LocalizedError(message('Microsoft 免费通道重定向安全校验失败'));
  }
  if (
    url.protocol !== 'https:' ||
    !MICROSOFT_ALLOWED_HOSTS.has(url.hostname) ||
    url.pathname.replace(/\/+$/u, '') !== '/translator'
  ) {
    throw new LocalizedError(message('Microsoft 免费通道重定向安全校验失败'));
  }
  return url;
}

function assertSuccessfulResponse(
  response: Response,
  onRateLimit?: (delayMs: number) => void,
): void {
  if (response.ok) return;
  const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
  if (response.status === 429) {
    onRateLimit?.(retryAfterMs ?? 1_000);
    throw new LocalizedError(message('免费翻译通道已限流，请稍后手动重试或切换引擎'));
  }
  throw new LocalizedError(message('免费翻译通道请求失败（{{p0}}）', { p0: response.status }));
}

async function readBoundedText(
  response: Response,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new LocalizedError(message('免费翻译通道响应过大'));
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let result = '';
  const abort = () => {
    void reader.cancel(signal?.reason).catch(() => undefined);
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      const { done, value } = await waitForSignal(reader.read(), signal);
      if (done) break;
      received += value.byteLength;
      if (received > maximumBytes) {
        const error = new LocalizedError(message('免费翻译通道响应过大'));
        await reader.cancel(error).catch(() => undefined);
        throw error;
      }
      result += decoder.decode(value, { stream: true });
    }
    return result + decoder.decode();
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    if (signal?.aborted && signal.reason instanceof Error) throw signal.reason;
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}

function parseJson(value: string, invalidMessage: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new LocalizedError(invalidMessage);
  }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const retryAt = Date.parse(value);
  return Number.isNaN(retryAt) ? undefined : Math.max(0, retryAt - Date.now());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
