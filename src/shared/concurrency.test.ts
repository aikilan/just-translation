import { describe, expect, it } from 'vitest';

import { runWithConcurrency } from './concurrency';

describe('runWithConcurrency', () => {
  it('starts no more than the configured number of tasks and preserves result order', async () => {
    const releases: Array<() => void> = [];
    const started: number[] = [];
    let active = 0;
    let maximumActive = 0;

    const execution = runWithConcurrency([0, 1, 2, 3, 4], 3, async (item) => {
      started.push(item);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return `done-${item}`;
    });

    await Promise.resolve();
    expect(started).toEqual([0, 1, 2]);
    expect(maximumActive).toBe(3);

    releases.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual([0, 1, 2, 3]);

    while (releases.length > 0) {
      releases.shift()?.();
      await Promise.resolve();
      await Promise.resolve();
    }

    await expect(execution).resolves.toEqual([
      'done-0',
      'done-1',
      'done-2',
      'done-3',
      'done-4',
    ]);
    expect(maximumActive).toBe(3);
  });
});
