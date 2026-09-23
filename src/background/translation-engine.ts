import type { TranslationSegment, TranslationUnit } from '../shared/batching';
import { message, LocalizedError, toUiMessage } from '../shared/i18n';
import type { TranslationBatchResult, TranslationPriority } from '../shared/messages';
import { configuredProviderOptions } from '../shared/providers';
import {
  getActiveProfile,
  validateTranslationProfile,
  type TranslatorSettings,
} from '../shared/settings';
import {
  activeTranslatorEquals,
  BUILTIN_TRANSLATOR_LIMITS,
  isActiveTranslator,
  resolveBuiltinTargetLanguage,
  type ActiveTranslator,
  type BuiltinTranslatorId,
  type TranslationBatchLimits,
} from '../shared/translation-engines';
import {
  translateBatch,
  translateFullDocument,
  type TranslationRequestConfig,
  type TranslationRequestOptions,
} from '../shared/translation-client';
import type {
  BuiltinTranslationOptions,
  BuiltinTranslationRequest,
} from './builtin-translation-client';

export interface AiTranslationRuntimeConfig extends TranslationRequestConfig {
  kind: 'ai';
  profileId: string;
  profileName: string;
  translationRetryCount: number;
  fullDocumentTimeoutMinutes: number;
}

export interface BuiltinTranslationRuntimeConfig {
  kind: 'builtin';
  engine: BuiltinTranslatorId;
  targetLanguage: string;
  targetLanguageCode: string;
  translationRetryCount: number;
}

export type TranslationRuntimeConfig = AiTranslationRuntimeConfig | BuiltinTranslationRuntimeConfig;

export type TranslationBatchProfiles = Readonly<
  Record<TranslationPriority, TranslationBatchLimits>
>;

export interface BuiltinTranslator {
  translate(
    request: BuiltinTranslationRequest,
    signal?: AbortSignal,
    options?: BuiltinTranslationOptions,
  ): Promise<string>;
}

const AI_BATCH_PROFILES: TranslationBatchProfiles = {
  visible: { maxCharacters: 1_200, maxItems: 4 },
  readAhead: { maxCharacters: 1_800, maxItems: 4 },
  background: { maxCharacters: 2_400, maxItems: 4 },
};

const BUILTIN_BATCH_PROFILES: TranslationBatchProfiles = {
  visible: {
    maxCharacters: BUILTIN_TRANSLATOR_LIMITS.maxCharacters,
    maxItems: BUILTIN_TRANSLATOR_LIMITS.maxItems,
  },
  readAhead: {
    maxCharacters: BUILTIN_TRANSLATOR_LIMITS.maxCharacters,
    maxItems: BUILTIN_TRANSLATOR_LIMITS.maxItems,
  },
  background: {
    maxCharacters: BUILTIN_TRANSLATOR_LIMITS.maxCharacters,
    maxItems: BUILTIN_TRANSLATOR_LIMITS.maxItems,
  },
};

const AI_REQUEST_TIMEOUTS: Readonly<Record<TranslationPriority, number>> = {
  visible: 20_000,
  readAhead: 30_000,
  background: 60_000,
};

/** Resolves one trusted immutable snapshot and rejects a stale public selection. */
export function resolveTranslationRuntimeConfig(
  settings: TranslatorSettings,
  requested: ActiveTranslator,
): TranslationRuntimeConfig {
  if (!isActiveTranslator(requested)) throw new LocalizedError(message('翻译引擎无效'));
  if (!activeTranslatorEquals(settings.activeTranslator, requested))
    throw new LocalizedError(message('翻译设置已改变，请重新开始翻译'));
  if (requested.kind === 'builtin') {
    const targetLanguageCode = resolveBuiltinTargetLanguage(
      requested.engine,
      settings.targetLanguage,
    );
    if (!targetLanguageCode) throw new LocalizedError(message('免费翻译通道不支持当前目标语言'));
    return {
      kind: 'builtin',
      engine: requested.engine,
      targetLanguage: settings.targetLanguage,
      targetLanguageCode,
      translationRetryCount: settings.translationRetryCount,
    };
  }
  const profile = getActiveProfile(settings, requested.profileId);
  if (!profile) throw new LocalizedError(message('翻译配置不存在'));
  if (
    Object.keys(validateTranslationProfile(profile)).length > 0 ||
    !settings.targetLanguage.trim()
  )
    throw new LocalizedError(message('请先在设置页完成 API 配置'));
  return {
    kind: 'ai',
    profileId: profile.id,
    profileName: profile.name,
    ...profile,
    ...configuredProviderOptions(profile),
    targetLanguage: settings.targetLanguage,
    translationRetryCount: settings.translationRetryCount,
    fullDocumentTimeoutMinutes: settings.fullDocumentTimeoutMinutes,
  };
}

export function getTranslationBatchProfiles(
  settings: TranslationRuntimeConfig,
): TranslationBatchProfiles {
  return settings.kind === 'builtin' ? BUILTIN_BATCH_PROFILES : AI_BATCH_PROFILES;
}

export function getTranslationMaxConcurrency(
  settings: TranslationRuntimeConfig,
  requestedConcurrency: number,
): number {
  return settings.kind === 'builtin'
    ? Math.min(requestedConcurrency, BUILTIN_TRANSLATOR_LIMITS.maxConcurrency)
    : requestedConcurrency;
}

/** Consumer channels use one bounded attempt timeout regardless of viewport priority. */
export function getTranslationRequestTimeout(
  settings: TranslationRuntimeConfig,
  priority: TranslationPriority,
): number {
  return settings.kind === 'builtin' ? 20_000 : AI_REQUEST_TIMEOUTS[priority];
}

export function getTranslationQueueUrl(settings: TranslationRuntimeConfig): string {
  if (settings.kind === 'ai') return settings.apiUrl;
  return settings.engine === 'google-free'
    ? 'https://translate.googleapis.com'
    : 'https://www.bing.com';
}

export function getRuntimeActiveTranslator(settings: TranslationRuntimeConfig): ActiveTranslator {
  return settings.kind === 'builtin'
    ? { kind: 'builtin', engine: settings.engine }
    : { kind: 'ai', profileId: settings.profileId };
}

/** Dispatches one logical page batch without allowing implicit engine fallback. */
export async function translateRuntimeBatch(
  settings: TranslationRuntimeConfig,
  segments: TranslationSegment[],
  builtinTranslator: BuiltinTranslator,
  signal?: AbortSignal,
  options: TranslationRequestOptions = {},
  fetcher: typeof fetch = fetch,
): Promise<TranslationBatchResult> {
  if (settings.kind === 'ai')
    return translateBatch(settings, segments, fetcher, signal, {
      ...options,
      maxRetries: settings.translationRetryCount,
    });
  if (segments.length === 0) return { translations: {}, failures: {} };
  if (segments.length !== 1)
    throw new LocalizedError(message('免费翻译通道每次只能处理一个文本分片'));
  const segment = segments[0];
  const maxRetries = options.maxRetries ?? settings.translationRetryCount;
  const sleep = options.sleep ?? sleepWithSignal;
  for (let attempt = 0; ; attempt += 1) {
    try {
      signal?.throwIfAborted();
      const execute = async (attemptSignal = signal) =>
        builtinTranslator.translate(
          {
            engine: settings.engine,
            targetLanguageCode: settings.targetLanguageCode,
            text: segment.text,
          },
          attemptSignal,
          { onRateLimit: options.onRateLimit },
        );
      const translated = await (options.scheduleAttempt
        ? options
            .scheduleAttempt(async (attemptSignal) => ({
              [segment.requestId]: await execute(attemptSignal),
            }))
            .then((result) => result[segment.requestId])
        : execute());
      const translations = { [segment.requestId]: translated };
      options.onTranslations?.(translations);
      return { translations, failures: {} };
    } catch (error) {
      if (signal?.aborted) throw abortError(signal);
      if (attempt >= maxRetries) throw new LocalizedError(toUiMessage(error));
      await sleep(options.baseRetryDelayMs ?? 400, signal);
    }
  }
}

/** Full-document semantics remain an AI-only single request. */
export function translateRuntimeFullDocument(
  settings: TranslationRuntimeConfig,
  units: TranslationUnit[],
  _builtinTranslator: BuiltinTranslator,
  signal?: AbortSignal,
  options: Pick<TranslationRequestOptions, 'scheduleAttempt' | 'onRateLimit'> = {},
  fetcher: typeof fetch = fetch,
): Promise<Record<string, string>> {
  if (settings.kind !== 'ai')
    return Promise.reject(new LocalizedError(message('全文上下文翻译仅支持 AI 配置')));
  return translateFullDocument(settings, units, fetcher, signal, {
    ...options,
    timeoutMs: settings.fullDocumentTimeoutMinutes * 60_000,
  });
}

function sleepWithSignal(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const handleAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal!));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', handleAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener('abort', handleAbort, { once: true });
  });
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new LocalizedError(message('API 请求已取消'));
}
