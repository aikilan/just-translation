import { describe, expect, it, vi } from 'vitest';

import { AbortableRequestRegistry } from './request-registry';

describe('AbortableRequestRegistry', () => {
  it('cancels only the previous document on navigation and supports exact session prefixes', async () => {
    const registry = new AbortableRequestRegistry(0);
    const signals: AbortSignal[] = [];
    const work = ['18:old:s1:b1', '18:old:s2:b1', '18:new:s1:b1', '19:old:s1:b1'].map((key) =>
      registry.run(key, (signal) => {
        signals.push(signal);
        return new Promise<void>((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason as Error)),
        );
      }),
    );
    const finished = Promise.allSettled(work);
    registry.cancelOtherDocuments(18, 'new');
    expect(signals.map((signal) => signal.aborted)).toEqual([true, true, false, false]);
    registry.cancelPrefix('18:new:s1:');
    expect(signals[2].aborted).toBe(true);
    registry.cancelForTab(19);
    await finished;
    expect(registry.size).toBe(0);
  });
  it('tracks queued operations without starting their HTTP timeout and cancels a closed tab only', async () => {
    vi.useFakeTimers();
    const registry = new AbortableRequestRegistry(100);
    const wait = (signal: AbortSignal) =>
      new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason as Error));
      });
    const first = registry.run('12:a', wait, 0);
    const second = registry.run('12:b', wait, 0);
    const other = registry.run('123:a', wait, 0);
    const results = Promise.allSettled([first, second, other]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(registry.size).toBe(3);
    registry.cancelForTab(12);
    expect(registry.size).toBe(1);
    registry.cancelForTab(123);
    expect((await results).every((result) => result.status === 'rejected')).toBe(true);
    expect(registry.size).toBe(0);
    vi.useRealTimers();
  });
  it('aborts a running request and removes it from the registry', async () => {
    const registry = new AbortableRequestRegistry(60_000);
    let observedSignal: AbortSignal | undefined;
    const request = registry.run('tab:session', (signal) => {
      observedSignal = signal;
      return new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(getAbortError(signal)));
      });
    });

    expect(registry.size).toBe(1);
    registry.cancel('tab:session');

    expect(observedSignal?.aborted).toBe(true);
    await expect(request).rejects.toThrow(/取消/u);
    expect(registry.size).toBe(0);
  });

  it('cleans up completed requests and enforces the timeout', async () => {
    vi.useFakeTimers();
    const registry = new AbortableRequestRegistry(500);
    const request = registry.run(
      'tab:timeout',
      (signal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(getAbortError(signal)));
        }),
    );
    const rejection = expect(request).rejects.toThrow(/超时/u);

    await vi.advanceTimersByTimeAsync(500);

    await rejection;
    expect(registry.size).toBe(0);
    vi.useRealTimers();
  });

  it('allows a priority policy to override the registry default timeout per request', async () => {
    vi.useFakeTimers();
    const registry = new AbortableRequestRegistry(60_000);
    const request = registry.run(
      'tab:visible',
      (signal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(getAbortError(signal)));
        }),
      20_000,
    );
    const rejection = expect(request).rejects.toThrow(/超时/u);

    await vi.advanceTimersByTimeAsync(19_999);
    expect(registry.size).toBe(1);
    await vi.advanceTimersByTimeAsync(1);

    await rejection;
    expect(registry.size).toBe(0);
    vi.useRealTimers();
  });

  it('keeps sibling requests in one session active and cancels them together', async () => {
    const registry = new AbortableRequestRegistry(60_000);
    const signals: AbortSignal[] = [];
    const startRequest = () =>
      registry.run('tab:concurrent-session', (signal) => {
        signals.push(signal);
        return new Promise<string>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(getAbortError(signal)));
        });
      });

    const first = startRequest();
    const second = startRequest();
    expect(registry.size).toBe(2);
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => !signal.aborted)).toBe(true);

    registry.cancel('tab:concurrent-session');

    await expect(first).rejects.toThrow(/取消/u);
    await expect(second).rejects.toThrow(/取消/u);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(registry.size).toBe(0);
  });
});

function getAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Request aborted');
}
