import { sendRuntimeMessage } from '../../shared/chrome-api';
import { LocalizedError, message, type UiMessage } from '../../shared/i18n';
import {
  getErrorMessage,
  type CandidateResolution,
  type Result,
  type RuntimeRequest,
  type TranslationBatchDispatchResult,
  type TranslationPriority,
  type TranslationSessionInfo,
} from '../../shared/messages';
import type { ActiveTranslator } from '../../shared/translation-engines';
import {
  TranslationBatchDeferredError,
  TranslationScheduler,
  type ScheduledTranslationBatch,
  type ScheduledTranslationUnit,
} from '../translation-scheduler';
import type { SubtitleSentence } from './sentences';

export type SubtitleTranslation =
  | { state: 'pending' }
  | { state: 'translated'; text: string }
  /** Already in the target language: shown as is. */
  | { state: 'original' }
  | { state: 'failed'; error: UiMessage };

export interface SubtitleTranslatorListener {
  onChange(): void;
  onError(error: UiMessage): void;
}

type Runtime = <T>(request: RuntimeRequest) => Promise<Result<T>>;

/** Lines this close ahead of playback are needed first. */
const VISIBLE_AHEAD_MS = 30_000;
/** Nothing further ahead is sent: a viewer may stop watching at any time. */
const HORIZON_AHEAD_MS = 180_000;
const HORIZON_BEHIND_MS = 5_000;
const LOOKUP_CHUNK_ITEMS = 24;
const RETRY_DELAY_MS = 15_000;
const MAX_ATTEMPTS = 3;

/**
 * Translates the sentences of one caption track through a normal page translation session:
 * the persistent cache, the target-language skip, provider queues and retries all apply.
 * Work follows the playback position instead of the whole video.
 */
export class SubtitleTranslator {
  private readonly states = new Map<string, SubtitleTranslation>();
  private readonly attempts = new Map<string, { count: number; failedAt: number }>();
  /** Sentences in a cache lookup, the request queue or a request; value is their unit id. */
  private readonly requested = new Map<string, string>();
  private readonly sentenceByUnit = new Map<string, SubtitleSentence>();
  private session: (TranslationSessionInfo & { id: string }) | undefined;
  private scheduler: TranslationScheduler | undefined;
  private stopped = false;
  private positionMs = 0;
  private lookups = Promise.resolve();
  /** Every request gets a new unit id: the scheduler never takes the same id twice. */
  private unitSerial = 0;

  constructor(
    private readonly sentences: readonly SubtitleSentence[],
    private readonly languageCode: string | undefined,
    private readonly listener: SubtitleTranslatorListener,
    private readonly runtime: Runtime = sendRuntimeMessage,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async start(translator: ActiveTranslator): Promise<void> {
    const id = crypto.randomUUID();
    const response = await this.runtime<TranslationSessionInfo>({
      type: 'BEGIN_TRANSLATION_SESSION',
      translator,
      sessionId: id,
      mode: 'segmented',
    });
    if (!response.ok) throw new LocalizedError(response.error);
    if (this.stopped) {
      this.endSession(id);
      return;
    }
    this.session = { ...response.data, id };
    this.scheduler = new TranslationScheduler((batch) => this.translateBatch(batch), {
      concurrency: response.data.maxConcurrency,
      batchProfiles: response.data.batchProfiles,
    });
    this.update();
  }

  translationOf(sentenceId: string): SubtitleTranslation {
    return this.states.get(sentenceId) ?? { state: 'pending' };
  }

  setPosition(positionMs: number): void {
    this.positionMs = positionMs;
    if (this.session && !this.stopped) this.update();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.scheduler?.stop();
    if (this.session) this.endSession(this.session.id);
  }

  private update(): void {
    const scheduler = this.scheduler!;
    const fresh: SubtitleSentence[] = [];
    const queued: Pick<ScheduledTranslationUnit, 'id' | 'priority' | 'order'>[] = [];
    const departed: string[] = [];
    for (const [order, sentence] of this.sentences.entries()) {
      const unitId = this.requested.get(sentence.id);
      if (!this.isNearPlayback(sentence)) {
        if (unitId) departed.push(unitId);
        continue;
      }
      if (unitId) {
        queued.push({ id: unitId, priority: this.priorityOf(sentence), order });
        continue;
      }
      const state = this.states.get(sentence.id);
      if (state?.state === 'translated' || state?.state === 'original') continue;
      const attempt = this.attempts.get(sentence.id);
      if (
        attempt &&
        (attempt.count >= MAX_ATTEMPTS || this.now() - attempt.failedAt < RETRY_DELAY_MS)
      )
        continue;
      fresh.push(sentence);
    }
    // After a seek, lines left behind are not sent; requests already sent still finish.
    if (departed.length) for (const unitId of scheduler.discard(departed)) this.release(unitId);
    if (queued.length) {
      scheduler.updatePriorities(queued);
      scheduler.refresh();
    }
    if (!fresh.length) return;
    for (const sentence of fresh) {
      const unitId = `${sentence.id}:${++this.unitSerial}`;
      this.requested.set(sentence.id, unitId);
      this.sentenceByUnit.set(unitId, sentence);
    }
    for (let index = 0; index < fresh.length; index += LOOKUP_CHUNK_ITEMS) {
      const chunk = fresh.slice(index, index + LOOKUP_CHUNK_ITEMS);
      const unitIds = chunk.map((sentence) => this.requested.get(sentence.id)!);
      this.lookups = this.lookups
        .then(() => this.resolve(chunk))
        .catch(() => {
          // Keep later lookups going; these lines are requested again while near playback.
          if (this.stopped) return;
          this.scheduler!.discard(unitIds);
          for (const unitId of unitIds) this.release(unitId);
        });
    }
  }

  /** Cache hits and target-language lines never reach the provider. */
  private async resolve(chunk: SubtitleSentence[]): Promise<void> {
    if (this.stopped || !this.session) return;
    // Lines a seek left behind while they waited for this lookup are not looked up or sent.
    const sentences = chunk.filter((sentence) => {
      if (this.isNearPlayback(sentence)) return true;
      const unitId = this.requested.get(sentence.id);
      if (unitId) this.release(unitId);
      return false;
    });
    if (!sentences.length) return;
    let resolution: CandidateResolution;
    try {
      const response = await this.runtime<CandidateResolution>({
        type: 'RESOLVE_TRANSLATION_CANDIDATES',
        sessionId: this.session.id,
        candidates: sentences.map((sentence) => ({
          id: sentence.id,
          text: sentence.text,
          declaredLanguage: this.languageCode,
        })),
      });
      if (!response.ok) throw new LocalizedError(response.error);
      resolution = response.data;
    } catch {
      // A failed lookup only loses the cache: translate everything in the chunk.
      resolution = {
        skippedIds: [],
        cachedTranslations: {},
        missIds: sentences.map((sentence) => sentence.id),
      };
    }
    if (this.stopped) return;
    const cachedTranslations = resolution.cachedTranslations ?? {};
    const skipped = new Set(resolution.skippedIds ?? []);
    const units: ScheduledTranslationUnit[] = [];
    for (const sentence of sentences) {
      const cached = cachedTranslations[sentence.id];
      if (typeof cached === 'string') this.settle(sentence, { state: 'translated', text: cached });
      else if (skipped.has(sentence.id)) this.settle(sentence, { state: 'original' });
      else
        units.push({
          id: this.requested.get(sentence.id)!,
          text: sentence.text,
          priority: this.priorityOf(sentence),
          order: this.sentences.indexOf(sentence),
        });
    }
    if (units.length) this.scheduler!.enqueue(units);
    this.notifyChange();
  }

  private async translateBatch(batch: ScheduledTranslationBatch): Promise<void> {
    const session = this.session;
    if (this.stopped || !session) return;
    let result: TranslationBatchDispatchResult;
    try {
      const response = await this.runtime<TranslationBatchDispatchResult>({
        type: 'TRANSLATE_BATCH',
        batchId: crypto.randomUUID(),
        sessionId: session.id,
        priority: batch.priority,
        segments: batch.segments,
      });
      if (!response.ok) throw new LocalizedError(response.error);
      result = response.data;
    } catch (error) {
      if (!this.stopped) this.failUnits(batch, getErrorMessage(error));
      return;
    }
    if (this.stopped) return;
    if ('deferred' in result) throw new TranslationBatchDeferredError();
    const parts = new Map<string, string[]>();
    const failedUnits = new Set<string>();
    let failure: UiMessage | undefined;
    for (const segment of batch.segments) {
      if (failedUnits.has(segment.unitId)) continue;
      const text = result.translations[segment.requestId];
      if (text === undefined) {
        const error = result.failures[segment.requestId] ?? message('AI 返回中缺少该段译文');
        failure ??= error;
        failedUnits.add(segment.unitId);
        parts.delete(segment.unitId);
        this.failUnit(segment.unitId, error);
        continue;
      }
      const unitParts = parts.get(segment.unitId) ?? [];
      unitParts[segment.partIndex] = text;
      parts.set(segment.unitId, unitParts);
    }
    const entries: { sourceText: string; translatedText: string }[] = [];
    for (const [unitId, unitParts] of parts) {
      const sentence = this.sentenceByUnit.get(unitId);
      if (!sentence || this.requested.get(sentence.id) !== unitId) continue;
      const translatedText = unitParts.join('').trim();
      if (!translatedText) {
        this.failUnit(unitId, message('翻译通道未返回译文，请重试'));
        continue;
      }
      this.settle(sentence, { state: 'translated', text: translatedText });
      entries.push({ sourceText: sentence.text, translatedText });
    }
    if (entries.length)
      void this.runtime<void>({
        type: 'STORE_TRANSLATION_CACHE',
        sessionId: session.id,
        entries,
      }).catch(() => undefined);
    if (failure) this.notifyError(failure);
    this.notifyChange();
  }

  private isNearPlayback(sentence: SubtitleSentence): boolean {
    return (
      sentence.endMs >= this.positionMs - HORIZON_BEHIND_MS &&
      sentence.startMs <= this.positionMs + HORIZON_AHEAD_MS
    );
  }

  private priorityOf(sentence: SubtitleSentence): TranslationPriority {
    return sentence.startMs <= this.positionMs + VISIBLE_AHEAD_MS ? 'visible' : 'readAhead';
  }

  /** Forgets a request that will not be sent, so the line can be requested again later. */
  private release(unitId: string): void {
    const sentence = this.sentenceByUnit.get(unitId);
    this.sentenceByUnit.delete(unitId);
    if (sentence && this.requested.get(sentence.id) === unitId) this.requested.delete(sentence.id);
  }

  private settle(sentence: SubtitleSentence, state: SubtitleTranslation): void {
    this.requested.delete(sentence.id);
    this.states.set(sentence.id, state);
  }

  private failUnits(batch: ScheduledTranslationBatch, error: UiMessage): void {
    for (const unitId of new Set(batch.segments.map((segment) => segment.unitId)))
      this.failUnit(unitId, error);
    this.notifyError(error);
    this.notifyChange();
  }

  // Listener failures belong to the display; they must not stop translation.
  private notifyChange(): void {
    try {
      this.listener.onChange();
    } catch (error) {
      console.error(error);
    }
  }

  private notifyError(error: UiMessage): void {
    try {
      this.listener.onError(error);
    } catch (problem) {
      console.error(problem);
    }
  }

  /** A failed line shows its original; it is requested again later while still near playback. */
  private failUnit(unitId: string, error: UiMessage): void {
    const sentence = this.sentenceByUnit.get(unitId);
    if (!sentence || this.requested.get(sentence.id) !== unitId) return;
    this.settle(sentence, { state: 'failed', error });
    const previous = this.attempts.get(sentence.id);
    this.attempts.set(sentence.id, { count: (previous?.count ?? 0) + 1, failedAt: this.now() });
  }

  private endSession(sessionId: string): void {
    void this.runtime<void>({ type: 'CANCEL_TRANSLATION_REQUESTS', sessionId }).catch(
      () => undefined,
    );
    void this.runtime<void>({ type: 'END_TRANSLATION_SESSION', sessionId }).catch(() => undefined);
  }
}
