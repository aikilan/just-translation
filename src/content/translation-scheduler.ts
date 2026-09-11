import { createTranslationBatches, type TranslationSegment } from '../shared/batching';
import type { TranslationPriority } from '../shared/messages';

export type { TranslationPriority } from '../shared/messages';

export interface TranslationBatchProfile {
  maxCharacters: number;
  maxItems: number;
}

export interface ScheduledTranslationUnit {
  id: string;
  text: string;
  priority: TranslationPriority;
  order: number;
}

export interface ScheduledTranslationBatch {
  priority: TranslationPriority;
  segments: TranslationSegment[];
}

export interface TranslationSchedulerOptions {
  concurrency?: number;
}

interface PendingSegment {
  segment: TranslationSegment;
  priority: TranslationPriority;
  order: number;
  queuedAt: number;
}

const PRIORITIES: readonly TranslationPriority[] = ['visible', 'readAhead', 'background'];
const SMALLEST_SEGMENT_LIMIT = 1_200;
const COALESCE_WINDOW_MS = 20;

export const INTERNAL_TRANSLATION_CONCURRENCY = 6;

export const TRANSLATION_BATCH_PROFILES: Readonly<
  Record<TranslationPriority, TranslationBatchProfile>
> = {
  // Bound request work even with SSE; long batches still occupy provider slots until completion.
  visible: { maxCharacters: 1_200, maxItems: 4 },
  readAhead: { maxCharacters: 1_800, maxItems: 4 },
  background: { maxCharacters: 2_400, maxItems: 4 },
};

/**
 * Dynamic priority worker pool. Units are split to the smallest foreground size once,
 * then packed according to the priority they have when a worker slot becomes available.
 */
export class TranslationScheduler {
  private readonly concurrency: number;
  private readonly pending: PendingSegment[] = [];
  private readonly knownUnitIds = new Set<string>();
  private readonly idleWaiters = new Set<{
    resolve: () => void;
    reject: (error: unknown) => void;
  }>();
  private activeCount = 0;
  private activeNonVisibleCount = 0;
  private stopped = false;
  private firstError: unknown;
  private dispatched = false;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private finishing = false;

  constructor(
    private readonly worker: (batch: ScheduledTranslationBatch) => Promise<void>,
    options: TranslationSchedulerOptions = {},
  ) {
    this.concurrency = options.concurrency ?? INTERNAL_TRANSLATION_CONCURRENCY;
    if (!Number.isInteger(this.concurrency) || this.concurrency < 1) {
      throw new Error('翻译调度并发数必须是正整数');
    }
  }

  get isIdle(): boolean {
    return this.pending.length === 0 && this.activeCount === 0;
  }

  /** Adds new unique units and immediately fills free worker slots by priority. */
  enqueue(units: readonly ScheduledTranslationUnit[]): void {
    if (this.stopped) return;
    if (this.isIdle) this.finishing = false;
    for (const unit of units) {
      if (this.knownUnitIds.has(unit.id)) continue;
      this.knownUnitIds.add(unit.id);
      const prepared = createTranslationBatches([{ id: unit.id, text: unit.text }], {
        maxCharacters: SMALLEST_SEGMENT_LIMIT,
        maxItems: Number.MAX_SAFE_INTEGER,
      });
      for (const segment of prepared.segments) {
        this.pending.push({
          segment,
          priority: unit.priority,
          order: unit.order,
          queuedAt: performance.now(),
        });
      }
    }
    this.sortPending();
    this.pump();
  }

  /** Promotes only unsent segments; active requests are intentionally never aborted. */
  promote(unitIds: readonly string[], priority: TranslationPriority): void {
    if (this.stopped || unitIds.length === 0) return;
    const promotedIds = new Set(unitIds);
    const targetRank = PRIORITIES.indexOf(priority);
    let changed = false;
    for (const item of this.pending) {
      if (!promotedIds.has(item.segment.unitId)) continue;
      if (PRIORITIES.indexOf(item.priority) <= targetRank) continue;
      item.priority = priority;
      changed = true;
    }
    if (changed) this.sortPending();
    this.pump();
  }

  waitForIdle(): Promise<void> {
    // No more initial input is expected: flush the final partial batch immediately.
    this.finishing = true;
    this.pump();
    if (this.isIdle) {
      return this.firstError === undefined
        ? Promise.resolve()
        : Promise.reject(toError(this.firstError));
    }
    return new Promise((resolve, reject) => this.idleWaiters.add({ resolve, reject }));
  }

  /** Drops queued work. The controller separately aborts requests already in flight. */
  stop(): void {
    this.stopped = true;
    this.pending.length = 0;
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.flushIdleWaiters();
  }

  private pump(): void {
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    while (!this.stopped && this.activeCount < this.concurrency && this.pending.length > 0) {
      // Leave one dispatch slot for a newly visible unit; background work still drains to completion.
      if (
        this.pending[0].priority !== 'visible' &&
        this.activeNonVisibleCount >= Math.max(1, this.concurrency - 1)
      )
        break;
      const remaining = COALESCE_WINDOW_MS - (performance.now() - this.pending[0].queuedAt);
      if (this.dispatched && !this.finishing && remaining > 0 && !this.hasFullBatch()) {
        this.flushTimer = setTimeout(() => this.pump(), remaining);
        break;
      }
      const batch = this.takeNextBatch();
      this.dispatched = true;
      this.activeCount += 1;
      if (batch.priority !== 'visible') this.activeNonVisibleCount += 1;
      void this.worker(batch)
        .catch((error: unknown) => {
          this.firstError ??= error;
        })
        .finally(() => {
          this.activeCount -= 1;
          if (batch.priority !== 'visible') this.activeNonVisibleCount -= 1;
          this.pump();
          this.flushIdleWaiters();
        });
    }
    this.flushIdleWaiters();
  }

  /** A following item that cannot fit also seals the batch; never wait to fill impossible space. */
  private hasFullBatch(): boolean {
    const priority = this.pending[0].priority;
    const profile = TRANSLATION_BATCH_PROFILES[priority];
    let characters = 0;
    let items = 0;
    for (const item of this.pending) {
      if (item.priority !== priority) break;
      characters += item.segment.text.length;
      items += 1;
      if (characters >= profile.maxCharacters || items >= profile.maxItems) return true;
    }
    return false;
  }

  private takeNextBatch(): ScheduledTranslationBatch {
    const priority = this.pending[0].priority;
    const profile = TRANSLATION_BATCH_PROFILES[priority];
    const segments: TranslationSegment[] = [];
    let characters = 0;
    while (this.pending.length > 0 && segments.length < profile.maxItems) {
      const item = this.pending[0];
      if (item.priority !== priority) break;
      const nextCharacters = characters + item.segment.text.length;
      if (segments.length > 0 && nextCharacters > profile.maxCharacters) break;
      segments.push(item.segment);
      characters = nextCharacters;
      this.pending.splice(0, 1);
    }
    return { priority, segments };
  }

  private sortPending(): void {
    this.pending.sort((left, right) => {
      const priorityDifference =
        PRIORITIES.indexOf(left.priority) - PRIORITIES.indexOf(right.priority);
      if (priorityDifference !== 0) return priorityDifference;
      if (left.order !== right.order) return left.order - right.order;
      return left.segment.partIndex - right.segment.partIndex;
    });
  }

  private flushIdleWaiters(): void {
    if (!this.isIdle) return;
    for (const waiter of this.idleWaiters) {
      if (this.firstError === undefined) waiter.resolve();
      else waiter.reject(this.firstError);
    }
    this.idleWaiters.clear();
  }
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
