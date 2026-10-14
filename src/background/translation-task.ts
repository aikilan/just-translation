import { message, LocalizedError, toUiMessage, type UiMessage } from '../shared/i18n';
import {
  createTranslationBatches,
  type TranslationSegment,
  type TranslationUnit,
} from '../shared/batching';
import { runWithConcurrency } from '../shared/concurrency';
import type {
  ImageTranslationResult,
  QuickTranslationProgress,
  SliceTranslationResult,
  TextTranslationResult,
} from '../shared/messages';
import { joinSlices, sliceText, TEXT_SLICE_MAX_CHARACTERS } from '../shared/text-slices';
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
  getTranslationRequestTimeout,
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
/** Delivers progress to the requesting document only, never to the tab's next page. */
type ProgressNotifier = (
  target: TranslationTaskIdentity,
  event: QuickTranslationProgress,
) => Promise<unknown>;
type Execute<T> = (
  config: TranslationRuntimeConfig,
  signal: AbortSignal,
  assertCurrent: () => Promise<void>,
  key: string,
  concurrency: number,
  identity: TranslationTaskIdentity,
) => Promise<T>;

interface SliceOutcome {
  translations: Record<string, string>;
  failures: Record<string, UiMessage>;
}

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
    private readonly notify: ProgressNotifier = (target, event) =>
      chrome.tabs.sendMessage(target.tabId, event, { documentId: target.documentId }),
  ) {}

  /** Selection commands remain bound to the globally selected translator. */
  translateSelection(
    sender: chrome.runtime.MessageSender,
    requestId: string,
    text: string,
    requestedTranslator: ActiveTranslator,
  ): Promise<TextTranslationResult> {
    if (typeof text !== 'string' || !text.trim())
      return Promise.reject(new LocalizedError(message('请选择需要翻译的文字')));
    const sliced = sliceText(text);
    return this.runTask(
      sender,
      requestId,
      requestedTranslator,
      { scope: 'selection' },
      async (config, signal, assertCurrent, key, concurrency) => {
        // The popover shows one text, so the first failed slice fails it and cancels the rest.
        const outcome = await this.translateSlices(
          config,
          sliced.slices,
          signal,
          assertCurrent,
          key,
          concurrency,
          { stopOnFailure: true },
        );
        await assertCurrent();
        const failure = Object.values(outcome.failures)[0];
        if (failure) throw new LocalizedError(failure);
        return {
          text: joinSlices(sliced, (slice) => outcome.translations[slice.id]),
          targetLanguage: config.targetLanguage,
          translatorName: translatorName(config),
        };
      },
    );
  }

  /**
   * Quick translation sends independent slices: finished slices are reported as they arrive and
   * a failed slice never discards the others. Choices stay local to this request.
   */
  translateQuick(
    sender: chrome.runtime.MessageSender,
    requestId: string,
    slices: unknown,
    requestedTranslator: ActiveTranslator,
    targetLanguage: string,
  ): Promise<SliceTranslationResult> {
    const units = parseSlices(slices);
    if (!units) return Promise.reject(new LocalizedError(message('快捷翻译输入无效')));
    return this.runTask(
      sender,
      requestId,
      requestedTranslator,
      { scope: 'quick', targetLanguage },
      async (config, signal, assertCurrent, key, concurrency, identity) => {
        const outcome = await this.translateSlices(
          config,
          units,
          signal,
          assertCurrent,
          key,
          concurrency,
          {
            onSlices: (translations) => {
              // Progress is best effort; the final response always carries every result.
              void Promise.resolve()
                .then(() =>
                  this.notify(identity, {
                    type: 'QUICK_TRANSLATION_PROGRESS',
                    requestId,
                    translations,
                  }),
                )
                .catch(() => undefined);
            },
          },
        );
        await assertCurrent();
        return {
          ...outcome,
          targetLanguage: config.targetLanguage,
          translatorName: translatorName(config),
        };
      },
    );
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

  /**
   * Batches slices with the engine's visible-content limits and runs them concurrently. Each
   * batch retries on its own; a batch that still fails marks only its own slices as failed.
   */
  private async translateSlices(
    config: TranslationRuntimeConfig,
    units: readonly TranslationUnit[],
    signal: AbortSignal,
    assertCurrent: () => Promise<void>,
    key: string,
    concurrency: number,
    {
      onSlices,
      stopOnFailure = false,
    }: {
      onSlices?: (translations: Record<string, string>) => void;
      stopOnFailure?: boolean;
    } = {},
  ): Promise<SliceOutcome> {
    const prepared = createTranslationBatches(
      [...units],
      getTranslationBatchProfiles(config).visible,
    );
    const parts = new Map<string, TranslationSegment[]>();
    const unitOf = new Map<string, string>();
    for (const segment of prepared.segments) {
      parts.set(segment.unitId, [...(parts.get(segment.unitId) ?? []), segment]);
      unitOf.set(segment.requestId, segment.unitId);
    }
    const received: Record<string, string> = {};
    const outcome: SliceOutcome = { translations: {}, failures: {} };
    const accept = (translations: Record<string, string>) => {
      Object.assign(received, translations);
      const finished: Record<string, string> = {};
      for (const requestId of Object.keys(translations)) {
        const unitId = unitOf.get(requestId);
        if (!unitId || unitId in outcome.translations) continue;
        const segments = parts.get(unitId)!;
        if (!segments.every((segment) => segment.requestId in received)) continue;
        const text = segments.map((segment) => received[segment.requestId]).join('');
        outcome.translations[unitId] = text;
        finished[unitId] = text;
      }
      if (Object.keys(finished).length > 0) onSlices?.(finished);
    };
    const queue = config.kind === 'builtin' ? this.builtinQueue : this.aiQueue;
    const queueUrl = getTranslationQueueUrl(config);
    await runWithConcurrency(
      prepared.batches,
      getTranslationMaxConcurrency(config, concurrency),
      async (segments, index) => {
        try {
          const result = await translateRuntimeBatch(
            config,
            segments,
            this.builtinTranslator,
            signal,
            {
              maxRetries: config.translationRetryCount,
              onTranslations: accept,
              scheduleAttempt: (attempt) =>
                queue.run(
                  queueUrl,
                  'visible',
                  signal,
                  getTranslationRequestTimeout(config, 'visible'),
                  async (attemptSignal) => {
                    await assertCurrent();
                    attemptSignal.throwIfAborted();
                    return attempt(attemptSignal);
                  },
                  `${key}:${index}`,
                ),
              onRateLimit: (delay) => queue.defer(queueUrl, delay),
            },
          );
          accept(result.translations);
          for (const [requestId, failure] of Object.entries(result.failures)) {
            if (stopOnFailure) throw new LocalizedError(failure);
            const unitId = unitOf.get(requestId);
            if (unitId) outcome.failures[unitId] ??= failure;
          }
        } catch (error) {
          // Cancellation and navigation end the whole request; anything else stays in its batch.
          if (signal.aborted || stopOnFailure) throw error;
          const failure = toUiMessage(error);
          for (const segment of segments) outcome.failures[segment.unitId] ??= failure;
        }
      },
    );
    for (const unitId of Object.keys(outcome.failures)) delete outcome.translations[unitId];
    for (const unit of units)
      if (!(unit.id in outcome.translations) && !(unit.id in outcome.failures))
        outcome.failures[unit.id] = message('翻译通道未返回译文，请重试');
    return outcome;
  }

  /** Register ownership before any await; one failure/close retires this task and all its shards. */
  private async runTask<T>(
    sender: chrome.runtime.MessageSender,
    requestId: string,
    requestedTranslator: ActiveTranslator,
    context: TranslationTaskContext,
    execute: Execute<T>,
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
          return await execute(
            config,
            signal,
            assertCurrent,
            key,
            settings.translationConcurrency,
            identity,
          );
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

function translatorName(config: TranslationRuntimeConfig): string {
  return config.kind === 'builtin' ? builtinTranslatorName(config.engine) : config.profileName;
}

/** Slices come from the content script; accept only the shape sliceText produces. */
function parseSlices(value: unknown): TranslationUnit[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const ids = new Set<string>();
  const units: TranslationUnit[] = [];
  for (const entry of value as unknown[]) {
    if (typeof entry !== 'object' || entry === null) return undefined;
    const { id, text } = entry as Record<string, unknown>;
    if (typeof id !== 'string' || !id || ids.has(id)) return undefined;
    if (typeof text !== 'string' || !text.trim() || text.length > TEXT_SLICE_MAX_CHARACTERS * 2)
      return undefined;
    ids.add(id);
    units.push({ id, text });
  }
  return units;
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
