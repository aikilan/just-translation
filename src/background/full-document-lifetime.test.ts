import { afterEach, expect, it, vi } from 'vitest';
import { withFullDocumentLifetime } from './full-document-lifetime';
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it.each([false, true])('keeps only the active operation alive; failure=%s', async (fail) => {
  vi.useFakeTimers();
  const getPlatformInfo = vi.fn().mockResolvedValue({});
  vi.stubGlobal('chrome', { runtime: { getPlatformInfo } });
  let finish!: () => void;
  const work = withFullDocumentLifetime(
    () =>
      new Promise<void>((resolve, reject) => {
        finish = () => (fail ? reject(new Error('failed')) : resolve());
      }),
  );
  const outcome = work.catch(() => undefined);
  await vi.advanceTimersByTimeAsync(50_000);
  expect(getPlatformInfo).toHaveBeenCalledTimes(2);
  finish();
  await outcome;
  expect(vi.getTimerCount()).toBe(0);
});
