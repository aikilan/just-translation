import { describe, expect, it, vi } from 'vitest';

import type { TranslationSegment } from '../shared/batching';
import {
  INTERNAL_TRANSLATION_CONCURRENCY,
  TRANSLATION_BATCH_PROFILES,
  TranslationScheduler,
  type ScheduledTranslationBatch,
  type ScheduledTranslationUnit,
} from './translation-scheduler';

describe('TranslationScheduler', () => {
  it('reserves one dispatch slot for new foreground work while background requests are waiting', async () => {
    const releases: Array<() => void> = [];
    const priorities: string[] = [];
    const scheduler = new TranslationScheduler((batch) => {
      priorities.push(batch.priority);
      return new Promise<void>((resolve) => releases.push(resolve));
    });
    scheduler.enqueue(createUnits('background', 28, 100, 0));
    expect(priorities).toEqual(Array<string>(5).fill('background'));
    scheduler.enqueue(createUnits('visible', 4, 100, 100));
    expect(priorities).toEqual([...Array<string>(5).fill('background'), 'visible']);
    scheduler.stop();
    releases.forEach((resolve) => resolve());
    await scheduler.waitForIdle();
  });
  it('starts the first item immediately but coalesces subsequent incremental arrivals', async () => {
    const sizes: number[] = [];
    const releases: Array<() => void> = [];
    const scheduler = new TranslationScheduler((batch) => {
      sizes.push(batch.segments.length);
      return new Promise<void>((resolve) => releases.push(resolve));
    });
    for (const unit of createUnits('background', 24, 50, 0)) scheduler.enqueue([unit]);
    expect(sizes[0]).toBe(1);
    const finished = scheduler.waitForIdle();
    while (!scheduler.isIdle) {
      releases.splice(0).forEach((resolve) => resolve());
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await finished;
    expect(sizes).toEqual([1, 4, 4, 4, 4, 4, 3]);
  });

  it('flushes an underfilled batch within a bounded window and cancels the timer on stop', async () => {
    vi.useFakeTimers();
    try {
      const dispatched = vi.fn().mockResolvedValue(undefined);
      const scheduler = new TranslationScheduler(dispatched);
      scheduler.enqueue(createUnits('visible', 1, 50, 0));
      await Promise.resolve();
      scheduler.enqueue(createUnits('background', 1, 50, 1));
      expect(dispatched).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(25);
      expect(dispatched).toHaveBeenCalledTimes(2);
      scheduler.enqueue(createUnits('readAhead', 1, 50, 2));
      scheduler.stop();
      await vi.runAllTimersAsync();
      expect(dispatched).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses small foreground batches and larger background batches', async () => {
    const dispatched: ScheduledTranslationBatch[] = [];
    const scheduler = new TranslationScheduler((batch) => {
      dispatched.push(batch);
      return Promise.resolve();
    });

    scheduler.enqueue([
      ...createUnits('visible', 5, 200, 0),
      ...createUnits('readAhead', 9, 150, 100),
      ...createUnits('background', 13, 200, 200),
    ]);
    await scheduler.waitForIdle();

    expect(TRANSLATION_BATCH_PROFILES).toEqual({
      visible: { maxCharacters: 1_200, maxItems: 4 },
      readAhead: { maxCharacters: 1_800, maxItems: 4 },
      background: { maxCharacters: 2_400, maxItems: 4 },
    });
    expect(INTERNAL_TRANSLATION_CONCURRENCY).toBe(6);
    for (const batch of dispatched) {
      const profile = TRANSLATION_BATCH_PROFILES[batch.priority];
      expect(batch.segments.length).toBeLessThanOrEqual(profile.maxItems);
      expect(
        batch.segments.reduce((sum, segment) => sum + segment.text.length, 0),
      ).toBeLessThanOrEqual(profile.maxCharacters);
    }
  });

  it('dispatches higher priorities first and never exceeds six active requests', async () => {
    const releases: Array<() => void> = [];
    const priorities: string[] = [];
    let active = 0;
    let maximumActive = 0;
    const scheduler = new TranslationScheduler(
      (batch) =>
        new Promise<void>((resolve) => {
          priorities.push(batch.priority);
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          releases.push(() => {
            active -= 1;
            resolve();
          });
        }),
    );

    scheduler.enqueue([
      ...createUnits('background', 25, 200, 200),
      ...createUnits('readAhead', 17, 150, 100),
      ...createUnits('visible', 9, 200, 0),
    ]);
    await vi.waitFor(() => expect(priorities).toHaveLength(6));

    expect(priorities).toEqual([
      'visible',
      'visible',
      'visible',
      'readAhead',
      'readAhead',
      'readAhead',
    ]);
    expect(maximumActive).toBe(6);

    while (releases.length > 0 || active > 0) {
      releases.shift()?.();
      await Promise.resolve();
    }
    await scheduler.waitForIdle();
    expect(maximumActive).toBe(6);
    expect(priorities.indexOf('readAhead')).toBeLessThan(priorities.indexOf('background'));
  });

  it('promotes a queued background batch when one of its units enters the viewport', async () => {
    const releases: Array<() => void> = [];
    const dispatched: ScheduledTranslationBatch[] = [];
    let resolveFutureBatchesImmediately = false;
    const scheduler = new TranslationScheduler(
      (batch) => {
        dispatched.push(batch);
        if (resolveFutureBatchesImmediately) return Promise.resolve();
        return new Promise<void>((resolve) => releases.push(resolve));
      },
      { concurrency: 1 },
    );
    const units = createUnits('background', 25, 200, 0);

    scheduler.enqueue(units);
    await vi.waitFor(() => expect(dispatched).toHaveLength(1));
    scheduler.promote([units[24].id], 'visible');
    releases.shift()?.();
    await vi.waitFor(() => expect(dispatched).toHaveLength(2));

    expect(dispatched[1].priority).toBe('visible');
    expect(getUnitIds(dispatched[1].segments)).toContain(units[24].id);

    resolveFutureBatchesImmediately = true;
    releases.shift()?.();
    await scheduler.waitForIdle();
  });
});

function createUnits(
  priority: ScheduledTranslationUnit['priority'],
  count: number,
  textLength: number,
  orderOffset: number,
): ScheduledTranslationUnit[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${priority}-${index}`,
    text: `${index}`.padEnd(textLength, 'x'),
    priority,
    order: orderOffset + index,
  }));
}

function getUnitIds(segments: readonly TranslationSegment[]): string[] {
  return [...new Set(segments.map((segment) => segment.unitId))];
}
