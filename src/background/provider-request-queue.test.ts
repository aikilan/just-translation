import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProviderRequestQueue } from './provider-request-queue';

describe('ProviderRequestQueue', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('promotes an already admitted but unsent batch by ID, without preempting active HTTP', async () => {
    const queue = new ProviderRequestQueue();
    const signal = new AbortController().signal;
    const order: number[] = [];
    queue.defer('https://gateway.example.com', 100);
    const work = Array.from({ length: 8 }, (_, index) =>
      queue.run(
        'https://gateway.example.com',
        'background',
        signal,
        1000,
        () => {
          order.push(index);
          return Promise.resolve();
        },
        `job-${index}`,
      ),
    );
    queue.promote('https://gateway.example.com', 'job-7', 'visible');
    queue.promote('https://gateway.example.com', 'missing-job', 'visible');
    await vi.advanceTimersByTimeAsync(100);
    expect(order).toEqual([7, 0, 1, 2, 3, 4]);
    queue.promote('https://gateway.example.com', 'job-7', 'visible');
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all(work);
  });

  it('shares six active slots across tabs and models using the same API origin', async () => {
    const queue = new ProviderRequestQueue();
    const releases: Array<() => void> = [];
    const work = vi.fn(() => new Promise<void>((resolve) => releases.push(resolve)));
    const controller = new AbortController();
    const requests = Array.from({ length: 8 }, (_, index) =>
      queue.run(
        `https://gateway.example.com/model-${index}/v1`,
        'visible',
        controller.signal,
        30_000,
        work,
      ),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(work).toHaveBeenCalledTimes(6);
    releases.shift()!();
    await vi.advanceTimersByTimeAsync(999);
    expect(work).toHaveBeenCalledTimes(6);
    await vi.advanceTimersByTimeAsync(1);
    expect(work).toHaveBeenCalledTimes(7);
    releases.shift()!();
    await vi.advanceTimersByTimeAsync(0);
    expect(work).toHaveBeenCalledTimes(8);
    releases.splice(0).forEach((release) => release());
    await Promise.all(requests);
  });

  it('honors provider cooldown across requests without delaying other API origins', async () => {
    const queue = new ProviderRequestQueue();
    const signal = new AbortController().signal;
    const work = vi.fn(() => Promise.resolve('done'));
    queue.defer('https://gateway.example.com/v1', 15_000);
    const waiting = queue.run('https://gateway.example.com/chat', 'visible', signal, 100, work);
    await queue.run('https://other.example.com/v1', 'visible', signal, 100, work);
    expect(work).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(work).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(waiting).resolves.toBe('done');
    expect(work).toHaveBeenCalledTimes(2);
  });

  it('cancels queued work before fetch and does not consume its network timeout while waiting', async () => {
    const queue = new ProviderRequestQueue();
    queue.defer('https://gateway.example.com', 1_000);
    const controller = new AbortController();
    const work = vi.fn(() => Promise.resolve('done'));
    const request = queue.run(
      'https://gateway.example.com/v1',
      'visible',
      controller.signal,
      100,
      work,
    );
    const rejection = expect(request).rejects.toThrow('stopped');
    await vi.advanceTimersByTimeAsync(500);
    controller.abort(new Error('stopped'));
    await vi.advanceTimersByTimeAsync(500);
    await rejection;
    expect(work).not.toHaveBeenCalled();
  });

  it('prioritizes visible work at the next available slot and aborts a timed-out attempt', async () => {
    const queue = new ProviderRequestQueue();
    const signal = new AbortController().signal;
    const calls: string[] = [];
    queue.defer('https://gateway.example.com', 100);
    const background = queue.run('https://gateway.example.com', 'background', signal, 100, () => {
      calls.push('background');
      return Promise.resolve();
    });
    const visible = queue.run(
      'https://gateway.example.com',
      'visible',
      signal,
      100,
      (attemptSignal) => {
        calls.push('visible');
        return new Promise<void>((_resolve, reject) => {
          attemptSignal.addEventListener('abort', () => reject(attemptSignal.reason as Error));
        });
      },
    );
    const rejection = expect(visible).rejects.toThrow('超时');
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toEqual(['visible', 'background']);
    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    await background;
  });
});
