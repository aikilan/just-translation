import { TEST_PROFILE } from '../test-utils/provider';
import { describe, expect, it, vi } from 'vitest';

import { CandidateResolver } from './candidate-resolver';
import type { LanguageScore } from './content-language';
import type {
  TranslationCacheContext,
  TranslationCacheLookupCandidate,
} from './translation-cache';

const CONTEXT: TranslationCacheContext = {
  ...TEST_PROFILE,
  thinkingEnabled: true,
  origin: 'https://news.example.com',
  apiUrl: 'https://gateway.example.com/v1',
  model: 'translation-model',
  targetLanguage: 'Simplified Chinese',
  translationPrompt: 'Translate naturally into {{targetLanguage}}.',
};

describe('CandidateResolver', () => {
  it('separates target-language skips, persistent-cache hits, and network misses', async () => {
    const lookup = vi.fn(
      (
        _context: TranslationCacheContext,
        candidates: TranslationCacheLookupCandidate[],
      ) => Promise.resolve(
        Object.fromEntries(
          candidates.filter(({ id }) => id === 'cached').map(({ id }) => [id, '缓存译文']),
        ),
      ),
    );
    const resolver = new CandidateResolver(
      { lookup },
      vi.fn<() => LanguageScore[]>(() => [
        { lang: 'ja', accuracy: 0.99 },
        { lang: 'zh', accuracy: 0.01 },
      ]),
    );

    await expect(
      resolver.resolve(CONTEXT, [
        { id: 'skipped', text: '这是中文内容', declaredLanguage: 'zh-CN' },
        { id: 'cached', text: 'A cached English paragraph.' },
        { id: 'miss', text: 'これは翻訳が必要な日本語の文章です。', declaredLanguage: 'ja' },
      ]),
    ).resolves.toEqual({
      skippedIds: ['skipped'],
      cachedTranslations: { cached: '缓存译文' },
      missIds: ['miss'],
    });
    expect(lookup).toHaveBeenCalledWith(CONTEXT, [
      { id: 'cached', sourceText: 'A cached English paragraph.' },
      { id: 'miss', sourceText: 'これは翻訳が必要な日本語の文章です。' },
    ]);
  });

  it('treats a cache read failure as a miss without losing candidates', async () => {
    const resolver = new CandidateResolver({
      lookup: vi.fn().mockRejectedValue(new Error('IndexedDB unavailable')),
    });

    await expect(
      resolver.resolve(CONTEXT, [
        { id: 'first', text: 'First paragraph requires translation.' },
        { id: 'second', text: 'Second paragraph requires translation.' },
      ]),
    ).resolves.toEqual({
      skippedIds: [],
      cachedTranslations: {},
      missIds: ['first', 'second'],
    });
  });
});
