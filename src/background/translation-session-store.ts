import { message, LocalizedError } from '../shared/i18n';
import { parseConfiguredProviderOptions } from '../shared/providers';
import type { TranslationMode } from '../shared/messages';
import { isValidTranslationRetryCount, isValidFullDocumentTimeout } from '../shared/settings';
import { isBuiltinTranslatorId, resolveBuiltinTargetLanguage } from '../shared/translation-engines';
import type { TranslationRuntimeConfig } from './translation-engine';

const SESSION_STORAGE_PREFIX = 'translation-session:';

export interface TranslationSessionContext extends TranslationSessionIdentity {
  mode: TranslationMode;
  settings: TranslationRuntimeConfig;
}

export interface TranslationSessionIdentity {
  tabId: number;
  documentId: string;
  sessionId: string;
  origin: string;
}

export interface TranslationSessionStorage {
  get(keys: string | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

/**
 * Keeps one immutable provider snapshot per page translation session.
 * chrome.storage.session survives MV3 worker suspension without exposing API keys to webpages.
 */
export class TranslationSessionStore {
  constructor(private readonly storage: TranslationSessionStorage) {}

  async create(context: TranslationSessionContext): Promise<void> {
    assertIdentity(context);
    if (context.mode === 'full-document' && context.settings.kind !== 'ai')
      throw new LocalizedError(message('全文上下文翻译仅支持 AI 配置'));
    await this.storage.set({ [getStorageKey(context.tabId, context.sessionId)]: context });
  }

  async read(identity: TranslationSessionIdentity): Promise<TranslationSessionContext> {
    assertIdentity(identity);
    const key = getStorageKey(identity.tabId, identity.sessionId);
    const stored = (await this.storage.get(key))[key];
    const context = parseStoredContext(stored);
    if (!context) throw new LocalizedError(message('翻译会话不存在或已失效'));
    if (context.tabId !== identity.tabId || context.sessionId !== identity.sessionId) {
      throw new LocalizedError(message('翻译会话不存在或已失效'));
    }
    if (context.origin !== identity.origin || context.documentId !== identity.documentId) {
      throw new LocalizedError(message('当前网页已变化，翻译会话失效'));
    }
    return context;
  }

  async delete(tabId: number, sessionId: string): Promise<void> {
    await this.storage.remove(getStorageKey(tabId, sessionId));
  }

  async deleteForTab(tabId: number): Promise<void> {
    const prefix = getTabStoragePrefix(tabId);
    const stored = await this.storage.get(null);
    const keys = Object.keys(stored).filter((key) => key.startsWith(prefix));
    if (keys.length > 0) await this.storage.remove(keys);
  }

  /** A navigation can race the next page's BEGIN: retain sessions of the committed document. */
  async deleteOtherDocuments(tabId: number, documentId: string): Promise<void> {
    const prefix = getTabStoragePrefix(tabId);
    const stored = await this.storage.get(null);
    const keys = Object.entries(stored)
      .filter(
        ([key, value]) =>
          key.startsWith(prefix) && parseStoredContext(value)?.documentId !== documentId,
      )
      .map(([key]) => key);
    if (keys.length > 0) await this.storage.remove(keys);
  }
}

function getStorageKey(tabId: number, sessionId: string): string {
  return `${getTabStoragePrefix(tabId)}${sessionId}`;
}

function getTabStoragePrefix(tabId: number): string {
  return `${SESSION_STORAGE_PREFIX}${tabId}:`;
}

function assertIdentity(identity: TranslationSessionIdentity): void {
  if (!Number.isInteger(identity.tabId) || identity.tabId < 0)
    throw new LocalizedError(message('翻译标签页无效'));
  if (!identity.sessionId.trim()) throw new LocalizedError(message('翻译会话 ID 无效'));
  if (!identity.documentId.trim()) throw new LocalizedError(message('翻译网页文档无效'));
  if (!identity.origin.trim()) throw new LocalizedError(message('翻译网页来源无效'));
}

function parseStoredContext(value: unknown): TranslationSessionContext | undefined {
  if (!isRecord(value) || !isRecord(value.settings)) return undefined;
  const { tabId, documentId, sessionId, origin, settings, mode } = value;
  const identityValid =
    (mode === 'segmented' || mode === 'full-document') &&
    typeof tabId === 'number' &&
    Number.isInteger(tabId) &&
    typeof sessionId === 'string' &&
    typeof documentId === 'string' &&
    typeof origin === 'string';
  if (!identityValid || !isValidTranslationRetryCount(settings.translationRetryCount))
    return undefined;
  if (settings.kind === 'builtin') {
    const engine = settings.engine;
    const translationRetryCount = settings.translationRetryCount;
    const targetLanguage = settings.targetLanguage;
    const targetLanguageCode = settings.targetLanguageCode;
    if (
      mode === 'full-document' ||
      !isBuiltinTranslatorId(engine) ||
      !isValidTranslationRetryCount(translationRetryCount) ||
      typeof targetLanguage !== 'string' ||
      typeof targetLanguageCode !== 'string' ||
      resolveBuiltinTargetLanguage(engine, targetLanguage) !== targetLanguageCode
    )
      return undefined;
    return {
      mode,
      tabId,
      documentId,
      sessionId,
      origin,
      settings: {
        kind: 'builtin',
        engine,
        targetLanguage,
        targetLanguageCode,
        translationRetryCount,
      },
    };
  }
  if (settings.kind !== 'ai') return undefined;
  const providerOptions = parseConfiguredProviderOptions(settings);
  const translationRetryCount = settings.translationRetryCount;
  const thinkingEnabled = settings.thinkingEnabled;
  const fullDocumentTimeoutMinutes = settings.fullDocumentTimeoutMinutes;
  if (
    !providerOptions ||
    !isValidFullDocumentTimeout(fullDocumentTimeoutMinutes) ||
    typeof thinkingEnabled !== 'boolean' ||
    !hasStringFields(settings, [
      'profileId',
      'profileName',
      'apiUrl',
      'apiKey',
      'model',
      'targetLanguage',
      'translationPrompt',
    ])
  ) {
    return undefined;
  }
  return {
    mode,
    tabId,
    documentId,
    sessionId,
    origin,
    settings: {
      kind: 'ai',
      fullDocumentTimeoutMinutes,
      profileId: settings.profileId,
      profileName: settings.profileName,
      ...providerOptions,
      translationRetryCount,
      thinkingEnabled,
      apiUrl: settings.apiUrl,
      apiKey: settings.apiKey,
      model: settings.model,
      targetLanguage: settings.targetLanguage,
      translationPrompt: settings.translationPrompt,
    },
  };
}

function hasStringFields<T extends string>(
  value: Record<string, unknown>,
  fields: readonly T[],
): value is Record<T, string> {
  return fields.every((field) => typeof value[field] === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
