type AbortableTask<T> = (signal: AbortSignal) => Promise<T>;

/** Owns request cancellation and guarantees that completed or failed requests are released. */
export class AbortableRequestRegistry {
  private readonly controllers = new Map<string, Set<AbortController>>();

  constructor(private readonly timeoutMs: number) {}

  get size(): number {
    let size = 0;
    for (const controllers of this.controllers.values()) size += controllers.size;
    return size;
  }

  async run<T>(key: string, task: AbortableTask<T>, timeoutMs = this.timeoutMs): Promise<T> {
    const controller = new AbortController();
    const sessionControllers = this.controllers.get(key) ?? new Set<AbortController>();
    sessionControllers.add(controller);
    this.controllers.set(key, sessionControllers);
    // A zero timeout tracks queued work for cancellation only; HTTP timers start at dispatch.
    const timeoutId =
      timeoutMs > 0
        ? setTimeout(() => controller.abort(new Error('API 请求超时')), timeoutMs)
        : undefined;

    try {
      return await task(controller.signal);
    } finally {
      clearTimeout(timeoutId);
      sessionControllers.delete(controller);
      if (sessionControllers.size === 0 && this.controllers.get(key) === sessionControllers) {
        this.controllers.delete(key);
      }
    }
  }

  cancel(key: string): void {
    const sessionControllers = this.controllers.get(key);
    if (!sessionControllers) return;
    for (const controller of sessionControllers) {
      controller.abort(new Error('API 请求已取消'));
    }
    this.controllers.delete(key);
  }

  /** Cancels both queued and active work when its browser-owned tab disappears. */
  cancelForTab(tabId: number): void {
    this.cancelPrefix(`${tabId}:`);
  }

  cancelPrefix(prefix: string): void {
    for (const key of this.controllers.keys()) {
      if (key.startsWith(prefix)) this.cancel(key);
    }
  }

  /** Document identity distinguishes same-origin pagination and retains newly created work. */
  cancelOtherDocuments(tabId: number, documentId: string): void {
    const tabPrefix = `${tabId}:`;
    const documentPrefix = `${tabId}:${documentId}:`;
    for (const key of this.controllers.keys()) {
      if (key.startsWith(tabPrefix) && !key.startsWith(documentPrefix)) this.cancel(key);
    }
  }
}
