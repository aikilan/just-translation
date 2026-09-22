import {
  isUiMessage,
  toUiMessage,
  type UiMessage,
  type UiLanguage,
  type UiLocale,
} from './i18n';
import type { TranslationSegment, TranslationUnit } from './batching';
import type { DisplayMode, TranslationProfile, TranslatorSettings } from './settings';
import type { TranslationRequestStage } from './translation-metrics';

export type TranslationPhase = 'idle' | 'translating' | 'complete' | 'stopped' | 'error';
export type TranslationMode = 'segmented' | 'full-document';

export interface PageTranslationStatus {
  mode: TranslationMode;
  stage?: 'collecting' | 'requesting' | 'applying' | 'incremental';
  phase: TranslationPhase;
  translated: number;
  failed: number;
  total: number;
  error?: UiMessage;
  displayMode: DisplayMode;
  context?: { profileId: string; targetLanguage: string };
  needsRestart?: boolean;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** Rejects stale or malformed content-script responses before the popup treats a page as linked. */
export function isPageTranslationStatus(value: unknown): value is PageTranslationStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const status = value as Record<string, unknown>;
  const context = status.context;
  return (
    (status.mode === 'segmented' || status.mode === 'full-document') &&
    (status.phase === 'idle' ||
      status.phase === 'translating' ||
      status.phase === 'complete' ||
      status.phase === 'stopped' ||
      status.phase === 'error') &&
    (status.stage === undefined ||
      status.stage === 'collecting' ||
      status.stage === 'requesting' ||
      status.stage === 'applying' ||
      status.stage === 'incremental') &&
    isNonNegativeInteger(status.translated) &&
    isNonNegativeInteger(status.failed) &&
    isNonNegativeInteger(status.total) &&
    (status.error === undefined || isUiMessage(status.error)) &&
    (status.displayMode === 'bilingual' || status.displayMode === 'translation') &&
    (context === undefined ||
      (typeof context === 'object' &&
        context !== null &&
        !Array.isArray(context) &&
        'profileId' in context &&
        typeof context.profileId === 'string' &&
        'targetLanguage' in context &&
        typeof context.targetLanguage === 'string')) &&
    (status.needsRestart === undefined || typeof status.needsRestart === 'boolean')
  );
}

export interface PublicTranslationProfile {
  id: string;
  name: string;
  configured: boolean;
  configurationError?: UiMessage;
}

export type PublicTranslatorSettings = Pick<
  TranslatorSettings,
  | 'uiLanguage'
  | 'targetLanguage'
  | 'displayMode'
  | 'translateDynamicContent'
  | 'translationConcurrency'
  | 'translationRetryCount'
  | 'excludedSites'
  | 'activeProfileId'
  | 'autoTranslateSites'
> & {
  profiles: PublicTranslationProfile[];
  configured: boolean;
  configurationError?: UiMessage;
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
  failures: Record<string, UiMessage>;
}

/** A deferred batch has never issued HTTP and can safely be repacked by the page scheduler. */
export type TranslationBatchDispatchResult = TranslationBatchResult | { deferred: true };

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
  | 'targetLanguage'
  | 'displayMode'
  | 'translateDynamicContent'
  | 'translationConcurrency'
  | 'translationRetryCount'
>;
export interface SiteRuleUpdate {
  list: 'autoTranslateSites' | 'excludedSites';
  hostname: string;
  enabled: boolean;
}

export type RuntimeRequest =
  | { type: 'UPDATE_UI_LANGUAGE'; uiLanguage: UiLanguage }
  | { type: 'PAGE_RETRY_STATE_CHANGED' }
  | { type: 'TRANSLATE_SELECTION'; requestId: string; text: string }
  | { type: 'CANCEL_SELECTION_TRANSLATION'; requestId: string }
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
      type: 'UPDATE_TRANSLATION_PRIORITIES';
      sessionId: string;
      revision: number;
      batches: { batchId: string; priority: TranslationPriority }[];
      /** Return never-submitted offscreen work to make room for newly visible units. */
      requeueUnsent: boolean;
    }
  | { type: 'END_TRANSLATION_SESSION'; sessionId: string }
  | { type: 'SAVE_TRANSLATION_PROFILE'; profile: TranslationProfile }
  | { type: 'DELETE_TRANSLATION_PROFILE'; profileId: string }
  | { type: 'UPDATE_READING_PREFERENCES'; patch: Partial<ReadingPreferences> }
  | { type: 'UPDATE_SITE_RULE'; rule: SiteRuleUpdate }
  | { type: 'SET_ACTIVE_PROFILE'; profileId: string }
  | { type: 'SET_SITE_AUTO_TRANSLATE'; hostname: string; enabled: boolean };

export type PageCommand =
  | { type: 'UI_LANGUAGE_CHANGED'; locale: UiLocale }
  | { type: 'START_SELECTION_TRANSLATION'; text: string }
  | TranslationBatchProgress
  | { type: 'GET_PAGE_DIAGNOSTICS' }
  | { type: 'START_TRANSLATION' }
  | { type: 'START_FULL_DOCUMENT_TRANSLATION' }
  | { type: 'RESTART_TRANSLATION' }
  | { type: 'RETRY_FAILED_TRANSLATIONS' }
  | { type: 'STOP_TRANSLATION' }
  | { type: 'RESTORE_PAGE' }
  | { type: 'TOGGLE_TRANSLATION' }
  | { type: 'SET_DISPLAY_MODE'; displayMode: DisplayMode }
  | { type: 'GET_PAGE_STATUS' };

export type Result<T> = { ok: true; data: T } | { ok: false; error: UiMessage };

/** Only display data crosses back to the selected document; provider credentials stay trusted. */
export interface SelectionTranslationResult {
  text: string;
  targetLanguage: string;
}

export function getErrorMessage(error: unknown): UiMessage {
  return toUiMessage(error);
}
