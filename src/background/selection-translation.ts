import { message, LocalizedError } from '../shared/i18n';
import { configuredProviderOptions } from '../shared/providers';
import { translateBatch } from '../shared/translation-client';
import type { SelectionTranslationResult } from '../shared/messages';
import {
  getActiveProfile,
  validateTranslationProfile,
  type TranslatorSettings,
} from '../shared/settings';
import { AbortableRequestRegistry } from './request-registry';
import { ProviderRequestQueue } from './provider-request-queue';

interface SelectionIdentity {
  tabId: number;
  frameId: number;
  documentId: string;
}
type FrameReader = (details: {
  tabId: number;
  frameId: number;
}) => Promise<{ documentId: string } | null>;

/** Independent short-lived requests share provider admission, never page-translation sessions. */
export class SelectionTranslationService {
  private readonly requests = new AbortableRequestRegistry(0);
  private readonly identities = new Map<string, SelectionIdentity>();

  constructor(
    private readonly readSettings: () => Promise<TranslatorSettings>,
    private readonly getFrame: FrameReader,
    private readonly queue = new ProviderRequestQueue(),
  ) {}

  async translate(
    sender: chrome.runtime.MessageSender,
    requestId: string,
    text: string,
  ): Promise<SelectionTranslationResult> {
    const identity = getIdentity(sender);
    const key = requestKey(identity, requestId);
    if (typeof text !== 'string' || !text.trim())
      throw new LocalizedError(message('请选择需要翻译的文字'));
    if (this.identities.has(key)) throw new LocalizedError(message('划选翻译请求重复'));
    // Register before any storage/document await: close and navigation must cancel preflight too.
    this.identities.set(key, identity);
    try {
      return await this.requests.run(key, async (signal) => {
        const settings = await this.readSettings();
        signal.throwIfAborted();
        const profile = getActiveProfile(settings);
        if (
          !profile ||
          Object.keys(validateTranslationProfile(profile)).length ||
          !settings.targetLanguage.trim()
        ) {
          throw new LocalizedError(message('请先在扩展设置页完成 API 配置，再重试'));
        }
        const assertCurrent = async () => {
          const frame = await this.getFrame({ tabId: identity.tabId, frameId: identity.frameId });
          signal.throwIfAborted();
          if (frame?.documentId !== identity.documentId)
            throw new LocalizedError(message('当前网页已变化，请重新划选翻译'));
        };
        await assertCurrent();
        const config = {
          ...profile,
          ...configuredProviderOptions(profile),
          targetLanguage: settings.targetLanguage,
        };
        const result = await translateBatch(
          config,
          [{ requestId: 'selection', unitId: 'selection', partIndex: 0, text }],
          fetch,
          signal,
          {
            maxRetries: settings.translationRetryCount,
            scheduleAttempt: (attempt) =>
              this.queue.run(
                config.apiUrl,
                'visible',
                signal,
                20_000,
                async (attemptSignal) => {
                  await assertCurrent();
                  attemptSignal.throwIfAborted();
                  return attempt(attemptSignal);
                },
                key,
              ),
            onRateLimit: (delay) => this.queue.defer(config.apiUrl, delay),
          },
        );
        await assertCurrent();
        const translated = result.translations.selection;
        if (!translated)
          throw new LocalizedError(result.failures.selection ?? message('AI 未返回译文，请重试'));
        return { text: translated, targetLanguage: settings.targetLanguage };
      });
    } finally {
      this.identities.delete(key);
    }
  }

  cancel(sender: chrome.runtime.MessageSender, requestId: string): void {
    this.requests.cancel(requestKey(getIdentity(sender), requestId));
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
function getIdentity(sender: chrome.runtime.MessageSender): SelectionIdentity {
  if (
    sender.tab?.id === undefined ||
    sender.frameId === undefined ||
    !sender.documentId ||
    !sender.url ||
    !/^https?:\/\//u.test(sender.url)
  )
    throw new LocalizedError(message('无法确定划选文字所属网页'));
  return { tabId: sender.tab.id, frameId: sender.frameId, documentId: sender.documentId };
}
function requestKey(identity: SelectionIdentity, requestId: string): string {
  if (typeof requestId !== 'string' || !requestId.trim())
    throw new LocalizedError(message('划选翻译请求 ID 无效'));
  return `${identity.tabId}:${identity.documentId}:selection:${requestId}`;
}
