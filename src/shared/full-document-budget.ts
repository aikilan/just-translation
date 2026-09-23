import { LocalizedError, message, type UiMessage } from './i18n';

/** Starts only after queue admission. Valid translation deltas reset idle, never the total deadline. */
export async function withFullDocumentBudget<T>(
  totalMs: number,
  parent: AbortSignal | undefined,
  task: (signal: AbortSignal, onContent: () => void) => Promise<T>,
): Promise<T> {
  const timeout = new AbortController();
  const signal = parent ? AbortSignal.any([parent, timeout.signal]) : timeout.signal;
  signal.throwIfAborted();
  const expire = (error: UiMessage) => timeout.abort(new LocalizedError(error));
  // Register first-output before total so equal 120s deadlines report the more specific cause.
  let idle = setTimeout(() => expire(message('全文首次有效输出超时')), 120_000);
  const total = setTimeout(() => expire(message('全文翻译已达到总时限')), totalMs);
  let finished = false;
  let rejectAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = () =>
      reject(signal.reason instanceof Error ? signal.reason : new Error('Translation cancelled'));
    signal.addEventListener('abort', rejectAbort, { once: true });
  });
  const onContent = () => {
    if (finished || signal.aborted) return;
    clearTimeout(idle);
    idle = setTimeout(() => expire(message('全文译文输出停滞超时')), 60_000);
  };
  try {
    const result = await Promise.race([task(signal, onContent), aborted]);
    signal.throwIfAborted();
    return result;
  } finally {
    finished = true;
    clearTimeout(idle);
    clearTimeout(total);
    signal.removeEventListener('abort', rejectAbort);
  }
}
