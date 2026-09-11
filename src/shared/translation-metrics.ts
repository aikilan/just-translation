/** Transport milestones are measured from HTTP admission, not time spent waiting in the queue. */
export type TranslationRequestStage = 'queue' | 'request' | 'firstContent' | 'firstValidSegment';
export type TranslationStage =
  'discovery' | 'preflight' | 'cache' | TranslationRequestStage | 'orderedWait' | 'render';
interface StageTiming {
  count: number;
  totalMs: number;
  maxMs: number;
}
export interface TranslationDiagnostics {
  elapsedMs: number;
  firstTranslationMs?: number;
  /** Logical content-script batches; provider retries/compensation are counted in request stages. */
  batches: { count: number; segments: number; sourceCharacters: number };
  cacheHitNodes: number;
  stages: Partial<Record<TranslationStage, StageTiming>>;
}

/** Fixed-size, local diagnostics: durations only, never URLs, prompts, source text or credentials. */
export class TranslationMetrics {
  private readonly startedAt: number;
  private finishedAt: number | undefined;
  private firstTranslationMs: number | undefined;
  private readonly batches = { count: 0, segments: 0, sourceCharacters: 0 };
  private cacheHitNodes = 0;
  private readonly stages: TranslationDiagnostics['stages'] = {};

  constructor(private readonly now: () => number = () => performance.now()) {
    this.startedAt = now();
  }

  start(stage: TranslationStage): () => void {
    const start = this.now();
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      this.record(stage, this.now() - start);
    };
  }

  record(stage: TranslationStage, durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    const entry = (this.stages[stage] ??= { count: 0, totalMs: 0, maxMs: 0 });
    entry.count += 1;
    entry.totalMs += durationMs;
    entry.maxMs = Math.max(entry.maxMs, durationMs);
  }

  markFirstTranslation(): void {
    if (this.finishedAt === undefined) this.firstTranslationMs ??= this.now() - this.startedAt;
  }

  recordBatch(segments: number, sourceCharacters: number): void {
    this.batches.count += 1;
    this.batches.segments += segments;
    this.batches.sourceCharacters += sourceCharacters;
  }

  recordCacheHits(nodes: number): void {
    this.cacheHitNodes += nodes;
  }

  snapshot(): TranslationDiagnostics {
    return {
      elapsedMs: (this.finishedAt ?? this.now()) - this.startedAt,
      firstTranslationMs: this.firstTranslationMs,
      batches: { ...this.batches },
      cacheHitNodes: this.cacheHitNodes,
      stages: structuredClone(this.stages),
    };
  }

  finish(): void {
    this.finishedAt ??= this.now();
  }
}
