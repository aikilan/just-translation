import { afterEach, expect, it, vi } from 'vitest';
import { withFullDocumentBudget } from './full-document-budget';

afterEach(() => vi.useRealTimers());
it('allows useful output past 120 seconds and clears all timers', async () => {
  vi.useFakeTimers();
  let progress!: () => void;
  let finish!: (value: string) => void;
  const work = withFullDocumentBudget(600_000, undefined, (_signal, onContent) => {
    progress = onContent;
    return new Promise<string>((resolve) => {
      finish = resolve;
    });
  });
  for (let i = 0; i < 4; i++) {
    await vi.advanceTimersByTimeAsync(50_000);
    progress();
  }
  finish('done');
  await expect(work).resolves.toBe('done');
  expect(vi.getTimerCount()).toBe(0);
});
it.each(['first', 'idle', 'total', 'cancel'] as const)(
  'aborts and releases an uncooperative task on %s',
  async (reason) => {
    vi.useFakeTimers();
    const parent = new AbortController();
    let signal!: AbortSignal;
    let progress!: () => void;
    const work = withFullDocumentBudget(120_000, parent.signal, (s, p) => {
      signal = s;
      progress = p;
      return new Promise(() => {});
    });
    const failure = expect(work).rejects.toThrow(
      { first: '首次', idle: '停滞', total: '总时限', cancel: 'cancelled' }[reason],
    );
    if (reason === 'cancel') parent.abort(new Error('cancelled'));
    else if (reason === 'idle') {
      progress();
      await vi.advanceTimersByTimeAsync(60_000);
    } else if (reason === 'total') {
      for (let i = 0; i < 3; i++) {
        progress();
        await vi.advanceTimersByTimeAsync(40_000);
      }
    } else await vi.advanceTimersByTimeAsync(120_000);
    await failure;
    expect(signal.aborted).toBe(true);
    progress();
    expect(vi.getTimerCount()).toBe(0);
  },
);
