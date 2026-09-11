import {
  createTranslationBatches,
  mergeTranslatedSegments,
  type TranslationSegment,
} from '../shared/batching';
import { sendRuntimeMessage } from '../shared/chrome-api';
import { runWithConcurrency } from '../shared/concurrency';
import {
  getErrorMessage,
  type CandidateResolution,
  type PageTranslationStatus,
  type PublicTranslatorSettings,
  type Result,
  type RuntimeRequest,
  type TranslationBatchResult,
  type TranslationCacheWrite,
  type TranslationCandidate,
  type TranslationPriority,
  type TranslationBatchProgress,
  type TranslationSessionInfo,
} from '../shared/messages';
import { TranslationMetrics, type TranslationDiagnostics } from '../shared/translation-metrics';
import { RenderTasks } from './render-tasks';
import { isUrlExcluded, type DisplayMode } from '../shared/settings';
import {
  cleanupReadingRuns,
  discoverTranslatableElements,
  getElementDeclaredLanguage,
  getElementSourceText,
  renderTranslation,
  prepareTranslationRender,
  renderTranslationError,
  renderTranslationPending,
  restoreDocument,
  restoreSourceElement,
  setDocumentDisplayMode,
  setSourceDisplayMode,
} from './dom-translator';
import {
  INTERNAL_TRANSLATION_CONCURRENCY,
  TRANSLATION_BATCH_PROFILES,
  TranslationScheduler,
  type ScheduledTranslationBatch,
  type ScheduledTranslationUnit,
} from './translation-scheduler';

const DYNAMIC_CONTENT_DEBOUNCE_MS = 800;
const MAX_STALE_RETRANSLATION_PASSES = 3;
const PREFLIGHT_MESSAGE_TIMEOUT_MS = 5_000;
const CANDIDATE_CHUNK_MAX_ITEMS = 24;
const CANDIDATE_CHUNK_MAX_CHARACTERS = 12_000;
const MAX_PENDING_DISCOVERY_SLICES = 3;
const DYNAMIC_READING_ROOT_SELECTOR =
  'h1,h2,h3,h4,h5,h6,p,li,blockquote,figcaption,dt,dd,td,th,a,article,section,div';
const TRANSLATION_PRIORITIES: readonly TranslationPriority[] = [
  'visible',
  'readAhead',
  'background',
];
// DOM compareDocumentPosition bit used without relying on a page-realm Node constructor.
const DOCUMENT_POSITION_FOLLOWING = 4;

type TranslationRecordPhase = 'queued' | 'pending' | 'translated' | 'error';
type TranslationRecordOutcome =
  { kind: 'translated'; translatedText: string } | { kind: 'error'; error: string };

interface TranslationRecord {
  id: string;
  element: HTMLElement;
  sourceText: string;
  phase: TranslationRecordPhase;
  generation: number;
  error?: string;
  outcome?: TranslationRecordOutcome;
  outcomeAt?: number;
  checkpoint?: TranslationCheckpoint;
}

/** Per-node task progress, discarded with its source; not an additional translation cache. */
interface TranslationCheckpoint {
  configurationId: string;
  sourceText: string;
  translatedParts: Record<number, string>;
}

interface CandidateGroup {
  id: string;
  sourceText: string;
  declaredLanguage?: string;
  members: HTMLElement[];
  priority: TranslationPriority;
  order: number;
}

interface CandidateCollection {
  groups: CandidateGroup[];
  groupByElement: Map<HTMLElement, CandidateGroup>;
}

interface PreparedTranslationPass {
  elements: HTMLElement[];
  candidates: CandidateCollection;
  discovery: AsyncGenerator<HTMLElement[], void>;
}

interface ActiveTranslationGroup {
  id: string;
  sourceText: string;
  records: TranslationRecord[];
  checkpoint: TranslationCheckpoint;
}

interface TranslationPassResult {
  hasStaleSource: boolean;
  lastError?: string;
}

interface OrderedRenderSlot {
  element: HTMLElement;
  record?: TranslationRecord;
  skipped: boolean;
}

interface OrderedRenderQueue {
  slots: OrderedRenderSlot[];
  nextIndex: number;
}

interface ReadingWindowRenderCoordinator {
  tasks: RenderTasks;
  lanes: Record<TranslationPriority, OrderedRenderQueue>;
  slotByElement: Map<HTMLElement, OrderedRenderSlot>;
}

interface ActiveTranslationPass {
  sessionId: string;
  settings: PublicTranslatorSettings;
  scheduler: TranslationScheduler;
  renderQueue: ReadingWindowRenderCoordinator;
  activeGroups: Map<string, ActiveTranslationGroup>;
  expectedSegmentsByGroup: Map<string, TranslationSegment[]>;
  groupsBySourceText: Map<string, CandidateGroup>;
  completedTranslationsBySourceText: Map<string, string>;
  failedErrorsBySourceText: Map<string, string>;
  skippedSourceTexts: Set<string>;
  pendingDiscoveries: Set<Promise<void>>;
  markStale: () => void;
  markError: (error: string) => void;
  priorityObserver?: {
    observe: (groups: readonly CandidateGroup[]) => void;
    disconnect: () => void;
  };
}

export class TranslationController {
  private status: PageTranslationStatus = {
    phase: 'idle',
    translated: 0,
    failed: 0,
    total: 0,
    displayMode: 'bilingual',
  };
  private mainSessionId: string | null = null;
  private readonly retrySessionIds = new Set<string>();
  private readonly sessionConfigurations = new Map<string, string>();
  private readonly sessionCacheWrites = new Map<string, Set<Promise<void>>>();
  private observer: MutationObserver | null = null;
  private observerTimer: number | undefined;
  private readonly dynamicRoots = new Map<HTMLElement, number>();
  private dynamicContentEnabled = false;
  private nextUnitNumber = 0;
  private readonly records = new Map<HTMLElement, TranslationRecord>();
  private activePass: ActiveTranslationPass | null = null;
  private discoveryAbort = new AbortController();
  private nextReadingOrder = 0;
  private metrics = new TranslationMetrics();
  private readonly batchReceivers = new Map<
    string,
    {
      sessionId: string;
      ids: Set<string>;
      groupIds: Set<string>;
      priority: TranslationPriority;
      cancelled?: boolean;
      publish: (translations: Record<string, string>) => void;
    }
  >();

  getDiagnostics(): TranslationDiagnostics {
    return this.metrics.snapshot();
  }

  /** Accepts events only for an active request in this document's current translation session. */
  receiveBatchProgress(event: TranslationBatchProgress): void {
    const receiver = this.batchReceivers.get(event.batchId);
    if (
      !receiver ||
      receiver.sessionId !== event.sessionId ||
      (this.mainSessionId !== event.sessionId && !this.retrySessionIds.has(event.sessionId))
    )
      return;
    if (Object.keys(event.translations).some((id) => !receiver.ids.has(id))) return;
    if (event.timing) this.metrics.record(event.timing.stage, event.timing.durationMs);
    receiver.publish(event.translations);
  }

  private async sendBatch(
    sessionId: string,
    priority: TranslationPriority,
    segments: TranslationSegment[],
    publish: (translations: Record<string, string>) => void = () => undefined,
  ): Promise<Result<TranslationBatchResult>> {
    const batchId = crypto.randomUUID();
    this.metrics.recordBatch(
      segments.length,
      segments.reduce((count, segment) => count + segment.text.length, 0),
    );
    this.batchReceivers.set(batchId, {
      sessionId,
      ids: new Set(segments.map((segment) => segment.requestId)),
      groupIds: new Set(segments.map((segment) => segment.unitId)),
      priority,
      publish,
    });
    try {
      return await sendRuntimeMessage<TranslationBatchResult>({
        type: 'TRANSLATE_BATCH',
        batchId,
        sessionId,
        priority,
        segments,
      });
    } finally {
      this.batchReceivers.delete(batchId);
    }
  }

  getStatus(): PageTranslationStatus {
    return { ...this.status };
  }

  async start(): Promise<void> {
    return this.startTranslation();
  }

  private async startTranslation(scopeRoots?: readonly HTMLElement[]): Promise<void> {
    if (this.hasActiveOperation()) return;
    this.disconnectObserver(scopeRoots === undefined);
    this.purgeDisconnectedRecords();
    const sessionId = crypto.randomUUID();
    this.mainSessionId = sessionId;
    this.status.phase = 'translating';
    this.status.error = undefined;
    this.syncStatusCounts();
    this.discoveryAbort = new AbortController();
    this.metrics = new TranslationMetrics();
    let sessionStarted = false;

    try {
      // Capture only the first discovered slice before preflight; remaining DOM work is streamed.
      const initialPass = await this.prepareInitialRecords(scopeRoots);
      if (this.mainSessionId !== sessionId) return;
      const finishPreflight = this.metrics.start('preflight');
      const settings = await this.readValidSettings();
      if (isUrlExcluded(location.href, settings.excludedSites)) {
        throw new Error('当前站点已被排除');
      }
      await this.beginTranslationSession(sessionId, settings.activeProfileId);
      finishPreflight();
      sessionStarted = true;
      if (this.mainSessionId !== sessionId) return;

      this.dynamicContentEnabled = settings.translateDynamicContent;
      this.status.displayMode = settings.displayMode;
      setDocumentDisplayMode(settings.displayMode);
      if (this.dynamicContentEnabled) this.observeDynamicContent();
      let hasStaleSource = false;
      let lastError: string | undefined;
      for (let pass = 0; pass < MAX_STALE_RETRANSLATION_PASSES; pass += 1) {
        const result = await this.translateUnprocessedElements(
          settings,
          sessionId,
          pass === 0 ? initialPass : undefined,
        );
        if (this.mainSessionId !== sessionId) return;
        hasStaleSource = result.hasStaleSource;
        lastError = result.lastError ?? lastError;
        if (!hasStaleSource) break;
      }

      if (this.mainSessionId !== sessionId) return;
      this.mainSessionId = null;
      if (hasStaleSource) {
        this.syncStatusCounts();
        this.status.phase = 'error';
        this.status.error = '页面内容持续变化，已暂停以避免反复请求';
        return;
      }
      this.settleStatus(lastError);
      this.resumeDynamicObserver();
    } catch (error) {
      if (this.mainSessionId !== sessionId) return;
      this.mainSessionId = null;
      const message = getErrorMessage(error);
      this.failPendingRecords(message);
      this.syncStatusCounts();
      this.status.phase = 'error';
      this.status.error = message;
    } finally {
      if (sessionStarted) void this.closeSessionAfterCacheWrites(sessionId);
      if (!this.hasActiveOperation()) this.metrics.finish();
    }
  }

  /** Retries only the selected failed source and ignores duplicate activation while pending. */
  async retry(source: HTMLElement): Promise<void> {
    const record = this.records.get(source);
    if (!record || record.phase !== 'error') return;
    if (!source.isConnected) {
      this.discardRecord(record, false);
      this.settleStatus();
      return;
    }

    if (!this.hasActiveOperation()) this.metrics = new TranslationMetrics();
    const sessionId = crypto.randomUUID();
    const generation = record.generation + 1;
    record.generation = generation;
    record.sourceText = getElementSourceText(source);
    record.phase = 'pending';
    record.error = undefined;
    this.retrySessionIds.add(sessionId);
    renderTranslationPending(source, record.id);
    this.consumeObservedMutations();
    this.status.phase = 'translating';
    this.status.error = undefined;
    this.syncStatusCounts();
    let requiresRescan = false;
    let sessionStarted = false;

    try {
      const settings = await this.readValidSettings();
      if (isUrlExcluded(location.href, settings.excludedSites)) {
        throw new Error('当前站点已被排除');
      }
      await this.beginTranslationSession(sessionId, settings.activeProfileId);
      sessionStarted = true;
      if (!this.isCurrentRetry(record, sessionId, generation)) return;
      const configurationId = this.sessionConfigurations.get(sessionId)!;
      if (
        record.checkpoint?.configurationId !== configurationId ||
        record.checkpoint.sourceText !== record.sourceText
      ) {
        record.checkpoint = { configurationId, sourceText: record.sourceText, translatedParts: {} };
      }
      const checkpoint = record.checkpoint;
      this.dynamicContentEnabled = settings.translateDynamicContent;
      const resolution = await this.resolveCandidates(sessionId, [
        {
          id: record.id,
          text: record.sourceText,
          declaredLanguage: getElementDeclaredLanguage(source),
        },
      ]);
      if (!this.isCurrentRetry(record, sessionId, generation)) return;
      if (resolution.skippedIds.includes(record.id)) {
        this.discardRecord(record, true);
        return;
      }
      const cached = resolution.cachedTranslations[record.id];
      if (cached !== undefined) {
        if (getElementSourceText(source) !== record.sourceText) {
          this.discardRecord(record, true);
          requiresRescan = true;
          return;
        }
        renderTranslation(source, cached);
        record.phase = 'translated';
        this.metrics.markFirstTranslation();
        this.metrics.recordCacheHits(1);
        record.checkpoint = undefined;
        setSourceDisplayMode(source, this.status.displayMode);
        this.consumeObservedMutations();
        return;
      }
      if (!resolution.missIds.includes(record.id)) {
        throw new Error('候选文本解析结果不完整');
      }

      const prepared = createTranslationBatches([{ id: record.id, text: record.sourceText }], {
        maxCharacters: TRANSLATION_BATCH_PROFILES.visible.maxCharacters,
        maxItems: TRANSLATION_BATCH_PROFILES.visible.maxItems,
      });
      const translations: Record<string, string> = Object.fromEntries(
        prepared.segments.flatMap((segment) => {
          const text = checkpoint.translatedParts[segment.partIndex];
          return text === undefined ? [] : [[segment.requestId, text]];
        }),
      );
      const missingBatches = prepared.batches
        .map((batch) => batch.filter((segment) => !(segment.requestId in translations)))
        .filter((batch) => batch.length > 0);
      const responses = await runWithConcurrency(
        missingBatches,
        INTERNAL_TRANSLATION_CONCURRENCY,
        async (batch) => {
          const publish = (partial: Record<string, string>) => {
            if (!this.isCurrentRetry(record, sessionId, generation)) return;
            for (const segment of batch) {
              const text = partial[segment.requestId];
              if (text !== undefined) checkpoint.translatedParts[segment.partIndex] = text;
            }
          };
          const response = await this.sendBatch(sessionId, 'visible', batch, publish);
          if (response.ok) publish(response.data.translations);
          return response;
        },
      );
      if (!this.isCurrentRetry(record, sessionId, generation)) return;

      for (const response of responses) {
        if (!response.ok) throw new Error(response.error);
        Object.assign(translations, response.data.translations);
        const firstFailure = Object.values(response.data.failures)[0];
        if (firstFailure) throw new Error(firstFailure);
      }
      if (getElementSourceText(source) !== record.sourceText) {
        this.discardRecord(record, true);
        requiresRescan = true;
        return;
      }

      const translatedText = mergeTranslatedSegments(prepared.segments, translations).get(
        record.id,
      );
      if (translatedText === undefined) throw new Error('AI 返回中缺少当前段落译文');
      renderTranslation(source, translatedText);
      record.phase = 'translated';
      this.metrics.markFirstTranslation();
      record.checkpoint = undefined;
      record.error = undefined;
      setSourceDisplayMode(source, this.status.displayMode);
      this.consumeObservedMutations();
      this.storeCacheEntries(sessionId, [{ sourceText: record.sourceText, translatedText }]);
    } catch (error) {
      if (!this.isCurrentRetry(record, sessionId, generation)) return;
      this.markRecordError(record, getErrorMessage(error));
      this.consumeObservedMutations();
    } finally {
      const wasActive = this.retrySessionIds.delete(sessionId);
      this.consumeObservedMutations();
      if (sessionStarted) void this.closeSessionAfterCacheWrites(sessionId);
      if (wasActive) {
        this.settleStatus();
        if (requiresRescan && !this.hasActiveOperation()) await this.start();
        else this.resumeDynamicObserver();
      }
      if (!this.hasActiveOperation()) this.metrics.finish();
    }
  }

  stop(): void {
    const activeSessionIds = [
      ...(this.mainSessionId ? [this.mainSessionId] : []),
      ...this.retrySessionIds,
    ];
    this.mainSessionId = null;
    this.retrySessionIds.clear();
    this.discoveryAbort.abort();
    this.batchReceivers.clear();
    this.activePass?.scheduler.stop();
    this.activePass?.renderQueue.tasks.stop();
    this.activePass = null;
    this.disconnectObserver();
    for (const sessionId of activeSessionIds) {
      void sendRuntimeMessage<void>({ type: 'CANCEL_TRANSLATION_REQUESTS', sessionId });
    }
    for (const record of [...this.records.values()]) {
      if (record.phase === 'queued' || record.phase === 'pending') {
        this.discardRecord(record, true);
      }
    }
    cleanupReadingRuns();
    this.syncStatusCounts();
    this.status.phase = 'stopped';
    this.status.error = undefined;
    this.metrics.finish();
  }

  restore(): void {
    this.stop();
    restoreDocument();
    this.records.clear();
    this.nextUnitNumber = 0;
    this.status = {
      phase: 'idle',
      translated: 0,
      failed: 0,
      total: 0,
      displayMode: this.status.displayMode,
    };
  }

  toggle(): void {
    if (this.status.phase === 'idle' || this.status.phase === 'stopped') void this.start();
    else this.restore();
  }

  setDisplayMode(displayMode: DisplayMode): void {
    this.status.displayMode = displayMode;
    setDocumentDisplayMode(displayMode);
    void sendRuntimeMessage<void>({ type: 'SAVE_DISPLAY_MODE', displayMode });
  }

  private async translateUnprocessedElements(
    settings: PublicTranslatorSettings,
    sessionId: string,
    preparedPass?: PreparedTranslationPass,
  ): Promise<TranslationPassResult> {
    const prepared = preparedPass ?? (await this.prepareInitialRecords());
    const elements = prepared.elements;
    const candidates = prepared.candidates;
    if (candidates.groups.length === 0) return { hasStaleSource: false };
    const renderQueue = this.createOrderedRenderQueue(elements, candidates.groupByElement);
    const activeGroups = new Map<string, ActiveTranslationGroup>();
    const expectedSegmentsByGroup = new Map<string, TranslationSegment[]>();
    const translations: Record<string, string> = {};
    const settledGroupIds = new Set<string>();
    const failedGroupIds = new Set<string>();
    const completedTranslationsBySourceText = new Map<string, string>();
    const failedErrorsBySourceText = new Map<string, string>();
    const skippedSourceTexts = new Set<string>();
    let hasStaleSource = false;
    let lastError: string | undefined;

    const scheduler = new TranslationScheduler(async (batch: ScheduledTranslationBatch) => {
      if (this.mainSessionId !== sessionId) return;
      const activeBatch = batch.segments.filter((segment) => {
        if (failedGroupIds.has(segment.unitId) || settledGroupIds.has(segment.unitId)) return false;
        const group = activeGroups.get(segment.unitId);
        // A detached/replaced source has no consumer. Keep deduplicated work only while
        // at least one current member can still use its result.
        return group?.records.some(
          (record) =>
            this.records.get(record.element) === record && this.isRecordSourceCurrent(record),
        );
      });
      if (activeBatch.length === 0) return;

      // Re-assert pending state for dynamically attached records when this batch starts.
      for (const groupId of new Set(activeBatch.map((segment) => segment.unitId))) {
        const group = activeGroups.get(groupId);
        if (!group) continue;
        for (const record of group.records) {
          if (this.records.get(record.element) !== record || record.phase !== 'queued') continue;
          record.phase = 'pending';
          renderTranslationPending(record.element, record.id);
        }
      }
      this.consumeObservedMutations();
      this.syncStatusCounts();

      const publish = (partial: Record<string, string>) => {
        if (this.mainSessionId !== sessionId) return;
        Object.assign(translations, partial);
        // Preserve every good part even if its sibling fails or finishes later.
        for (const segment of activeBatch) {
          const text = partial[segment.requestId];
          if (text === undefined) continue;
          const group = activeGroups.get(segment.unitId);
          if (group) group.checkpoint.translatedParts[segment.partIndex] = text;
        }
        const entries = this.stageCompletedGroupOutcomes(
          new Set(activeBatch.map((segment) => segment.unitId)),
          expectedSegmentsByGroup,
          translations,
          activeGroups,
          settledGroupIds,
          failedGroupIds,
          completedTranslationsBySourceText,
          () => {
            hasStaleSource = true;
          },
        );
        if (entries.length) this.storeCacheEntries(sessionId, entries);
        this.flushOrderedRenderQueue(renderQueue);
      };

      try {
        const response = await this.sendBatch(sessionId, batch.priority, activeBatch, publish);
        if (this.mainSessionId !== sessionId) return;
        if (!response.ok) throw new Error(response.error);
        publish(response.data.translations);
        const failedRequestIds = new Set(Object.keys(response.data.failures));
        for (const groupId of new Set(
          activeBatch
            .filter((segment) => failedRequestIds.has(segment.requestId))
            .map((segment) => segment.unitId),
        )) {
          const group = activeGroups.get(groupId);
          if (!group) continue;
          const failedSegment = activeBatch.find(
            (segment) => segment.unitId === groupId && failedRequestIds.has(segment.requestId),
          );
          const error = failedSegment
            ? response.data.failures[failedSegment.requestId]
            : 'AI 返回中缺少该段译文';
          lastError = error;
          failedGroupIds.add(groupId);
          settledGroupIds.add(groupId);
          failedErrorsBySourceText.set(group.sourceText, error);
          for (const record of group.records) {
            if (this.records.get(record.element) === record) {
              record.outcome = { kind: 'error', error };
              record.outcomeAt = performance.now();
            }
          }
        }
        const entries = this.stageCompletedGroupOutcomes(
          new Set(activeBatch.map((segment) => segment.unitId)),
          expectedSegmentsByGroup,
          translations,
          activeGroups,
          settledGroupIds,
          failedGroupIds,
          completedTranslationsBySourceText,
          () => {
            hasStaleSource = true;
          },
        );
        if (entries.length > 0) this.storeCacheEntries(sessionId, entries);
      } catch (error) {
        if (this.mainSessionId !== sessionId) return;
        if (!activeBatch.some((segment) => activeGroups.has(segment.unitId))) return;
        lastError = getErrorMessage(error);
        for (const groupId of new Set(activeBatch.map((segment) => segment.unitId))) {
          if (settledGroupIds.has(groupId)) continue;
          const group = activeGroups.get(groupId);
          if (!group) continue;
          failedGroupIds.add(groupId);
          settledGroupIds.add(groupId);
          failedErrorsBySourceText.set(group.sourceText, lastError);
          for (const record of group.records) {
            if (this.records.get(record.element) !== record) continue;
            record.outcome = { kind: 'error', error: lastError };
            record.outcomeAt = performance.now();
          }
        }
      }
      this.flushOrderedRenderQueue(renderQueue);
      this.consumeObservedMutations();
      this.syncStatusCounts();
    });
    const pendingDiscoveries = new Set<Promise<void>>();
    const groupsBySourceText = new Map(
      candidates.groups.map((group) => [group.sourceText, group] as const),
    );
    const activePass: ActiveTranslationPass = {
      sessionId,
      settings,
      scheduler,
      renderQueue,
      activeGroups,
      expectedSegmentsByGroup,
      groupsBySourceText,
      completedTranslationsBySourceText,
      failedErrorsBySourceText,
      skippedSourceTexts,
      pendingDiscoveries,
      markStale: () => {
        hasStaleSource = true;
      },
      markError: (error) => {
        lastError = error;
      },
    };
    this.activePass = activePass;

    // Keep stable identities for preflight errors, without creating loading for cache hits.
    this.prepareCandidateRecords(candidates.groups, renderQueue, () => {
      hasStaleSource = true;
    });

    const backgroundGroups = candidates.groups.filter((group) => group.priority !== 'visible');
    // Observe before preflight completes so a scroll cannot miss unscheduled candidates.
    const promotionObserver = this.observePriorityPromotions(backgroundGroups, scheduler);
    activePass.priorityObserver = promotionObserver;
    const trackDiscovery = (work: Promise<void>) => {
      const tracked = work.finally(() => pendingDiscoveries.delete(tracked));
      pendingDiscoveries.add(tracked);
      // Attach a handler immediately, including while the iterator is yielding to the browser.
      void tracked.catch((error) => activePass.markError(getErrorMessage(error)));
    };
    try {
      trackDiscovery(this.resolveCandidateChunks(activePass, candidates.groups));
      while (this.mainSessionId === sessionId) {
        // Backpressure bounds unresolved slices without making one slow lookup block all discovery.
        while (
          pendingDiscoveries.size >= MAX_PENDING_DISCOVERY_SLICES &&
          this.mainSessionId === sessionId
        ) {
          await Promise.race(pendingDiscoveries);
        }
        if (this.mainSessionId !== sessionId) break;
        const finishDiscovery = this.metrics.start('discovery');
        const next = await prepared.discovery.next();
        finishDiscovery();
        if (next.done || this.mainSessionId !== sessionId) break;
        trackDiscovery(this.enqueueDiscoveredElements(activePass, next.value));
      }
      if (this.mainSessionId !== sessionId) return { hasStaleSource: false };
      await scheduler.waitForIdle();
      while (pendingDiscoveries.size > 0) {
        await Promise.allSettled([...pendingDiscoveries]);
        await scheduler.waitForIdle();
      }
      await renderQueue.tasks.waitForIdle();
    } finally {
      await prepared.discovery.return(undefined);
      promotionObserver?.disconnect();
      if (this.activePass === activePass) this.activePass = null;
    }
    return { hasStaleSource, lastError };
  }

  /** Start one visible chunk first, then overlap bounded preflight work with active AI requests. */
  private async resolveCandidateChunks(
    pass: ActiveTranslationPass,
    groups: readonly CandidateGroup[],
  ): Promise<void> {
    const chunks: CandidateGroup[][] = [];
    for (const priority of TRANSLATION_PRIORITIES) {
      let chunk: CandidateGroup[] = [];
      let characters = 0;
      for (const group of groups.filter((candidate) => candidate.priority === priority)) {
        if (
          chunk.length > 0 &&
          (chunk.length >= CANDIDATE_CHUNK_MAX_ITEMS ||
            characters + group.sourceText.length > CANDIDATE_CHUNK_MAX_CHARACTERS)
        ) {
          chunks.push(chunk);
          chunk = [];
          characters = 0;
        }
        chunk.push(group);
        characters += group.sourceText.length;
      }
      if (chunk.length > 0) chunks.push(chunk);
    }
    const resolveChunk = async (chunk: CandidateGroup[]) => {
      if (this.mainSessionId !== pass.sessionId) return;
      try {
        const resolution = await this.resolveCandidateGroups(pass.sessionId, chunk);
        if (this.mainSessionId !== pass.sessionId) return;
        this.applyCandidateResolution(
          chunk,
          resolution,
          pass.activeGroups,
          pass.expectedSegmentsByGroup,
          pass.scheduler,
          pass.renderQueue,
          pass.completedTranslationsBySourceText,
          pass.skippedSourceTexts,
          pass.markStale,
        );
      } catch (error) {
        if (this.mainSessionId !== pass.sessionId) return;
        const message = getErrorMessage(error);
        pass.markError(message);
        this.stageGroupErrors(chunk, message, pass.failedErrorsBySourceText);
        this.flushOrderedRenderQueue(pass.renderQueue);
        this.consumeObservedMutations();
        this.syncStatusCounts();
      }
    };
    const first = chunks.shift();
    if (first) await resolveChunk(first);
    await runWithConcurrency(chunks, 2, resolveChunk);
  }

  /** Stages a deduplicated result; DOM rendering is released separately in reading order. */
  private stageCompletedGroupOutcomes(
    touchedGroupIds: Set<string>,
    expectedSegmentsByGroup: Map<string, TranslationSegment[]>,
    translations: Record<string, string>,
    activeGroups: Map<string, ActiveTranslationGroup>,
    settledGroupIds: Set<string>,
    failedGroupIds: Set<string>,
    completedTranslationsBySourceText: Map<string, string>,
    markStale: () => void,
  ): TranslationCacheWrite[] {
    const cacheEntries: TranslationCacheWrite[] = [];
    for (const groupId of touchedGroupIds) {
      if (settledGroupIds.has(groupId) || failedGroupIds.has(groupId)) continue;
      const group = activeGroups.get(groupId);
      const groupSegments = expectedSegmentsByGroup.get(groupId);
      if (!group || !groupSegments) continue;
      if (!groupSegments.every((segment) => segment.requestId in translations)) continue;

      const translatedText = mergeTranslatedSegments(groupSegments, translations).get(groupId);
      if (translatedText === undefined) continue;
      let activeRecordCount = 0;
      for (const record of group.records) {
        if (this.records.get(record.element) !== record) {
          if (record.element.isConnected) markStale();
          continue;
        }
        record.outcome = { kind: 'translated', translatedText };
        record.outcomeAt = performance.now();
        activeRecordCount += 1;
      }
      if (activeRecordCount > 0) {
        cacheEntries.push({ sourceText: group.sourceText, translatedText });
      }
      completedTranslationsBySourceText.set(group.sourceText, translatedText);
      settledGroupIds.add(groupId);
    }
    return cacheEntries;
  }

  /** Commits each reading window independently while preserving strict order inside that window. */
  private flushOrderedRenderQueue(queue: ReadingWindowRenderCoordinator): void {
    for (const priority of TRANSLATION_PRIORITIES) {
      this.flushOrderedRenderLane(queue.lanes[priority], queue.tasks);
    }
  }

  private flushOrderedRenderLane(queue: OrderedRenderQueue, tasks: RenderTasks): void {
    while (queue.nextIndex < queue.slots.length) {
      const slot = queue.slots[queue.nextIndex];
      if (slot.skipped) {
        queue.nextIndex += 1;
        continue;
      }
      const record = slot.record;
      if (!record) break;
      if (this.records.get(record.element) !== record) {
        queue.nextIndex += 1;
        continue;
      }
      if (!record.outcome) break;

      const outcome = record.outcome;
      const generation = record.generation;
      const readyAt = record.outcomeAt ?? performance.now();
      const pass = this.activePass;
      record.outcome = undefined;
      queue.nextIndex += 1;
      tasks.enqueue(() => {
        if (this.records.get(record.element) !== record || record.generation !== generation) return;
        this.metrics.record('orderedWait', performance.now() - readyAt);
        const finishRender = this.metrics.start('render');
        const current = this.isRecordSourceCurrent(record);
        // Guard synchronous source edits without layout reads between this slice's DOM writes.
        const sourceContent =
          record.element.querySelector(':scope > [data-justranslate-source-content]') ??
          record.element;
        const rawSourceText = sourceContent.textContent;
        let commit: (() => HTMLElement) | undefined;
        let renderError: string | undefined;
        if (current && outcome.kind === 'translated') {
          try {
            commit = prepareTranslationRender(record.element, outcome.translatedText);
          } catch (error) {
            renderError = getErrorMessage(error);
          }
        }
        return () => {
          if (this.records.get(record.element) !== record || record.generation !== generation)
            return;
          if (
            !current ||
            !sourceContent.isConnected ||
            sourceContent.textContent !== rawSourceText
          ) {
            this.discardRecord(record, record.element.isConnected);
            if (record.element.isConnected) pass?.markStale();
          } else if (commit) {
            commit();
            record.phase = 'translated';
            this.metrics.markFirstTranslation();
            record.checkpoint = undefined;
            record.error = undefined;
          } else {
            this.markRecordError(
              record,
              renderError ?? (outcome.kind === 'error' ? outcome.error : '译文渲染失败'),
            );
          }
          setSourceDisplayMode(record.element, this.status.displayMode);
          finishRender();
        };
      });
    }
  }

  private createOrderedRenderQueue(
    elements: readonly HTMLElement[],
    groupByElement: ReadonlyMap<HTMLElement, CandidateGroup>,
  ): ReadingWindowRenderCoordinator {
    const queue: ReadingWindowRenderCoordinator = {
      tasks: new RenderTasks({
        afterSlice: () => {
          this.consumeObservedMutations();
          this.syncStatusCounts();
        },
      }),
      lanes: {
        visible: { slots: [], nextIndex: 0 },
        readAhead: { slots: [], nextIndex: 0 },
        background: { slots: [], nextIndex: 0 },
      },
      slotByElement: new Map(),
    };
    for (const element of elements) {
      if (groupByElement.has(element)) this.ensureOrderedRenderSlot(queue, element);
    }
    return queue;
  }

  /** Inserts dynamic nodes into the uncommitted suffix without reordering already shown content. */
  private ensureOrderedRenderSlot(
    queue: ReadingWindowRenderCoordinator,
    element: HTMLElement,
  ): OrderedRenderSlot {
    const existing = queue.slotByElement.get(element);
    if (existing) return existing;
    const lane = queue.lanes[getElementTranslationPriority(element)];
    const slot: OrderedRenderSlot = {
      element,
      skipped: false,
    };
    let insertionIndex = lane.slots.length;
    const tail = lane.slots.at(-1);
    // Initial discovery is already in DOM order: append in O(1), scan only dynamic insertions.
    for (
      let index = lane.nextIndex;
      tail &&
      !(tail.element.compareDocumentPosition(element) & DOCUMENT_POSITION_FOLLOWING) &&
      index < lane.slots.length;
      index += 1
    ) {
      const queuedElement = lane.slots[index].element;
      if (element.compareDocumentPosition(queuedElement) & DOCUMENT_POSITION_FOLLOWING) {
        insertionIndex = index;
        break;
      }
    }
    lane.slots.splice(insertionIndex, 0, slot);
    queue.slotByElement.set(element, slot);
    return slot;
  }

  private createCandidateGroups(elements: readonly HTMLElement[]): CandidateCollection {
    const groupsByText = new Map<string, CandidateGroup & { declaredLanguages: Set<string> }>();
    const sourceTextByElement = new Map<HTMLElement, string>();
    for (const element of elements) {
      const order = this.nextReadingOrder++;
      const sourceText = getElementSourceText(element);
      sourceTextByElement.set(element, sourceText);
      let group = groupsByText.get(sourceText);
      const priority = getElementTranslationPriority(element);
      if (!group) {
        group = {
          id: `candidate-${this.nextUnitNumber++}`,
          sourceText,
          members: [],
          priority,
          order,
          declaredLanguages: new Set<string>(),
        };
        groupsByText.set(sourceText, group);
      } else if (getPriorityRank(priority) < getPriorityRank(group.priority)) {
        group.priority = priority;
      }
      group.members.push(element);
      const declaredLanguage = getElementDeclaredLanguage(element);
      if (declaredLanguage) group.declaredLanguages.add(declaredLanguage);
    }
    const groups = [...groupsByText.values()].map(({ declaredLanguages, ...group }) => ({
      ...group,
      declaredLanguage:
        declaredLanguages.size === 1 ? declaredLanguages.values().next().value : undefined,
    }));
    const normalizedGroupsByText = new Map(groups.map((group) => [group.sourceText, group]));
    return {
      groups,
      groupByElement: new Map(
        [...sourceTextByElement].map(([element, sourceText]) => [
          element,
          normalizedGroupsByText.get(sourceText)!,
        ]),
      ),
    };
  }

  /** Creates stable queued records; request dispatch is the only place that renders spinners. */
  private prepareCandidateRecords(
    groups: readonly CandidateGroup[],
    renderQueue: ReadingWindowRenderCoordinator,
    markStale: () => void,
  ): void {
    for (const group of groups) {
      for (const element of group.members) {
        const slot = this.ensureOrderedRenderSlot(renderQueue, element);
        const existingRecord = this.records.get(element);
        if (existingRecord) {
          if (!element.isConnected || getElementSourceText(element) !== group.sourceText) {
            this.discardRecord(existingRecord, element.isConnected);
            slot.skipped = true;
            markStale();
            continue;
          }
          slot.record = existingRecord;
          continue;
        }
        if (!element.isConnected || getElementSourceText(element) !== group.sourceText) {
          slot.skipped = true;
          markStale();
          continue;
        }
        const record = this.createRecord(element, group.sourceText);
        slot.record = record;
      }
    }
    this.consumeObservedMutations();
    this.syncStatusCounts();
  }

  /** Captures only the first slice; the same iterator resumes while its API requests are running. */
  private async prepareInitialRecords(
    scopeRoots?: readonly HTMLElement[],
  ): Promise<PreparedTranslationPass> {
    const signal = this.discoveryAbort.signal;
    async function* discoverRoots(): AsyncGenerator<HTMLElement[], void> {
      for (const root of scopeRoots ?? [document.body]) {
        if (signal.aborted) return;
        yield* discoverTranslatableElements(root, { url: location.href, signal });
      }
    }
    const discovery = discoverRoots();
    const finishDiscovery = this.metrics.start('discovery');
    const first = await discovery.next();
    finishDiscovery();
    const elements = first.value ?? [];
    // Capture candidate identities before cache/language resolution starts.
    const candidates = this.createCandidateGroups(elements);
    for (const element of elements) {
      if (this.records.has(element)) continue;
      const sourceText = candidates.groupByElement.get(element)?.sourceText;
      if (!sourceText) continue;
      this.createRecord(element, sourceText);
    }
    this.consumeObservedMutations();
    this.syncStatusCounts();
    return { elements, candidates, discovery };
  }

  /** Promotes unfinished preflight records to the existing per-node retry lifecycle. */
  private failPendingRecords(error: string): void {
    for (const record of this.records.values()) {
      if (record.phase !== 'queued' && record.phase !== 'pending') continue;
      record.outcome = undefined;
      this.markRecordError(record, error);
    }
    this.consumeObservedMutations();
  }

  /** Converts a pre-request failure into the same per-node retry lifecycle as an API failure. */
  private stageGroupErrors(
    groups: readonly CandidateGroup[],
    error: string,
    failedErrorsBySourceText: Map<string, string>,
  ): void {
    for (const group of groups) {
      failedErrorsBySourceText.set(group.sourceText, error);
      for (const element of group.members) {
        const record = this.records.get(element);
        if (!record || record.outcome) continue;
        record.outcome = { kind: 'error', error };
        record.outcomeAt = performance.now();
      }
    }
  }

  private async resolveCandidateGroups(
    sessionId: string,
    groups: readonly CandidateGroup[],
  ): Promise<CandidateResolution> {
    if (groups.length === 0) {
      return { skippedIds: [], cachedTranslations: {}, missIds: [] };
    }
    return this.resolveCandidates(
      sessionId,
      groups.map((group) => ({
        id: group.id,
        text: group.sourceText,
        declaredLanguage: group.declaredLanguage,
      })),
    );
  }

  /** Converts one resolved priority lane into DOM records and scheduler work. */
  private applyCandidateResolution(
    groups: readonly CandidateGroup[],
    resolution: CandidateResolution,
    activeGroups: Map<string, ActiveTranslationGroup>,
    expectedSegmentsByGroup: Map<string, TranslationSegment[]>,
    scheduler: TranslationScheduler,
    renderQueue: ReadingWindowRenderCoordinator,
    completedTranslationsBySourceText: Map<string, string>,
    skippedSourceTexts: Set<string>,
    markStale: () => void,
  ): void {
    const skippedIds = new Set(resolution.skippedIds);
    const missIds = new Set(resolution.missIds);
    const scheduledUnits: ScheduledTranslationUnit[] = [];

    for (const group of groups) {
      if (skippedIds.has(group.id)) {
        skippedSourceTexts.add(group.sourceText);
        for (const element of group.members) {
          const slot = this.ensureOrderedRenderSlot(renderQueue, element);
          const record = this.records.get(element);
          if (record) this.discardRecord(record, true);
          slot.record = undefined;
          slot.skipped = true;
        }
        continue;
      }
      const cached = resolution.cachedTranslations[group.id];
      if (cached === undefined && !missIds.has(group.id)) {
        throw new Error('候选文本解析结果不完整');
      }

      const records: TranslationRecord[] = [];
      for (const element of group.members) {
        const slot = this.ensureOrderedRenderSlot(renderQueue, element);
        if (!element.isConnected || getElementSourceText(element) !== group.sourceText) {
          slot.skipped = true;
          markStale();
          continue;
        }
        const record = this.records.get(element) ?? this.createRecord(element, group.sourceText);
        slot.record = record;
        records.push(record);
        if (cached !== undefined) {
          record.outcome = { kind: 'translated', translatedText: cached };
        }
      }

      if (cached !== undefined) {
        completedTranslationsBySourceText.set(group.sourceText, cached);
        this.metrics.recordCacheHits(records.length);
        for (const record of records) record.outcomeAt = performance.now();
        continue;
      }
      if (records.length === 0) continue;
      const expected = createTranslationBatches([{ id: group.id, text: group.sourceText }], {
        maxCharacters: TRANSLATION_BATCH_PROFILES.visible.maxCharacters,
        maxItems: Number.MAX_SAFE_INTEGER,
      }).segments;
      expectedSegmentsByGroup.set(group.id, expected);
      const checkpoint: TranslationCheckpoint = {
        configurationId: this.sessionConfigurations.get(this.mainSessionId!)!,
        sourceText: group.sourceText,
        translatedParts: {},
      };
      activeGroups.set(group.id, {
        id: group.id,
        sourceText: group.sourceText,
        records,
        checkpoint,
      });
      for (const record of records) record.checkpoint = checkpoint;
      scheduledUnits.push({
        id: group.id,
        text: group.sourceText,
        priority: group.priority,
        order: group.order,
      });
    }

    scheduler.enqueue(scheduledUnits);
    this.flushOrderedRenderQueue(renderQueue);
    this.consumeObservedMutations();
    this.syncStatusCounts();
  }

  /** Resolves page-authored mutations into the active scheduler instead of restarting the page. */
  private async enqueueDynamicContent(
    pass: ActiveTranslationPass,
    roots: readonly HTMLElement[],
  ): Promise<void> {
    const ordered = [...roots].sort((left, right) =>
      left.compareDocumentPosition(right) & DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
    );
    for (const root of ordered) {
      if (!root.isConnected || this.mainSessionId !== pass.sessionId) continue;
      for await (const elements of discoverTranslatableElements(root, {
        url: location.href,
        signal: this.discoveryAbort.signal,
      })) {
        if (this.mainSessionId !== pass.sessionId) return;
        await this.enqueueDiscoveredElements(pass, elements);
      }
    }
  }

  /** Initial discovery and dynamic content attach to the same session-wide deduplication groups. */
  private async enqueueDiscoveredElements(
    pass: ActiveTranslationPass,
    elements: readonly HTMLElement[],
  ): Promise<void> {
    if (this.mainSessionId !== pass.sessionId) return;
    const collection = this.createCandidateGroups(elements);
    const newGroups: CandidateGroup[] = [];
    for (const discovered of collection.groups) {
      const existing = pass.groupsBySourceText.get(discovered.sourceText);
      if (!existing) {
        pass.groupsBySourceText.set(discovered.sourceText, discovered);
        for (const member of discovered.members) {
          this.ensureOrderedRenderSlot(pass.renderQueue, member);
        }
        newGroups.push(discovered);
        continue;
      }
      this.attachMembersToExistingGroup(pass, existing, discovered.members);
      if (discovered.priority === 'visible' && existing.priority !== 'visible') {
        existing.priority = 'visible';
        pass.scheduler.promote([existing.id], 'visible');
        this.promoteBackgroundBatches(new Set([existing.id]));
      }
    }
    if (newGroups.length === 0) return;

    this.prepareCandidateRecords(newGroups, pass.renderQueue, pass.markStale);
    pass.priorityObserver?.observe(newGroups.filter((group) => group.priority !== 'visible'));

    await this.resolveCandidateChunks(pass, newGroups);
  }

  /** Shares the current page-session result when dynamic DOM repeats an existing source. */
  private attachMembersToExistingGroup(
    pass: ActiveTranslationPass,
    group: CandidateGroup,
    members: readonly HTMLElement[],
  ): void {
    if (pass.skippedSourceTexts.has(group.sourceText)) return;
    const translatedText = pass.completedTranslationsBySourceText.get(group.sourceText);
    const failedError = pass.failedErrorsBySourceText.get(group.sourceText);
    const activeGroup = pass.activeGroups.get(group.id);
    const activePhase = activeGroup?.records.some((record) => record.phase === 'pending')
      ? 'pending'
      : 'queued';

    for (const member of members) {
      if (this.records.has(member)) continue;
      const slot = this.ensureOrderedRenderSlot(pass.renderQueue, member);
      if (!member.isConnected || getElementSourceText(member) !== group.sourceText) {
        slot.skipped = true;
        pass.markStale();
        continue;
      }
      if (translatedText === undefined && failedError === undefined && !activeGroup) {
        group.members.push(member);
        continue;
      }
      const record = this.createRecord(member, group.sourceText);
      slot.record = record;
      // A late duplicate shares settled parts, but keeps its own DOM retry lifecycle.
      if (translatedText === undefined) record.checkpoint = activeGroup?.checkpoint;
      if (translatedText !== undefined) {
        record.outcome = { kind: 'translated', translatedText };
        record.outcomeAt = performance.now();
      } else if (failedError !== undefined) {
        record.outcome = { kind: 'error', error: failedError };
        record.outcomeAt = performance.now();
      } else if (activeGroup) {
        record.phase = activePhase;
        activeGroup.records.push(record);
        if (activePhase === 'pending') renderTranslationPending(member, record.id);
      }
    }
    this.flushOrderedRenderQueue(pass.renderQueue);
    this.consumeObservedMutations();
    this.syncStatusCounts();
  }

  private observePriorityPromotions(
    backgroundGroups: readonly CandidateGroup[],
    scheduler: TranslationScheduler,
  ): ActiveTranslationPass['priorityObserver'] {
    if (typeof IntersectionObserver === 'undefined') return undefined;
    const groupByElement = new Map<Element, CandidateGroup>();
    const observer = new IntersectionObserver(
      (entries) => {
        const promotedIds = new Set<string>();
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const group = groupByElement.get(entry.target);
          if (!group) continue;
          // Preflight may still be running; carry promotion into the eventual enqueue call.
          group.priority = 'visible';
          promotedIds.add(group.id);
          if (entry.target instanceof HTMLElement) this.promoteReadingSlot(entry.target);
          observer.unobserve(entry.target);
        }
        scheduler.promote([...promotedIds], 'visible');
        this.promoteBackgroundBatches(promotedIds);
      },
      { root: null, rootMargin: '0px', threshold: 0 },
    );
    const observe = (groups: readonly CandidateGroup[]) => {
      for (const group of groups) {
        for (const member of group.members) {
          const record = this.records.get(member);
          if (!record || record.phase !== 'queued') continue;
          groupByElement.set(member, group);
          observer.observe(member);
        }
      }
    };
    observe(backgroundGroups);
    return { observe, disconnect: () => observer.disconnect() };
  }

  /** A unit may already be waiting inside the provider queue, beyond the page scheduler. */
  private promoteBackgroundBatches(groupIds: ReadonlySet<string>): void {
    if (!this.mainSessionId) return;
    const batchIds: string[] = [];
    for (const [batchId, receiver] of this.batchReceivers) {
      if (receiver.sessionId !== this.mainSessionId || receiver.priority === 'visible') continue;
      if (![...receiver.groupIds].some((id) => groupIds.has(id))) continue;
      receiver.priority = 'visible';
      batchIds.push(batchId);
    }
    if (batchIds.length)
      void sendRuntimeMessage<void>({
        type: 'PROMOTE_TRANSLATION_BATCHES',
        sessionId: this.mainSessionId,
        batchIds,
        priority: 'visible',
      });
  }

  /** Move only uncommitted nodes: newly visible text must not wait behind an old background lane. */
  private promoteReadingSlot(element: HTMLElement): void {
    const queue = this.activePass?.renderQueue;
    const slot = queue?.slotByElement.get(element);
    if (!queue || !slot) return;
    for (const priority of ['readAhead', 'background'] as const) {
      const lane = queue.lanes[priority];
      const index = lane.slots.indexOf(slot);
      if (index < lane.nextIndex) continue;
      lane.slots.splice(index, 1);
      queue.slotByElement.delete(element);
      const moved = this.ensureOrderedRenderSlot(queue, element);
      moved.record = slot.record;
      moved.skipped = slot.skipped;
      this.flushOrderedRenderQueue(queue);
      return;
    }
  }

  private async resolveCandidates(
    sessionId: string,
    candidates: readonly TranslationCandidate[],
  ): Promise<CandidateResolution> {
    const finish = this.metrics.start('cache');
    try {
      const response = await sendPreflightMessage<CandidateResolution>(
        { type: 'RESOLVE_TRANSLATION_CANDIDATES', sessionId, candidates: [...candidates] },
        '解析翻译候选',
      );
      if (!response.ok) throw new Error(response.error);
      return response.data;
    } finally {
      finish();
    }
  }

  private storeCacheEntries(sessionId: string, entries: TranslationCacheWrite[]): void {
    if (entries.length === 0) return;
    let writes = this.sessionCacheWrites.get(sessionId);
    if (!writes) {
      writes = new Set();
      this.sessionCacheWrites.set(sessionId, writes);
    }
    const pending = writes;
    const write = sendPreflightMessage<void>(
      { type: 'STORE_TRANSLATION_CACHE', sessionId, entries },
      '写入翻译缓存',
    )
      .then((result) => {
        if (!result.ok) throw new Error(result.error);
      })
      .catch(() => {
        /* Persistence is best effort; the background reports database failures. */
      })
      .finally(() => pending.delete(write));
    pending.add(write);
  }

  /** Keep the captured background context alive for writes, independently from page completion. */
  private async closeSessionAfterCacheWrites(sessionId: string): Promise<void> {
    const writes = this.sessionCacheWrites.get(sessionId);
    if (writes?.size) await Promise.allSettled(writes);
    this.sessionCacheWrites.delete(sessionId);
    await this.endTranslationSession(sessionId);
    this.sessionConfigurations.delete(sessionId);
  }

  /** Captures provider, prompt and target language once before any page work is dispatched. */
  private async beginTranslationSession(sessionId: string, profileId: string): Promise<void> {
    const response = await sendPreflightMessage<TranslationSessionInfo>(
      {
        type: 'BEGIN_TRANSLATION_SESSION',
        sessionId,
        profileId,
      },
      '创建翻译会话',
    );
    if (!response.ok) throw new Error(response.error);
    if (!response.data?.configurationId) throw new Error('翻译会话缺少配置指纹');
    this.sessionConfigurations.set(sessionId, response.data.configurationId);
  }

  private async endTranslationSession(sessionId: string): Promise<void> {
    try {
      await sendPreflightMessage<void>(
        { type: 'END_TRANSLATION_SESSION', sessionId },
        '清理翻译会话',
      );
    } catch {
      // Session storage is ephemeral; failed cleanup must not overwrite a completed translation.
    }
  }

  private observeDynamicContent(): void {
    this.observer?.disconnect();
    this.observer = new MutationObserver((mutations) => this.handlePageMutations(mutations));
    this.observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'lang', 'translate'],
    });
  }

  /** Drain without dropping page-authored changes sharing a task with our rendering. */
  private consumeObservedMutations(): void {
    const mutations = this.observer?.takeRecords();
    if (mutations?.length) this.handlePageMutations(mutations);
  }

  private handlePageMutations(mutations: MutationRecord[]): void {
    let requiresTranslation = false;
    let removedRecord = false;
    for (const mutation of mutations) {
      const targetElement = getMutationTargetElement(mutation.target);
      if (targetElement?.closest('[data-justranslate-translation]')) continue;
      if (
        mutation.type === 'attributes' &&
        targetElement?.hasAttribute('data-justranslate-source-content')
      ) {
        continue;
      }
      const source = targetElement?.closest<HTMLElement>('[data-justranslate-source]') ?? null;
      if (source && mutation.type !== 'attributes') {
        const record = this.records.get(source);
        // Wrapping/moving the original nodes and replacing only the translation
        // does not change the source. Never discard unrelated records to suppress it.
        if (
          record &&
          this.isRecordSourceCurrent(record) &&
          source.querySelector(':scope > [data-justranslate-translation]')
        )
          continue;
        const parent = source.parentElement;
        if (source.isConnected) this.activePass?.markStale();
        if (record) this.discardRecord(record, true);
        else restoreSourceElement(source);
        // Restoring a raw-prose anchor unwraps it. Rescan its still-connected owner, not the
        // detached anchor; otherwise the changed original text would never be discovered again.
        if (source.isConnected) this.addDynamicRoot(source);
        else if (parent) this.addDynamicRoot(parent);
        requiresTranslation = true;
      }
      if (mutation.type === 'attributes' && targetElement instanceof HTMLElement) {
        this.addDynamicRoot(targetElement);
        requiresTranslation = true;
      }
      if (mutation.type === 'characterData' && targetElement) {
        this.addDynamicRoot(
          targetElement.closest<HTMLElement>(DYNAMIC_READING_ROOT_SELECTOR) ??
            (targetElement as HTMLElement),
        );
        requiresTranslation = true;
      }
      for (const addedNode of mutation.addedNodes) {
        const addedElement = getMutationTargetElement(addedNode);
        if (!addedElement || addedElement.closest('[data-justranslate-translation]')) continue;
        this.addDynamicRoot(
          addedElement.closest<HTMLElement>(DYNAMIC_READING_ROOT_SELECTOR) ??
            (addedElement as HTMLElement),
        );
        requiresTranslation = true;
      }
      for (const removedNode of mutation.removedNodes) {
        if (removedNode.nodeType !== 1) continue;
        const removedElement = removedNode as Element;
        for (const record of [...this.records.values()]) {
          if (removedElement === record.element || removedElement.contains(record.element)) {
            this.discardRecord(record, false);
            removedRecord = true;
          }
        }
      }
    }
    if (removedRecord) this.syncStatusCounts();
    if (removedRecord || requiresTranslation) this.withdrawOrphanedGroups();
    if (!requiresTranslation) return;
    this.scheduleDynamicTranslation(DYNAMIC_CONTENT_DEBOUNCE_MS);
  }

  /** Drop deduplicated work only when its final live consumer has gone; sibling consumers survive. */
  private withdrawOrphanedGroups(): void {
    const pass = this.activePass;
    if (!pass) return;
    for (const [id, group] of pass.activeGroups) {
      if (
        group.records.some(
          (record) =>
            this.records.get(record.element) === record && this.isRecordSourceCurrent(record),
        )
      )
        continue;
      if (group.records.some((record) => record.element.isConnected)) pass.markStale();
      pass.activeGroups.delete(id);
      pass.groupsBySourceText.delete(group.sourceText);
      pass.expectedSegmentsByGroup.delete(id);
    }
    for (const [batchId, receiver] of this.batchReceivers) {
      if (receiver.sessionId !== pass.sessionId || receiver.cancelled) continue;
      if ([...receiver.groupIds].some((id) => pass.activeGroups.has(id))) continue;
      receiver.cancelled = true;
      void sendRuntimeMessage<void>({
        type: 'CANCEL_TRANSLATION_BATCH',
        sessionId: pass.sessionId,
        batchId,
      });
    }
    this.flushOrderedRenderQueue(pass.renderQueue);
  }

  private scheduleDynamicTranslation(delayMs: number): void {
    window.clearTimeout(this.observerTimer);
    if (this.dynamicRoots.size === 0) return;
    const earliest = Math.min(...this.dynamicRoots.values()) + delayMs;
    this.observerTimer = window.setTimeout(
      () => {
        const pass = this.activePass;
        // A retry has no whole-page scheduler. Retain roots until it settles instead of losing them.
        if (this.hasActiveOperation() && !pass) return;
        const roots = this.takeDynamicRoots();
        if (roots.length === 0) {
          this.scheduleDynamicTranslation(DYNAMIC_CONTENT_DEBOUNCE_MS);
          return;
        }
        if (pass && this.mainSessionId === pass.sessionId) {
          const discovery = this.enqueueDynamicContent(pass, roots)
            .catch((error: unknown) => {
              if (this.mainSessionId !== pass.sessionId) return;
              this.status.phase = 'error';
              this.status.error = getErrorMessage(error);
            })
            .finally(() => {
              pass.pendingDiscoveries.delete(discovery);
            });
          pass.pendingDiscoveries.add(discovery);
          this.scheduleDynamicTranslation(DYNAMIC_CONTENT_DEBOUNCE_MS);
          return;
        }
        if (
          !this.hasActiveOperation() &&
          (this.status.phase === 'complete' || this.status.phase === 'error')
        ) {
          void this.startTranslation(roots);
        }
      },
      Math.max(0, earliest - performance.now()),
    );
  }

  private disconnectObserver(clearPending = true): void {
    this.observer?.disconnect();
    this.observer = null;
    window.clearTimeout(this.observerTimer);
    if (clearPending) this.dynamicRoots.clear();
  }

  /** Coalesces overlapping mutation roots so one subtree is never scanned twice. */
  private addDynamicRoot(root: HTMLElement): void {
    if (!root.isConnected) return;
    for (const existing of this.dynamicRoots.keys()) {
      if (existing.contains(root)) {
        this.dynamicRoots.set(existing, performance.now());
        return;
      }
      if (root.contains(existing)) this.dynamicRoots.delete(existing);
    }
    this.dynamicRoots.set(root, performance.now());
  }

  private takeDynamicRoots(): HTMLElement[] {
    const now = performance.now();
    const roots: HTMLElement[] = [];
    for (const [root, changedAt] of this.dynamicRoots) {
      if (!root.isConnected) this.dynamicRoots.delete(root);
      else if (now - changedAt >= DYNAMIC_CONTENT_DEBOUNCE_MS) {
        roots.push(root);
        this.dynamicRoots.delete(root);
      }
    }
    return roots;
  }

  private resumeDynamicObserver(): void {
    if (this.dynamicContentEnabled && !this.hasActiveOperation()) {
      if (!this.observer) this.observeDynamicContent();
      this.scheduleDynamicTranslation(DYNAMIC_CONTENT_DEBOUNCE_MS);
    }
  }

  private async readValidSettings(): Promise<PublicTranslatorSettings> {
    const settingsResult = await sendPreflightMessage<PublicTranslatorSettings>(
      { type: 'GET_PUBLIC_SETTINGS' },
      '读取翻译配置',
    );
    if (!settingsResult.ok) throw new Error(settingsResult.error);
    if (!settingsResult.data.configured) {
      throw new Error('请先在插件设置中补全当前翻译配置（包括翻译 Prompt）');
    }
    return settingsResult.data;
  }

  private createRecord(element: HTMLElement, sourceText: string): TranslationRecord {
    const record: TranslationRecord = {
      id: `unit-${this.nextUnitNumber++}`,
      element,
      sourceText,
      phase: 'queued',
      generation: 0,
    };
    this.records.set(element, record);
    return record;
  }

  private markRecordError(record: TranslationRecord, error: string): void {
    if (this.records.get(record.element) !== record) return;
    record.phase = 'error';
    record.error = error;
    renderTranslationError(record.element, record.id);
  }

  private isRecordSourceCurrent(record: TranslationRecord): boolean {
    return record.element.isConnected && getElementSourceText(record.element) === record.sourceText;
  }

  private discardRecord(record: TranslationRecord, restoreSource: boolean): void {
    if (this.records.get(record.element) !== record) return;
    this.records.delete(record.element);
    record.generation += 1;
    if (restoreSource && record.element.isConnected) restoreSourceElement(record.element);
  }

  private purgeDisconnectedRecords(): void {
    for (const record of this.records.values()) {
      if (!record.element.isConnected) this.discardRecord(record, false);
    }
  }

  private isCurrentRetry(
    record: TranslationRecord,
    sessionId: string,
    generation: number,
  ): boolean {
    return (
      this.retrySessionIds.has(sessionId) &&
      this.records.get(record.element) === record &&
      record.generation === generation &&
      record.element.isConnected
    );
  }

  private hasActiveOperation(): boolean {
    return this.mainSessionId !== null || this.retrySessionIds.size > 0;
  }

  private settleStatus(fallbackError?: string): void {
    this.syncStatusCounts();
    if (this.hasActiveOperation()) {
      this.status.phase = 'translating';
      this.status.error = undefined;
      return;
    }
    const firstFailedError = [...this.records.values()].find(
      (record) => record.phase === 'error',
    )?.error;
    if (this.status.failed > 0 || fallbackError) {
      this.status.phase = 'error';
      this.status.error = firstFailedError ?? fallbackError;
      return;
    }
    this.status.phase = 'complete';
    this.status.error = undefined;
  }

  private syncStatusCounts(): void {
    let translated = 0;
    let failed = 0;
    for (const record of this.records.values()) {
      if (record.phase === 'translated') translated += 1;
      if (record.phase === 'error') failed += 1;
    }
    this.status.translated = translated;
    this.status.failed = failed;
    this.status.total = this.records.size;
  }
}

function getElementTranslationPriority(element: HTMLElement): TranslationPriority {
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 768;
  const bounds = element.getBoundingClientRect();
  if (bounds.bottom >= 0 && bounds.top <= viewportHeight) return 'visible';
  if (bounds.top > viewportHeight && bounds.top <= viewportHeight * 2) return 'readAhead';
  return 'background';
}

function getPriorityRank(priority: TranslationPriority): number {
  if (priority === 'visible') return 0;
  if (priority === 'readAhead') return 1;
  return 2;
}

function getMutationTargetElement(target: Node): Element | null {
  // nodeType is realm-independent, unlike the page's global Node constructor.
  return target.nodeType === 1 ? (target as Element) : target.parentElement;
}

/** Bounds control-plane calls so a lost service-worker response cannot leave page spinners forever. */
function sendPreflightMessage<T>(request: RuntimeRequest, operation: string): Promise<Result<T>> {
  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      reject(new Error(`${operation}超时，请确认插件后台运行正常`));
    }, PREFLIGHT_MESSAGE_TIMEOUT_MS);
    void sendRuntimeMessage<T>(request).then(
      (result) => {
        window.clearTimeout(timeoutId);
        resolve(result);
      },
      (error: unknown) => {
        window.clearTimeout(timeoutId);
        reject(error instanceof Error ? error : new Error(getErrorMessage(error)));
      },
    );
  });
}
