import { message, LocalizedError } from './i18n';
/** Runs work through a fixed-size pool while preserving input order in the result. */
export async function runWithConcurrency<TItem, TResult>(
  items: readonly TItem[],
  concurrency: number,
  worker: (item: TItem, index: number) => Promise<TResult>,
): Promise<TResult[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new LocalizedError(message('并发数必须是大于等于 1 的整数'));
  }

  const results = new Array<TResult>(items.length);
  let nextIndex = 0;
  const runWorker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  };

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}
