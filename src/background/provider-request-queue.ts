import PQueue from 'p-queue';

import type { TranslationPriority } from '../shared/messages';

interface ProviderQueue {
  queue: PQueue;
  resumeAt: number;
  resumeTimer?: ReturnType<typeof setTimeout>;
}

const PRIORITY: Readonly<Record<TranslationPriority, number>> = {
  visible: 2,
  readAhead: 1,
  background: 0,
};

/** Background-owned admission control. Tabs, profiles and models share a budget per API origin. */
export class ProviderRequestQueue {
  // Only API origins live here; never put credentials or webpage content in scheduling keys.
  private readonly providers = new Map<string, ProviderQueue>();
  private readonly waiting = new Map<
    string,
    { provider: ProviderQueue; priority: TranslationPriority }
  >();

  async run<T>(
    apiUrl: string,
    priority: TranslationPriority,
    signal: AbortSignal,
    timeoutMs: number,
    task: (attemptSignal: AbortSignal) => Promise<T>,
    jobId: string = crypto.randomUUID(),
  ): Promise<T> {
    const provider = this.getProvider(apiUrl);
    const entry = { provider, priority };
    this.waiting.set(jobId, entry);
    try {
      return await provider.queue.add(
        async () => {
          this.waiting.delete(jobId);
          signal.throwIfAborted();
          const timeout = new AbortController();
          const timer = setTimeout(() => timeout.abort(new Error('API 请求超时')), timeoutMs);
          const attemptSignal = AbortSignal.any([signal, timeout.signal]);
          try {
            return await task(attemptSignal);
          } finally {
            clearTimeout(timer);
          }
        },
        { id: jobId, priority: PRIORITY[priority], signal },
      );
    } finally {
      if (this.waiting.get(jobId) === entry) this.waiting.delete(jobId);
    }
  }

  /** Reprioritize only queued attempts; running or completed IDs are deliberately ignored. */
  promote(apiUrl: string, jobId: string, priority: TranslationPriority): void {
    const entry = this.waiting.get(jobId);
    if (!entry || entry.provider !== this.providers.get(new URL(apiUrl).origin)) return;
    if (PRIORITY[priority] <= PRIORITY[entry.priority]) return;
    entry.provider.queue.setPriority(jobId, PRIORITY[priority]);
    entry.priority = priority;
  }

  /** A 429 pauses new attempts, including other tabs and compensation requests, not in-flight HTTP. */
  defer(apiUrl: string, delayMs: number): void {
    if (!Number.isFinite(delayMs) || delayMs <= 0) return;
    const provider = this.getProvider(apiUrl);
    provider.resumeAt = Math.max(provider.resumeAt, Date.now() + delayMs);
    provider.queue.pause();
    clearTimeout(provider.resumeTimer);
    const resume = () => {
      const remaining = provider.resumeAt - Date.now();
      if (remaining > 0) {
        // Browser timers use signed 32-bit delays. Never overflow a long provider cooldown.
        provider.resumeTimer = setTimeout(resume, Math.min(remaining, 2_147_483_647));
      } else {
        provider.resumeTimer = undefined;
        provider.queue.start();
      }
    };
    resume();
  }

  private getProvider(apiUrl: string): ProviderQueue {
    const origin = new URL(apiUrl).origin;
    let provider = this.providers.get(origin);
    if (!provider) {
      provider = {
        queue: new PQueue({ concurrency: 6, intervalCap: 6, interval: 1_000, strict: true }),
        resumeAt: 0,
      };
      this.providers.set(origin, provider);
    }
    return provider;
  }
}
