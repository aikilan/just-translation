import { DEFAULT_SETTINGS } from '../shared/settings';
import { describe, expect, it, vi } from 'vitest';

import type { TranslationSegment } from '../shared/batching';
import {
  TRANSLATION_BATCH_PROFILES,
  TranslationScheduler,
  type ScheduledTranslationBatch,
  type ScheduledTranslationUnit,
} from './translation-scheduler';

describe('TranslationScheduler', () => {
  it('uses all six slots for background work and waits for a free slot for foreground', async () => {
    const releases: Array<() => void> = [];
    const priorities: string[] = [];
    const scheduler = new TranslationScheduler((batch) => {
      priorities.push(batch.priority);
      return new Promise<void>((resolve) => releases.push(resolve));
    });
    scheduler.enqueue(createUnits('background', 28, 100, 0));
    expect(priorities).toEqual(Array<string>(6).fill('background'));
    scheduler.enqueue(createUnits('visible', 4, 100, 100));
    expect(priorities).toHaveLength(6);
    releases.shift()!();
    await vi.waitFor(() => expect(priorities[6]).toBe('visible'));
    scheduler.stop();
    releases.forEach((resolve) => resolve());
    await scheduler.waitForIdle();
  });

  it('holds background work until every active foreground request settles', async () => {
    const releases: Array<() => void> = [];
    const batches: ScheduledTranslationBatch[] = [];
    const scheduler = new TranslationScheduler((batch) => {
      batches.push(batch);
      return new Promise<void>((resolve) => releases.push(resolve));
    });
    scheduler.enqueue([
      ...createUnits('visible', 5, 100, 0),
      ...createUnits('background', 4, 100, 5),
    ]);
    const work = scheduler.waitForIdle();
    expect(batches.map((batch) => batch.priority)).toEqual(['visible', 'visible']);
    releases.shift()!();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(batches).toHaveLength(2);
    releases.shift()!();
    await vi.waitFor(() => expect(batches[2]?.priority).toBe('background'));
    releases.shift()!();
    await work;
  });

  it('waits for controller preflight and rendering before releasing background work', async () => {
    let ready = false;
    const worker = vi.fn().mockResolvedValue(undefined);
    const scheduler = new TranslationScheduler(worker, { canDispatchBackground: () => ready });
    scheduler.enqueue(createUnits('background', 4, 50, 0));
    const work = scheduler.waitForIdle();
    expect(worker).not.toHaveBeenCalled();
    ready = true;
    scheduler.refresh();
    await work;
    expect(worker).toHaveBeenCalledTimes(1);
  });

  it('coalesces refreshes and reaches idle without creating more work from idle waiters', async () => {
    let release!: () => void;
    const refresh = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    const worker = vi.fn().mockResolvedValue(undefined);
    const scheduler = new TranslationScheduler(worker, { beforeDispatch: refresh });
    scheduler.enqueue(createUnits('visible', 1, 50, 0));
    scheduler.refresh();
    const work = scheduler.waitForIdle();
    expect(worker).not.toHaveBeenCalled();
    release();
    await work;
    // Let any coalesced refresh complete; waiting itself must never enqueue another refresh.
    await scheduler.waitForIdle();
    expect(scheduler.isIdle).toBe(true);
    expect(worker).toHaveBeenCalledTimes(1);
    expect(refresh.mock.calls.length).toBeLessThan(6);
  });

  it('demotes stale queued viewport work and uses the latest visible reading order', async () => {
    const batches: ScheduledTranslationBatch[] = [];
    let release!: () => void;
    const scheduler = new TranslationScheduler(
      (batch) => {
        batches.push(batch);
        return batches.length === 1
          ? new Promise<void>((resolve) => {
              release = resolve;
            })
          : Promise.resolve();
      },
      { concurrency: 1 },
    );
    scheduler.enqueue(createUnits('background', 4, 100, 0));
    const old = createUnits('visible', 1, 100, 10)[0];
    const latest = { ...old, id: 'latest', order: 11, priority: 'background' as const };
    scheduler.enqueue([old, latest]);
    scheduler.updatePriorities([
      { ...old, priority: 'background' },
      { ...latest, priority: 'visible' },
    ]);
    release();
    await scheduler.waitForIdle();
    expect(batches[1].segments[0].unitId).toBe('latest');
    expect(batches[1].priority).toBe('visible');
    expect(batches[2].priority).toBe('background');
  });

  it('discards a pending viewport refresh after stop without dispatching its queued work', async () => {
    let release!: () => void;
    const worker = vi.fn().mockResolvedValue(undefined);
    const scheduler = new TranslationScheduler(worker, {
      beforeDispatch: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });
    scheduler.enqueue(createUnits('visible', 4, 50, 0));
    scheduler.stop();
    release();
    await scheduler.waitForIdle();
    expect(worker).not.toHaveBeenCalled();
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
    expect(DEFAULT_SETTINGS.translationConcurrency).toBe(6);
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
    await vi.waitFor(() => expect(priorities).toHaveLength(3));
    expect(priorities).toEqual(['visible', 'visible', 'visible']);
    expect(maximumActive).toBe(3);

    const finished = scheduler.waitForIdle();
    while (!scheduler.isIdle) {
      releases.splice(0).forEach((release) => release());
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await finished;
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
