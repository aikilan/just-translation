import { message, LocalizedError } from '../shared/i18n';
import { DEFAULT_SETTINGS } from '../shared/settings';
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
  /** Refresh viewport discovery and pending priorities before filling available worker slots. */
  beforeDispatch?: () => Promise<void>;
  /** Includes visible candidate preflight and DOM commits outside the worker pool. */
  canDispatchBackground?: () => boolean;
}

/** Internal control flow: the backend returned a batch before its first HTTP submission. */
export class TranslationBatchDeferredError extends Error {}

interface PendingSegment {
  segment: TranslationSegment;
  priority: TranslationPriority;
  order: number;
  queuedAt: number;
}

const PRIORITIES: readonly TranslationPriority[] = ['visible', 'readAhead', 'background'];
const SMALLEST_SEGMENT_LIMIT = 1_200;
const COALESCE_WINDOW_MS = 20;

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
  private readonly active = new Map<ScheduledTranslationBatch, PendingSegment[]>();

  private get activeCount(): number {
    return this.active.size;
  }
  private get activeVisibleCount(): number {
    return [...this.active.values()].filter((items) =>
      items.some((item) => item.priority === 'visible'),
    ).length;
  }
  private refreshing = false;
  private refreshAgain = false;
  private stopped = false;
  private firstError: unknown;
  private dispatched = false;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private finishing = false;

  constructor(
    private readonly worker: (batch: ScheduledTranslationBatch) => Promise<void>,
    private readonly options: TranslationSchedulerOptions = {},
  ) {
    this.concurrency = options.concurrency ?? DEFAULT_SETTINGS.translationConcurrency;
    if (!Number.isInteger(this.concurrency) || this.concurrency < 1) {
      throw new LocalizedError(message('翻译调度并发数必须是正整数'));
    }
  }

  get hasQueuedVisibleWork(): boolean {
    return this.pending.some((item) => item.priority === 'visible');
  }

  get hasQueuedWork(): boolean {
    return this.pending.length > 0;
  }

  get isIdle(): boolean {
    return this.pending.length === 0 && this.activeCount === 0 && !this.refreshing;
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

  /** Updates queued order and active bookkeeping; deferred segments retain the latest rank. */
  updatePriorities(
    units: readonly Pick<ScheduledTranslationUnit, 'id' | 'priority' | 'order'>[],
  ): void {
    const byId = new Map(units.map((unit) => [unit.id, unit]));
    for (const item of [...this.pending, ...[...this.active.values()].flat()]) {
      const unit = byId.get(item.segment.unitId);
      if (!unit) continue;
      item.priority = unit.priority;
      item.order = unit.order;
    }
    this.sortPending();
  }

  /** Wakes a queue blocked on controller preflight, layout changes, or render completion. */
  refresh(): void {
    this.pump();
  }

  waitForIdle(): Promise<void> {
    // No more initial input is expected: flush the final partial batch immediately.
    this.finishing = true;
    // Waiting is not new input; do not schedule another refresh behind one already in progress.
    if (!this.refreshing) this.pump();
    if (this.isIdle) {
      return this.firstError === undefined
        ? Promise.resolve()
        : Promise.reject(toError(this.firstError));
    }
    return new Promise((resolve, reject) => this.idleWaiters.add({ resolve, reject }));
  }

  /** Drops queued work and reports an optional failure; the controller owns HTTP cancellation. */
  stop(error?: unknown): void {
    this.firstError ??= error;
    this.stopped = true;
    this.pending.length = 0;
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.flushIdleWaiters();
  }

  private pump(): void {
    if (this.stopped || this.activeCount >= this.concurrency) return;
    if (this.refreshing) {
      this.refreshAgain = true;
      return;
    }
    if (!this.options.beforeDispatch) {
      this.dispatch();
      return;
    }
    this.refreshing = true;
    void this.options
      .beforeDispatch()
      .catch((error: unknown) => {
        this.firstError ??= error;
        this.stop();
      })
      .finally(() => {
        const again = this.refreshAgain;
        this.refreshAgain = false;
        this.refreshing = false;
        this.dispatch();
        if (again) this.pump();
      });
  }

  private dispatch(): void {
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    while (!this.stopped && this.activeCount < this.concurrency && this.pending.length > 0) {
      // Visible work must settle before offscreen requests may consume free slots.
      if (
        this.pending[0].priority !== 'visible' &&
        (this.activeVisibleCount > 0 || this.options.canDispatchBackground?.() === false)
      )
        break;
      const remaining = COALESCE_WINDOW_MS - (performance.now() - this.pending[0].queuedAt);
      if (this.dispatched && !this.finishing && remaining > 0 && !this.hasFullBatch()) {
        this.flushTimer = setTimeout(() => this.pump(), remaining);
        break;
      }
      const batch = this.takeNextBatch();
      this.dispatched = true;
      void this.worker(batch)
        .catch((error: unknown) => {
          if (error instanceof TranslationBatchDeferredError) {
            // Reuse the exact segments and their latest priority; deferral is not a translation failure.
            if (!this.stopped) {
              this.pending.push(...this.active.get(batch)!);
              this.sortPending();
            }
          } else this.firstError ??= error;
        })
        .finally(() => {
          this.active.delete(batch);
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
    const items: PendingSegment[] = [];
    let characters = 0;
    while (this.pending.length > 0 && segments.length < profile.maxItems) {
      const item = this.pending[0];
      if (item.priority !== priority) break;
      const nextCharacters = characters + item.segment.text.length;
      if (segments.length > 0 && nextCharacters > profile.maxCharacters) break;
      segments.push(item.segment);
      items.push(item);
      characters = nextCharacters;
      this.pending.splice(0, 1);
    }
    const batch = { priority, segments };
    this.active.set(batch, items);
    return batch;
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
  return value instanceof Error ? value : new LocalizedError(String(value));
}
