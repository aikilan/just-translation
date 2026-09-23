import { message, LocalizedError } from '../shared/i18n';
import { createTranslationBatches, mergeTranslatedSegments } from '../shared/batching';
import { runWithConcurrency } from '../shared/concurrency';
import type { TextTranslationResult, ImageTranslationResult } from '../shared/messages';
import { validateImageInput, type ImageInput } from '../shared/image-input';
import { translateImage } from '../shared/image-translation-client';
import type { TranslatorSettings } from '../shared/settings';
import { builtinTranslatorName, type ActiveTranslator } from '../shared/translation-engines';
import { AbortableRequestRegistry } from './request-registry';
import { ProviderRequestQueue } from './provider-request-queue';
import { BuiltinTranslationClient } from './builtin-translation-client';
import {
  getTranslationBatchProfiles,
  getTranslationMaxConcurrency,
  getTranslationQueueUrl,
  resolveTranslationRuntimeConfig,
  translateRuntimeBatch,
  type TranslationRuntimeConfig,
} from './translation-engine';

interface TranslationTaskIdentity {
  tabId: number;
  frameId: number;
  documentId: string;
}
type TranslationTaskScope = 'selection' | 'quick';
type TranslationTaskContext = { scope: 'selection' } | { scope: 'quick'; targetLanguage: string };
type FrameReader = (details: {
  tabId: number;
  frameId: number;
}) => Promise<{ documentId: string } | null>;

/** Independent short-lived requests share provider admission, never page-translation sessions. */
export class TranslationTaskService {
  private readonly requests = new AbortableRequestRegistry(0);
  private readonly identities = new Map<string, TranslationTaskIdentity>();

  constructor(
    private readonly readSettings: () => Promise<TranslatorSettings>,
    private readonly getFrame: FrameReader,
    private readonly aiQueue = new ProviderRequestQueue(),
    private readonly builtinQueue = new ProviderRequestQueue({ concurrency: 2, intervalCap: 2 }),
    private readonly builtinTranslator = new BuiltinTranslationClient(),
  ) {}

  /** Selection commands remain bound to the globally selected translator. */
  translateSelection(
    sender: chrome.runtime.MessageSender,
    requestId: string,
    text: string,
    requestedTranslator: ActiveTranslator,
  ): Promise<TextTranslationResult> {
    return this.translate(sender, requestId, text, requestedTranslator, { scope: 'selection' });
  }

  /** Quick translation resolves credentials from trusted storage while keeping choices local. */
  translateQuick(
    sender: chrome.runtime.MessageSender,
    requestId: string,
    text: string,
    requestedTranslator: ActiveTranslator,
    targetLanguage: string,
  ): Promise<TextTranslationResult> {
    return this.translate(sender, requestId, text, requestedTranslator, {
      scope: 'quick',
      targetLanguage,
    });
  }

  /** Image tasks share quick-task cancellation and provider admission with text tasks. */
  translateQuickImage(
    sender: chrome.runtime.MessageSender,
    requestId: string,
    text: string,
    image: ImageInput,
    requestedTranslator: ActiveTranslator,
    targetLanguage: string,
  ): Promise<ImageTranslationResult> {
    if (typeof text !== 'string')
      return Promise.reject(new LocalizedError(message('图片翻译输入无效')));
    if (requestedTranslator?.kind === 'builtin')
      return Promise.reject(
        new LocalizedError(message('当前模型不支持图片，请移除图片或更换模型')),
      );
    return this.runTask(
      sender,
      requestId,
      requestedTranslator,
      { scope: 'quick', targetLanguage },
      async (config, signal, assertCurrent, key) => {
        if (config.kind !== 'ai' || !config.supportsImageInput)
          throw new LocalizedError(message('当前模型不支持图片，请移除图片或更换模型'));
        const validated = await validateImageInput(image);
        signal.throwIfAborted();
        await assertCurrent();
        const result = await translateImage(config, text, validated, fetch, signal, {
          maxRetries: config.translationRetryCount,
          scheduleAttempt: (attempt) =>
            this.aiQueue.run(
              config.apiUrl,
              'visible',
              signal,
              60_000,
              async (attemptSignal) => {
                await assertCurrent();
                attemptSignal.throwIfAborted();
                return attempt(attemptSignal);
              },
              key,
            ),
          onRateLimit: (delay) => this.aiQueue.defer(config.apiUrl, delay),
        });
        await assertCurrent();
        return {
          ...result,
          targetLanguage: config.targetLanguage,
          translatorName: config.profileName,
        };
      },
    );
  }

  private async translate(
    sender: chrome.runtime.MessageSender,
    requestId: string,
    text: string,
    requestedTranslator: ActiveTranslator,
    context: TranslationTaskContext,
  ): Promise<TextTranslationResult> {
    if (typeof text !== 'string' || !text.trim())
      throw new LocalizedError(message('请选择需要翻译的文字'));
    return this.runTask(
      sender,
      requestId,
      requestedTranslator,
      context,
      async (config, signal, assertCurrent, key, concurrency) => {
        const prepared =
          config.kind === 'builtin'
            ? createTranslationBatches(
                [{ id: context.scope, text }],
                getTranslationBatchProfiles(config).visible,
              )
            : {
                segments: [{ requestId: context.scope, unitId: context.scope, partIndex: 0, text }],
                batches: [
                  [{ requestId: context.scope, unitId: context.scope, partIndex: 0, text }],
                ],
              };
        const queue = config.kind === 'builtin' ? this.builtinQueue : this.aiQueue;
        const queueUrl = getTranslationQueueUrl(config);
        const results = await runWithConcurrency(
          prepared.batches,
          getTranslationMaxConcurrency(config, concurrency),
          async (segments, index) =>
            translateRuntimeBatch(config, segments, this.builtinTranslator, signal, {
              maxRetries: config.translationRetryCount,
              scheduleAttempt: (attempt) =>
                queue.run(
                  queueUrl,
                  'visible',
                  signal,
                  20_000,
                  async (attemptSignal) => {
                    await assertCurrent();
                    attemptSignal.throwIfAborted();
                    return attempt(attemptSignal);
                  },
                  `${key}:${index}`,
                ),
              onRateLimit: (delay) => queue.defer(queueUrl, delay),
            }),
        );
        await assertCurrent();
        const translations: Record<string, string> = {};
        for (const result of results) Object.assign(translations, result.translations);
        const failure = results.flatMap((result) => Object.values(result.failures))[0];
        if (failure) throw new LocalizedError(failure);
        const translated = mergeTranslatedSegments(prepared.segments, translations).get(
          context.scope,
        );
        if (!translated) throw new LocalizedError(message('翻译通道未返回译文，请重试'));
        return {
          text: translated,
          targetLanguage: config.targetLanguage,
          translatorName:
            config.kind === 'builtin' ? builtinTranslatorName(config.engine) : config.profileName,
        };
      },
    );
  }

  /** Register ownership before any await; one failure/close retires this task and all its shards. */
  private async runTask<T>(
    sender: chrome.runtime.MessageSender,
    requestId: string,
    requestedTranslator: ActiveTranslator,
    context: TranslationTaskContext,
    execute: (
      config: TranslationRuntimeConfig,
      signal: AbortSignal,
      assertCurrent: () => Promise<void>,
      key: string,
      concurrency: number,
    ) => Promise<T>,
  ): Promise<T> {
    const identity = getIdentity(sender);
    const key = requestKey(identity, requestId, context.scope);
    if (this.identities.has(key)) throw new LocalizedError(message('文本翻译请求重复'));
    if (
      context.scope === 'quick' &&
      (typeof context.targetLanguage !== 'string' || !context.targetLanguage.trim())
    )
      throw new LocalizedError(message('请填写目标语言'));
    // Register before any storage/document await: close and navigation must cancel preflight too.
    this.identities.set(key, identity);
    try {
      return await this.requests.run(key, async (requestSignal) => {
        const operation = new AbortController();
        const signal = AbortSignal.any([requestSignal, operation.signal]);
        const settings = await this.readSettings();
        signal.throwIfAborted();
        const config = resolveTranslationRuntimeConfig(
          context.scope === 'quick'
            ? {
                ...settings,
                activeTranslator: requestedTranslator,
                targetLanguage: context.targetLanguage.trim(),
              }
            : settings,
          requestedTranslator,
        );
        const assertCurrent = async () => {
          const frame = await this.getFrame({ tabId: identity.tabId, frameId: identity.frameId });
          signal.throwIfAborted();
          if (frame?.documentId !== identity.documentId)
            throw new LocalizedError(message('当前网页已变化，请重新打开翻译'));
        };
        await assertCurrent();
        try {
          return await execute(config, signal, assertCurrent, key, settings.translationConcurrency);
        } finally {
          operation.abort();
        }
      });
    } finally {
      this.identities.delete(key);
    }
  }

  cancel(
    sender: chrome.runtime.MessageSender,
    requestId: string,
    scope: TranslationTaskScope,
  ): void {
    this.requests.cancel(requestKey(getIdentity(sender), requestId, scope));
  }

  /** Child navigation retires only that frame; top navigation retires the previous page tree. */
  navigate(tabId: number, frameId: number, documentId: string): void {
    for (const [key, identity] of this.identities) {
      if (
        identity.tabId === tabId &&
        (frameId === 0 || identity.frameId === frameId) &&
        identity.documentId !== documentId
      )
        this.requests.cancel(key);
    }
  }

  removeTab(tabId: number): void {
    this.requests.cancelForTab(tabId);
  }
}

/** IDs and URLs are browser-owned sender metadata, never values supplied by webpage messages. */
function getIdentity(sender: chrome.runtime.MessageSender): TranslationTaskIdentity {
  if (
    sender.tab?.id === undefined ||
    sender.frameId === undefined ||
    !sender.documentId ||
    !sender.url ||
    !/^https?:\/\//u.test(sender.url)
  )
    throw new LocalizedError(message('无法确定文本所属网页'));
  return { tabId: sender.tab.id, frameId: sender.frameId, documentId: sender.documentId };
}
function requestKey(
  identity: TranslationTaskIdentity,
  requestId: string,
  scope: TranslationTaskScope,
): string {
  if (typeof requestId !== 'string' || !requestId.trim())
    throw new LocalizedError(message('文本翻译请求 ID 无效'));
  return `${identity.tabId}:${identity.documentId}:${scope}:${requestId}`;
}
