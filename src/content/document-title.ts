/** The tab title is a text-only translation unit; it must never receive body wrappers or controls. */
interface TitlePresentation {
  original: string;
  translated?: string;
  observer: MutationObserver;
}

const presentations = new Map<HTMLTitleElement, TitlePresentation>();

export function isDocumentTitle(element: Element): element is HTMLTitleElement {
  return element instanceof HTMLTitleElement;
}

/** Observe host writes independently of automatic translation, so restore remains safe after stop. */
function acceptHostWrites(source: HTMLTitleElement, state: TitlePresentation): void {
  const original = source.textContent ?? '';
  // Match the scheduler's normalized source identity while retaining exact host text for restore.
  if (original.replace(/\s+/gu, ' ').trim() !== state.original.replace(/\s+/gu, ' ').trim())
    state.translated = undefined;
  state.original = original;
}

function currentPresentation(source: HTMLTitleElement): TitlePresentation | undefined {
  const state = presentations.get(source);
  if (state?.observer.takeRecords().length) acceptHostWrites(source, state);
  return state;
}

export function getTitleSourceText(source: HTMLTitleElement): string {
  return currentPresentation(source)?.original ?? source.textContent ?? '';
}

/** Stage without touching the tab; full-document mode publishes only after snapshot validation. */
export function stageTitleTranslation(source: HTMLTitleElement, translated: string): void {
  let state = currentPresentation(source);
  if (!state) {
    const observer = new MutationObserver(() => {
      const current = presentations.get(source);
      if (current) acceptHostWrites(source, current);
    });
    state = { original: source.textContent ?? '', observer };
    observer.observe(source, { subtree: true, childList: true, characterData: true });
    presentations.set(source, state);
  }
  state.translated = translated;
}

/** Both reading display modes show a translated tab title; restore is the original-text action. */
export function applyTitleTranslation(source: HTMLTitleElement): void {
  const state = currentPresentation(source);
  if (!state || state.translated === undefined || source.textContent === state.translated) return;
  source.textContent = state.translated;
  // Drain only our write. Subsequent page writes, even with identical text, relinquish ownership.
  state.observer.takeRecords();
}

export function applyDocumentTitleTranslations(): void {
  for (const source of presentations.keys()) applyTitleTranslation(source);
}

export function restoreTitle(source: HTMLTitleElement): void {
  const state = currentPresentation(source);
  if (!state) return;
  state.observer.disconnect();
  if (state.translated !== undefined && source.textContent === state.translated)
    source.textContent = state.original;
  presentations.delete(source);
}

export function restoreDocumentTitles(): void {
  for (const source of presentations.keys()) restoreTitle(source);
}
