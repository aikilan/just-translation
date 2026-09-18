import { expect, it, vi } from 'vitest';
import { RetryMenuRegistration, hasRetryableFailures } from './context-menu';

it.each([
  [{ mode: 'segmented', failed: 2 }, true],
  [{ mode: 'segmented', failed: 0 }, false],
  [{ mode: 'full-document', failed: 2 }, false],
  [undefined, false],
  [{ mode: 'segmented', failed: '2' }, false],
] as const)('checks current document failures: %j', (status, expected) => {
  expect(hasRetryableFailures(status)).toBe(expected);
});

it('hides retry after recovery or when the active page cannot be reached', async () => {
  const read = vi.fn().mockResolvedValue({ mode: 'segmented', failed: 2 });
  const update = vi.fn().mockResolvedValue(undefined);
  const menu = new RetryMenuRegistration(read, update);
  await menu.refresh();
  read.mockResolvedValueOnce({ mode: 'segmented', failed: 0 });
  await menu.refresh();
  read.mockRejectedValueOnce(new Error('No content script'));
  await menu.refresh();
  expect(update.mock.calls).toEqual([[true], [false]]);
});

it('ignores an old tab response after switching to a page without failures', async () => {
  let release!: (status: unknown) => void;
  const read = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    )
    .mockResolvedValue({ mode: 'segmented', failed: 0 });
  const update = vi.fn().mockResolvedValue(undefined);
  const menu = new RetryMenuRegistration(read, update);
  const old = menu.refresh();
  await menu.refresh();
  release({ mode: 'segmented', failed: 3 });
  await old;
  expect(update).not.toHaveBeenCalled();
});

it('serializes menu writes and recovers after an update failure', async () => {
  let release!: () => void;
  const read = vi
    .fn()
    .mockResolvedValueOnce({ mode: 'segmented', failed: 2 })
    .mockResolvedValue(undefined);
  const update = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    )
    .mockRejectedValueOnce(new Error('menu unavailable'))
    .mockResolvedValue(undefined);
  const menu = new RetryMenuRegistration(read, update);
  const first = menu.refresh();
  await vi.waitFor(() => expect(update).toHaveBeenCalledOnce());
  const second = menu.refresh();
  const rejected = expect(second).rejects.toThrow('menu unavailable');
  await Promise.resolve();
  expect(update).toHaveBeenCalledOnce();
  release();
  await first;
  await rejected;
  await menu.refresh();
  expect(update.mock.calls).toEqual([[true], [false], [false]]);
});

it('registers retry only while needed and skips unchanged states', async () => {
  const read = vi.fn().mockResolvedValue(undefined);
  const update = vi.fn().mockResolvedValue(undefined);
  const menu = new RetryMenuRegistration(read, update);
  await menu.refresh();
  expect(update).not.toHaveBeenCalled();
  read.mockResolvedValue({ mode: 'segmented', failed: 2 });
  await menu.refresh();
  await menu.refresh();
  read.mockResolvedValue(undefined);
  await menu.refresh();
  await menu.refresh();
  expect(update.mock.calls).toEqual([[true], [false]]);
});

it('retries creation after a failed registration', async () => {
  const read = vi.fn().mockResolvedValue({ mode: 'segmented', failed: 1 });
  const update = vi
    .fn()
    .mockRejectedValueOnce(new Error('creation failed'))
    .mockResolvedValue(undefined);
  const menu = new RetryMenuRegistration(read, update);
  await expect(menu.refresh()).rejects.toThrow('creation failed');
  await menu.refresh();
  await menu.refresh();
  expect(update.mock.calls).toEqual([[true], [true]]);
});
