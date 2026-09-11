/** A task boundary (not a microtask) lets the browser process input and paint between slices. */
export function yieldToPage(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

type PrepareRender = () => (() => void) | undefined;
interface RenderTaskOptions {
  maxItems?: number;
  yieldTask?: () => Promise<void>;
  afterSlice?: () => void;
}

/** Reads a small slice first, then commits its writes in order; stop invalidates queued work. */
export class RenderTasks {
  private readonly tasks: PrepareRender[] = [];
  private running: Promise<void> | undefined;
  private stopped = false;
  constructor(private readonly options: RenderTaskOptions = {}) {}

  enqueue(prepare: PrepareRender): void {
    if (this.stopped) return;
    this.tasks.push(prepare);
    this.running ??= Promise.resolve().then(() => this.drain());
  }

  async waitForIdle(): Promise<void> {
    while (this.running) await this.running;
  }

  stop(): void {
    this.stopped = true;
    this.tasks.length = 0;
  }

  private async drain(): Promise<void> {
    try {
      while (!this.stopped && this.tasks.length > 0) {
        const start = performance.now();
        const writes: Array<() => void> = [];
        const maximum = this.options.maxItems ?? 4;
        let preparedCount = 0;
        do {
          const write = this.tasks.shift()!();
          preparedCount += 1;
          if (write) writes.push(write);
        } while (this.tasks.length > 0 && preparedCount < maximum && performance.now() - start < 8);
        for (const write of writes) {
          if (this.stopped) break;
          write();
        }
        this.options.afterSlice?.();
        if (this.tasks.length > 0 && !this.stopped) await (this.options.yieldTask ?? yieldToPage)();
      }
    } finally {
      this.running = undefined;
    }
  }
}
