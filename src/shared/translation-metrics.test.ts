import { describe, expect, it } from 'vitest';
import { TranslationMetrics } from './translation-metrics';

describe('translation timing diagnostics', () => {
  it('distinguishes stream content, validated segments and actual rendering', () => {
    const metrics = new TranslationMetrics(() => 0);
    metrics.record('firstContent', 100);
    metrics.record('firstValidSegment', 400);
    metrics.record('request', 2_000);
    metrics.record('orderedWait', 50);
    expect(metrics.snapshot().stages).toMatchObject({
      firstContent: { count: 1, totalMs: 100 },
      firstValidSegment: { count: 1, totalMs: 400 },
      request: { count: 1, totalMs: 2_000 },
      orderedWait: { count: 1, totalMs: 50 },
    });
  });
  it('records first readable output and logical batch utilization without retaining text', () => {
    let clock = 100;
    const metrics = new TranslationMetrics(() => clock);
    metrics.recordBatch(4, 200);
    metrics.recordBatch(1, 40);
    clock = 180;
    metrics.markFirstTranslation();
    clock = 250;
    metrics.markFirstTranslation();
    metrics.recordCacheHits(3);
    expect(metrics.snapshot()).toMatchObject({
      firstTranslationMs: 80,
      batches: { count: 2, segments: 5, sourceCharacters: 240 },
      cacheHitNodes: 3,
    });
  });
  it('freezes elapsed time when the session completes or stops', () => {
    let clock = 0;
    const metrics = new TranslationMetrics(() => clock);
    clock = 50;
    metrics.finish();
    clock = 500;
    metrics.finish();
    expect(metrics.snapshot().elapsedMs).toBe(50);
  });
  it('aggregates bounded numeric stages without retaining source text or credentials', () => {
    let clock = 100;
    const metrics = new TranslationMetrics(() => clock);
    const finish = metrics.start('discovery');
    clock += 12;
    finish();
    finish();
    for (let i = 0; i < 1_000; i += 1) metrics.record('request', 5);
    expect(metrics.snapshot()).toEqual({
      elapsedMs: 12,
      firstTranslationMs: undefined,
      batches: { count: 0, segments: 0, sourceCharacters: 0 },
      cacheHitNodes: 0,
      stages: {
        discovery: { count: 1, totalMs: 12, maxMs: 12 },
        request: { count: 1_000, totalMs: 5_000, maxMs: 5 },
      },
    });
  });
});
