import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

import { normalizeEndpoint, resolveProviderOptions, type ModelOptions } from '../shared/providers';

const CACHE_DATABASE_NAME = 'just-translate-cache';
const CACHE_DATABASE_VERSION = 1;
const CACHE_STORE_NAME = 'translations';
const CACHE_POLICY_VERSION = 'translation-cache-v1:prompt-v2';

export const CACHE_TTL_MS = 72 * 60 * 60 * 1_000;

export interface TranslationCacheContext extends ModelOptions {
  origin: string;
  apiUrl: string;
  model: string;
  thinkingEnabled: boolean;
  targetLanguage: string;
  translationPrompt: string;
}

export interface TranslationCacheLookupCandidate {
  id: string;
  sourceText: string;
}

export interface TranslationCacheEntry {
  sourceText: string;
  translatedText: string;
}

interface StoredTranslation {
  key: string;
  translatedText: string;
  createdAt: number;
  expiresAt: number;
}

interface TranslationCacheDatabase extends DBSchema {
  translations: {
    key: string;
    value: StoredTranslation;
    indexes: { expiresAt: number };
  };
}

export interface TranslationCacheOptions {
  databaseName?: string;
  now?: () => number;
}

/** Persistent translation cache. Source text is hashed before it reaches IndexedDB. */
export class TranslationCache {
  private readonly databaseName: string;
  private readonly now: () => number;
  private databasePromise: Promise<IDBPDatabase<TranslationCacheDatabase>> | undefined;
  private openedDatabase: IDBPDatabase<TranslationCacheDatabase> | undefined;

  constructor(options: TranslationCacheOptions = {}) {
    this.databaseName = options.databaseName ?? CACHE_DATABASE_NAME;
    this.now = options.now ?? Date.now;
  }

  async lookup(
    context: TranslationCacheContext,
    candidates: readonly TranslationCacheLookupCandidate[],
  ): Promise<Record<string, string>> {
    const keyedCandidates = await Promise.all(
      candidates.map(async (candidate) => ({
        ...candidate,
        key: await createTranslationCacheKey(context, candidate.sourceText),
      })),
    );
    if (keyedCandidates.length === 0) return {};

    const database = await this.getDatabase();
    const transaction = database.transaction(CACHE_STORE_NAME, 'readonly');
    const result: Record<string, string> = {};
    const now = this.now();
    // Issue every IndexedDB read in the same task so a long page does not pay one
    // storage round trip per candidate before its first network request can start.
    const storedEntries = await Promise.all(
      keyedCandidates.map((candidate) => transaction.store.get(candidate.key)),
    );
    const expiredKeys: string[] = [];
    for (const [index, candidate] of keyedCandidates.entries()) {
      const stored = storedEntries[index];
      if (!stored) continue;
      if (stored.expiresAt <= now || !stored.translatedText.trim()) {
        expiredKeys.push(candidate.key);
        continue;
      }
      result[candidate.id] = stored.translatedText;
    }
    await transaction.done;
    // Re-check under a separate write transaction: another tab may have refreshed
    // the same key after this read. Maintenance never blocks returning cache hits.
    if (expiredKeys.length) {
      void this.deleteUnusable(database, expiredKeys).catch((error: unknown) => {
        console.error('翻译缓存过期记录清理失败', error);
      });
    }
    return result;
  }

  async putMany(
    context: TranslationCacheContext,
    entries: readonly TranslationCacheEntry[],
  ): Promise<void> {
    if (entries.length === 0) return;
    const createdAt = this.now();
    const records = await Promise.all(
      entries
        .filter((entry) => entry.translatedText.trim())
        .map(async (entry): Promise<StoredTranslation> => ({
          key: await createTranslationCacheKey(context, entry.sourceText),
          translatedText: entry.translatedText,
          createdAt,
          expiresAt: createdAt + CACHE_TTL_MS,
        })),
    );
    if (records.length === 0) return;
    const database = await this.getDatabase();
    const transaction = database.transaction(CACHE_STORE_NAME, 'readwrite');
    await Promise.all(records.map((record) => transaction.store.put(record)));
    await transaction.done;
  }

  async deleteExpired(): Promise<number> {
    const database = await this.getDatabase();
    const transaction = database.transaction(CACHE_STORE_NAME, 'readwrite');
    const index = transaction.store.index('expiresAt');
    let cursor = await index.openCursor(IDBKeyRange.upperBound(this.now()));
    let deleted = 0;
    while (cursor) {
      await cursor.delete();
      deleted += 1;
      cursor = await cursor.continue();
    }
    await transaction.done;
    return deleted;
  }

  close(): void {
    this.openedDatabase?.close();
    this.openedDatabase = undefined;
    this.databasePromise = undefined;
  }

  private async deleteUnusable(
    database: IDBPDatabase<TranslationCacheDatabase>,
    keys: string[],
  ): Promise<void> {
    const transaction = database.transaction(CACHE_STORE_NAME, 'readwrite');
    const records = await Promise.all(keys.map((key) => transaction.store.get(key)));
    await Promise.all(
      records
        .filter(
          (record): record is StoredTranslation =>
            !!record && (record.expiresAt <= this.now() || !record.translatedText.trim()),
        )
        .map((record) => transaction.store.delete(record.key)),
    );
    await transaction.done;
  }

  private getDatabase(): Promise<IDBPDatabase<TranslationCacheDatabase>> {
    this.databasePromise ??= openDB<TranslationCacheDatabase>(
      this.databaseName,
      CACHE_DATABASE_VERSION,
      {
        upgrade(database) {
          const store = database.createObjectStore(CACHE_STORE_NAME, { keyPath: 'key' });
          store.createIndex('expiresAt', 'expiresAt');
        },
      },
    )
      .then((database) => {
        this.openedDatabase = database;
        return database;
      })
      .catch((error: unknown) => {
        this.databasePromise = undefined;
        throw error;
      });
    return this.databasePromise;
  }
}

/** Builds an opaque, configuration-scoped key and never persists the API key or source text. */
export async function createTranslationCacheKey(
  context: TranslationCacheContext,
  sourceText: string,
): Promise<string> {
  const canonical = [
    CACHE_POLICY_VERSION,
    new URL(context.origin).origin,
    context.provider,
    context.protocol,
    normalizeEndpoint(context.apiUrl, context.protocol!),
    context.model.trim(),
    // Reasoning changes generated output and must also change the session configuration fingerprint.
    JSON.stringify(resolveProviderOptions(context).parameters),
    String(resolveProviderOptions(context).maxOutputTokens),
    context.targetLanguage.trim(),
    context.translationPrompt.normalize('NFC').trim(),
    normalizeSourceText(sourceText),
  ].join('\u0000');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function normalizeSourceText(text: string): string {
  return text.normalize('NFC').replace(/\s+/gu, ' ').trim();
}
