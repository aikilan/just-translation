/** Pages above the viewport keep a little context; the next screen is read ahead. */
const TRANSLATION_RANGE = { above: 0.5, below: 1 };
const READING_SELECTOR = ':scope > .pdf-page > .pdf-page-reading';

/**
 * Decides which PDF pages the page translator may see. Reading text starts locked with
 * translate="no", which the translator already skips, and is unlocked page by page as the reader
 * scrolls near it. Unlocked pages stay unlocked until the document is restored.
 */
export class PdfPageScope {
  private observer: IntersectionObserver | undefined;

  constructor(
    private readonly container: HTMLElement,
    private readonly onReveal: (readings: HTMLElement[]) => void,
  ) {}

  /** Unlocks the pages in range now and keeps unlocking pages as they scroll into range. */
  watch(): HTMLElement[] {
    this.stopWatching();
    const view = this.container.ownerDocument.defaultView;
    const height = view?.innerHeight ?? 0;
    const revealed = this.unlock(
      this.readings().filter((reading) => {
        const rect = (reading.parentElement ?? reading).getBoundingClientRect();
        return (
          rect.bottom > -height * TRANSLATION_RANGE.above &&
          rect.top < height * (1 + TRANSLATION_RANGE.below)
        );
      }),
    );
    if (view && 'IntersectionObserver' in view) {
      const observer = new view.IntersectionObserver(
        (entries) => {
          if (this.observer !== observer) return;
          const readings = entries
            .filter((entry) => entry.isIntersecting)
            .map((entry) => entry.target.querySelector<HTMLElement>(':scope > .pdf-page-reading'))
            .filter((reading) => reading !== null);
          const unlocked = this.unlock(readings);
          if (unlocked.length > 0) this.onReveal(unlocked);
        },
        {
          rootMargin: `${TRANSLATION_RANGE.above * 100}% 0px ${TRANSLATION_RANGE.below * 100}% 0px`,
        },
      );
      this.observer = observer;
      for (const reading of this.readings()) observer.observe(reading.parentElement ?? reading);
    }
    return revealed;
  }

  stopWatching(): void {
    this.observer?.disconnect();
    this.observer = undefined;
  }

  /** Full-document translation needs every page at once. */
  unlockAll(): HTMLElement[] {
    this.stopWatching();
    return this.unlock(this.readings());
  }

  /** Restoring the original returns every page to on-demand translation. */
  lockAll(): void {
    this.stopWatching();
    for (const reading of this.readings()) reading.setAttribute('translate', 'no');
  }

  /** Pages the translator may currently see, out of all pages. */
  progress(): { unlocked: number; total: number } {
    const readings = this.readings();
    return {
      unlocked: readings.filter((reading) => !reading.hasAttribute('translate')).length,
      total: readings.length,
    };
  }

  private unlock(readings: readonly HTMLElement[]): HTMLElement[] {
    const unlocked = readings.filter((reading) => reading.hasAttribute('translate'));
    for (const reading of unlocked) reading.removeAttribute('translate');
    return unlocked;
  }

  private readings(): HTMLElement[] {
    return [...this.container.querySelectorAll<HTMLElement>(READING_SELECTOR)];
  }
}
