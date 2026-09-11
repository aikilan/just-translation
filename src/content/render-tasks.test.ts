import { describe, expect, it, vi } from 'vitest';
import { RenderTasks } from './render-tasks';

describe('budgeted DOM submission', () => {
  it('counts discarded preparations toward the slice budget', async () => {
    const events: string[] = [];
    const queue = new RenderTasks({
      maxItems: 2,
      yieldTask: () => {
        events.push('yield');
        return Promise.resolve();
      },
    });
    for (let i = 0; i < 5; i += 1)
      queue.enqueue(() => {
        events.push(`read${i}`);
        return undefined;
      });
    await queue.waitForIdle();
    expect(events).toEqual(['read0', 'read1', 'yield', 'read2', 'read3', 'yield', 'read4']);
  });
  it('reads a slice before writing it, yields between slices and preserves order', async () => {
    const order: string[] = [];
    const queue = new RenderTasks({
      maxItems: 2,
      yieldTask: () => {
        order.push('yield');
        return Promise.resolve();
      },
    });
    for (let i = 0; i < 5; i += 1)
      queue.enqueue(() => {
        order.push(`read${i}`);
        return () => {
          order.push(`write${i}`);
        };
      });
    await queue.waitForIdle();
    expect(order).toEqual([
      'read0',
      'read1',
      'write0',
      'write1',
      'yield',
      'read2',
      'read3',
      'write2',
      'write3',
      'yield',
      'read4',
      'write4',
    ]);
  });

  it('drops prepared and queued work after stop and resolves idle waiters', async () => {
    let resume!: () => void;
    const commit = vi.fn();
    const queue = new RenderTasks({
      maxItems: 1,
      yieldTask: () =>
        new Promise((resolve) => {
          resume = resolve;
        }),
    });
    queue.enqueue(() => commit);
    queue.enqueue(() => commit);
    await vi.waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
    queue.stop();
    resume();
    await queue.waitForIdle();
    expect(commit).toHaveBeenCalledTimes(1);
  });
});
