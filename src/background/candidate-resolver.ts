import type { CandidateResolution, TranslationCandidate } from '../shared/messages';
import {
  shouldSkipTargetLanguage,
  type LanguageDetector,
} from './content-language';
import type {
  TranslationCacheContext,
  TranslationCacheLookupCandidate,
} from './translation-cache';

export interface CandidateCacheReader {
  lookup(
    context: TranslationCacheContext,
    candidates: readonly TranslationCacheLookupCandidate[],
  ): Promise<Record<string, string>>;
}

/** Resolves filtering and persistent-cache state before the page creates any loading UI. */
export class CandidateResolver {
  constructor(
    private readonly cache: CandidateCacheReader,
    private readonly detector?: LanguageDetector,
  ) {}

  async resolve(
    context: TranslationCacheContext,
    candidates: readonly TranslationCandidate[],
  ): Promise<CandidateResolution> {
    const skippedIds: string[] = [];
    const cacheCandidates: TranslationCacheLookupCandidate[] = [];
    for (const candidate of candidates) {
      if (
        shouldSkipTargetLanguage(
          candidate.text,
          candidate.declaredLanguage,
          context.targetLanguage,
          this.detector,
        )
      ) {
        skippedIds.push(candidate.id);
      } else {
        cacheCandidates.push({ id: candidate.id, sourceText: candidate.text });
      }
    }

    let cachedTranslations: Record<string, string> = {};
    try {
      cachedTranslations = await this.cache.lookup(context, cacheCandidates);
    } catch {
      // IndexedDB is an optimization only; a failed read must not block page translation.
    }
    return {
      skippedIds,
      cachedTranslations,
      missIds: cacheCandidates
        .filter((candidate) => !(candidate.id in cachedTranslations))
        .map((candidate) => candidate.id),
    };
  }
}
