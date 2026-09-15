import type { TranslationSegment, TranslationUnit } from './batching';
import type { DisplayMode, TranslationProfile, TranslatorSettings } from './settings';
import type { TranslationRequestStage } from './translation-metrics';

export type TranslationPhase = 'idle' | 'translating' | 'complete' | 'stopped' | 'error';
export type TranslationMode = 'segmented' | 'full-document';

export interface PageTranslationStatus {
  mode: TranslationMode;
  stage?: 'collecting' | 'requesting' | 'applying';
  phase: TranslationPhase;
  translated: number;
  failed: number;
  total: number;
  error?: string;
  displayMode: DisplayMode;
  context?: { profileId: string; targetLanguage: string };
  needsRestart?: boolean;
}

export interface PublicTranslationProfile {
  id: string;
  name: string;
  configured: boolean;
  configurationError?: string;
}

export type PublicTranslatorSettings = Pick<
  TranslatorSettings,
  | 'targetLanguage'
  | 'displayMode'
  | 'translateDynamicContent'
  | 'excludedSites'
  | 'activeProfileId'
  | 'autoTranslateSites'
> & {
  profiles: PublicTranslationProfile[];
  configured: boolean;
  configurationError?: string;
};

export interface TranslationCandidate {
  id: string;
  text: string;
  declaredLanguage?: string;
}

export interface CandidateResolution {
  skippedIds: string[];
  cachedTranslations: Record<string, string>;
  missIds: string[];
}

export interface TranslationCacheWrite {
  sourceText: string;
  translatedText: string;
}

/** Opaque snapshot identity: enables safe partial retry without exposing provider configuration. */
export interface TranslationSessionInfo {
  context: { profileId: string; targetLanguage: string };
  configurationId: string;
}

export type TranslationPriority = 'visible' | 'readAhead' | 'background';

/** Keeps valid items usable when one provider response omits only part of a batch. */
export interface TranslationBatchResult {
  translations: Record<string, string>;
  failures: Record<string, string>;
}

/** Background-to-document events carry no configuration or original webpage text. */
export interface TranslationBatchProgress {
  type: 'TRANSLATION_BATCH_PROGRESS';
  sessionId: string;
  batchId: string;
  translations: Record<string, string>;
  timing?: { stage: TranslationRequestStage; durationMs: number };
}

export type ReadingPreferences = Pick<
  TranslatorSettings,
  'targetLanguage' | 'displayMode' | 'translateDynamicContent'
>;
export interface SiteRuleUpdate {
  list: 'autoTranslateSites' | 'excludedSites';
  hostname: string;
  enabled: boolean;
}

export type RuntimeRequest =
  | { type: 'GET_PUBLIC_SETTINGS' }
  | {
      type: 'BEGIN_TRANSLATION_SESSION';
      profileId: string;
      sessionId: string;
      mode: TranslationMode;
    }
  | { type: 'TRANSLATE_FULL_DOCUMENT'; sessionId: string; units: TranslationUnit[] }
  | {
      type: 'RESOLVE_TRANSLATION_CANDIDATES';
      sessionId: string;
      candidates: TranslationCandidate[];
    }
  | { type: 'STORE_TRANSLATION_CACHE'; sessionId: string; entries: TranslationCacheWrite[] }
  | {
      type: 'TRANSLATE_BATCH';
      batchId: string;
      sessionId: string;
      priority: TranslationPriority;
      segments: TranslationSegment[];
    }
  | { type: 'CANCEL_TRANSLATION_REQUESTS'; sessionId: string }
  | { type: 'CANCEL_TRANSLATION_BATCH'; sessionId: string; batchId: string }
  | {
      type: 'PROMOTE_TRANSLATION_BATCHES';
      sessionId: string;
      batchIds: string[];
      priority: TranslationPriority;
    }
  | { type: 'END_TRANSLATION_SESSION'; sessionId: string }
  | { type: 'SAVE_TRANSLATION_PROFILE'; profile: TranslationProfile }
  | { type: 'DELETE_TRANSLATION_PROFILE'; profileId: string }
  | { type: 'UPDATE_READING_PREFERENCES'; patch: Partial<ReadingPreferences> }
  | { type: 'UPDATE_SITE_RULE'; rule: SiteRuleUpdate }
  | { type: 'SET_ACTIVE_PROFILE'; profileId: string }
  | { type: 'SET_SITE_AUTO_TRANSLATE'; hostname: string; enabled: boolean };

export type PageCommand =
  | TranslationBatchProgress
  | { type: 'GET_PAGE_DIAGNOSTICS' }
  | { type: 'START_TRANSLATION' }
  | { type: 'START_FULL_DOCUMENT_TRANSLATION' }
  | { type: 'RESTART_TRANSLATION' }
  | { type: 'STOP_TRANSLATION' }
  | { type: 'RESTORE_PAGE' }
  | { type: 'TOGGLE_TRANSLATION' }
  | { type: 'SET_DISPLAY_MODE'; displayMode: DisplayMode }
  | { type: 'GET_PAGE_STATUS' };

export type Result<T> = { ok: true; data: T } | { ok: false; error: string };

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '发生未知错误';
}
