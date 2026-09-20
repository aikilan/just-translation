export type RetryTranslation = (source: HTMLElement) => void;

/** Registers one delegated retry interaction for all current and future failed nodes. */
export function registerRetryInteractions(
  retry: RetryTranslation,
  root: Document = document,
): () => void {
  const handleClick = (event: MouseEvent): void => {
    const source = getRetryableSource(event.target);
    if (!source) return;
    event.preventDefault();
    event.stopPropagation();
    retry(source);
  };
  const handleKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const source = getRetryableSource(event.target);
    if (!source) return;
    event.preventDefault();
    event.stopPropagation();
    retry(source);
  };

  root.addEventListener('click', handleClick, true);
  root.addEventListener('keydown', handleKeydown, true);
  return () => {
    root.removeEventListener('click', handleClick, true);
    root.removeEventListener('keydown', handleKeydown, true);
  };
}

function getRetryableSource(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const retryControl = target.closest<HTMLElement>(
    '[data-justranslate-translation][data-justranslate-state="error"][role="button"]',
  );
  return retryControl?.closest<HTMLElement>('[data-justranslate-source]') ?? null;
}
