import 'fake-indexeddb/auto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CACHE_TTL_MS,
  createTranslationCacheKey,
  TranslationCache,
  type TranslationCacheContext,
} from './translation-cache';

const BASE_CONTEXT: TranslationCacheContext = {
  origin: 'https://news.example.com',
  apiUrl: 'https://gateway.example.com/v1',
  model: 'translation-model',
  targetLanguage: 'Simplified Chinese',
  translationPrompt: 'Translate naturally into {{targetLanguage}}.',
};

const databaseNames: string[] = [];

afterEach(async () => {
  await Promise.all(
    databaseNames.splice(0).map(
      (name) =>
        new Promise<void>((resolve, reject) => {
          const request = indexedDB.deleteDatabase(name);
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error ?? new Error(`Failed to delete ${name}`));
          request.onblocked = () => reject(new Error(`Database ${name} is still open`));
        }),
    ),
  );
});

describe('TranslationCache', () => {
  it('uses readonly transactions for lookups and rejects blank cached results', async () => {
    const cache = createCache(() => 1_000);
    await cache.putMany(BASE_CONTEXT, [{ sourceText: 'Valid output', translatedText: '有效译文' }]);
    await cache.putMany(BASE_CONTEXT, [{ sourceText: 'Blank output', translatedText: '  ' }]);
    const transaction = vi.spyOn(IDBDatabase.prototype, 'transaction');
    try {
      expect(await cache.lookup(BASE_CONTEXT, [{ id: 'a', sourceText: 'Blank output' }])).toEqual(
        {},
      );
      expect(transaction.mock.calls[0][1]).toBe('readonly');
    } finally {
      transaction.mockRestore();
      cache.close();
    }
  });

  it('can open the database again after a rejected initial open', async () => {
    const databaseName = `recover-${crypto.randomUUID()}`;
    databaseNames.push(databaseName);
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 2);
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
      request.onerror = () => reject(request.error ?? new Error('Database open failed'));
    });
    const cache = new TranslationCache({ databaseName });
    try {
      await expect(
        cache.lookup(BASE_CONTEXT, [{ id: 'a', sourceText: 'Recover after open error' }]),
      ).rejects.toThrow();
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(databaseName);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error ?? new Error('Database deletion failed'));
      });
      await cache.putMany(BASE_CONTEXT, [
        { sourceText: 'Recover after open error', translatedText: '恢复成功' },
      ]);
      expect(
        await cache.lookup(BASE_CONTEXT, [{ id: 'a', sourceText: 'Recover after open error' }]),
      ).toEqual({ a: '恢复成功' });
    } finally {
      cache.close();
    }
  });

  it('stores and resolves translations without putting source text in the cache key', async () => {
    const cache = createCache(() => 1_000);
    const sourceText = 'A private source paragraph that must only be hashed.';

    await cache.putMany(BASE_CONTEXT, [{ sourceText, translatedText: '私密译文' }]);

    await expect(
      cache.lookup(BASE_CONTEXT, [
        { id: 'candidate-1', sourceText },
        { id: 'candidate-2', sourceText: 'Not cached' },
      ]),
    ).resolves.toEqual({ 'candidate-1': '私密译文' });

    const key = await createTranslationCacheKey(BASE_CONTEXT, sourceText);
    expect(key).toMatch(/^[a-f0-9]{64}$/u);
    expect(key).not.toContain(sourceText);
    cache.close();
  });

  it('isolates entries by origin and translation configuration', async () => {
    const cache = createCache(() => 1_000);
    const sourceText = 'The same sentence appears on several sites.';
    await cache.putMany(BASE_CONTEXT, [{ sourceText, translatedText: '基础译文' }]);

    const variants: TranslationCacheContext[] = [
      { ...BASE_CONTEXT, origin: 'https://other.example.com' },
      { ...BASE_CONTEXT, apiUrl: 'https://other-gateway.example.com/v1' },
      { ...BASE_CONTEXT, model: 'other-model' },
      { ...BASE_CONTEXT, targetLanguage: 'Japanese' },
      { ...BASE_CONTEXT, translationPrompt: 'Use formal legal terminology.' },
    ];

    for (const context of variants) {
      await expect(cache.lookup(context, [{ id: 'candidate', sourceText }])).resolves.toEqual({});
    }
    cache.close();
  });

  it('uses a fixed 72-hour expiry that is not extended by cache hits', async () => {
    let now = 10_000;
    const cache = createCache(() => now);
    const sourceText = 'A translation with a fixed expiry.';
    await cache.putMany(BASE_CONTEXT, [{ sourceText, translatedText: '固定过期译文' }]);

    now += CACHE_TTL_MS - 1;
    await expect(cache.lookup(BASE_CONTEXT, [{ id: 'candidate', sourceText }])).resolves.toEqual({
      candidate: '固定过期译文',
    });

    now += 1;
    await expect(cache.lookup(BASE_CONTEXT, [{ id: 'candidate', sourceText }])).resolves.toEqual(
      {},
    );
    cache.close();
  });

  it('deletes every expired record during scheduled maintenance', async () => {
    let now = 50_000;
    const cache = createCache(() => now);
    await cache.putMany(BASE_CONTEXT, [
      { sourceText: 'Expired source', translatedText: '过期译文' },
    ]);

    now += CACHE_TTL_MS + 1;
    await cache.putMany(BASE_CONTEXT, [{ sourceText: 'Fresh source', translatedText: '新鲜译文' }]);

    await expect(cache.deleteExpired()).resolves.toBe(1);
    await expect(
      cache.lookup(BASE_CONTEXT, [
        { id: 'expired', sourceText: 'Expired source' },
        { id: 'fresh', sourceText: 'Fresh source' },
      ]),
    ).resolves.toEqual({ fresh: '新鲜译文' });
    cache.close();
  });

  it('never deletes a fresh value racing with expired-entry cleanup', async () => {
    let now = 1_000;
    const cache = createCache(() => now);
    const sourceText = 'Concurrent refreshed translation';
    await cache.putMany(BASE_CONTEXT, [{ sourceText, translatedText: '旧值' }]);
    now += CACHE_TTL_MS;
    await Promise.all([
      cache.lookup(BASE_CONTEXT, [{ id: 'a', sourceText }]),
      cache.putMany(BASE_CONTEXT, [{ sourceText, translatedText: '新值' }]),
    ]);
    expect(await cache.lookup(BASE_CONTEXT, [{ id: 'a', sourceText }])).toEqual({ a: '新值' });
    cache.close();
  });
});

function createCache(now: () => number): TranslationCache {
  const databaseName = `just-translate-test-${crypto.randomUUID()}`;
  databaseNames.push(databaseName);
  return new TranslationCache({ databaseName, now });
}
