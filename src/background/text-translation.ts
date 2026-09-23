import { message, LocalizedError } from '../shared/i18n';
import { createTranslationBatches, mergeTranslatedSegments } from '../shared/batching';
import { runWithConcurrency } from '../shared/concurrency';
import type { TextTranslationResult } from '../shared/messages';
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
} from './translation-engine';

interface TextRequestIdentity {
  tabId: number;
  frameId: number;
  documentId: string;
}
type TextTranslationScope = 'selection' | 'quick';
type TextTranslationContext = { scope: 'selection' } | { scope: 'quick'; targetLanguage: string };
type FrameReader = (details: {
  tabId: number;
  frameId: number;
}) => Promise<{ documentId: string } | null>;

/** Independent short-lived requests share provider admission, never page-translation sessions. */
export class TextTranslationService {
  private readonly requests = new AbortableRequestRegistry(0);
  private readonly identities = new Map<string, TextRequestIdentity>();

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

  private async translate(
    sender: chrome.runtime.MessageSender,
    requestId: string,
    text: string,
    requestedTranslator: ActiveTranslator,
    context: TextTranslationContext,
  ): Promise<TextTranslationResult> {
    const identity = getIdentity(sender);
    const key = requestKey(identity, requestId, context.scope);
    if (typeof text !== 'string' || !text.trim())
      throw new LocalizedError(message('请选择需要翻译的文字'));
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
        // One failed shard owns the whole text request and immediately retires its siblings.
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
          getTranslationMaxConcurrency(config, settings.translationConcurrency),
          async (segments, index) => {
            try {
              return await translateRuntimeBatch(config, segments, this.builtinTranslator, signal, {
                maxRetries: settings.translationRetryCount,
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
              });
            } catch (error) {
              if (!operation.signal.aborted) operation.abort(error);
              throw error;
            }
          },
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
      });
    } finally {
      this.identities.delete(key);
    }
  }

  cancel(
    sender: chrome.runtime.MessageSender,
    requestId: string,
    scope: TextTranslationScope,
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
function getIdentity(sender: chrome.runtime.MessageSender): TextRequestIdentity {
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
  identity: TextRequestIdentity,
  requestId: string,
  scope: TextTranslationScope,
): string {
  if (typeof requestId !== 'string' || !requestId.trim())
    throw new LocalizedError(message('文本翻译请求 ID 无效'));
  return `${identity.tabId}:${identity.documentId}:${scope}:${requestId}`;
}
