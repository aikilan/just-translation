/** Labels keep host Text nodes under their original parent so framework reconciliation stays valid. */
interface LabelPresentation {
  text: Text;
  observer: MutationObserver;
  original: string;
  applied: string | undefined;
  appliedFrom: string | undefined;
}

const labels = new WeakMap<HTMLElement, LabelPresentation>();
const sources = new WeakMap<Text, HTMLElement>();

/** Insert a sibling translation anchor; never move, clone or replace the host's Text node. */
export function registerLabelSource(anchor: HTMLElement, text: Text): void {
  text.parentNode!.insertBefore(anchor, text);
  const observer = new MutationObserver(() => acceptHostWrite(state));
  const state: LabelPresentation = {
    text,
    observer,
    original: text.data,
    applied: undefined,
    appliedFrom: undefined,
  };
  // This observes only one owned Text, even after it is detached. It never schedules translation.
  // Ownership must outlive automatic translation so stop/disabled mode can still restore safely.
  observer.observe(text, { characterData: true, characterDataOldValue: true });
  labels.set(anchor, state);
  sources.set(text, anchor);
}

/** Own writes are drained synchronously; every remaining record is a host write, including '' → ''. */
function acceptHostWrite(state: LabelPresentation): void {
  state.original = state.text.data;
  state.applied = undefined;
  state.appliedFrom = undefined;
}

function drainHostWrites(state: LabelPresentation): void {
  if (state.observer.takeRecords().length) acceptHostWrite(state);
}

export function getLabelSource(node: Node): HTMLElement | undefined {
  return node.nodeType === 3 ? sources.get(node as Text) : undefined;
}

export function getLabelText(source: HTMLElement): string | undefined {
  const state = labels.get(source);
  if (!state) return undefined;
  drainHostWrites(state);
  if (!state.text.isConnected || state.text.parentNode !== source.parentNode) return '';
  return state.applied !== undefined && state.text.data === state.applied
    ? state.original
    : state.text.data;
}

export function getLabelTextParent(source: HTMLElement): HTMLElement | undefined {
  return labels.get(source)?.text.parentElement ?? undefined;
}

/** Blank only the original glyphs after success; values, elements, icons and listeners stay untouched. */
export function setLabelTextHidden(source: HTMLElement, hidden: boolean): boolean {
  const state = labels.get(source);
  if (!state) return false;
  drainHostWrites(state);
  if (hidden) {
    if (state.applied !== undefined && state.text.data === state.applied) return true;
    state.original = state.text.data;
    state.appliedFrom = state.text.data;
    state.applied = '';
    state.text.data = '';
    state.observer.takeRecords();
  } else if (state.applied !== undefined) {
    if (state.text.data === state.applied) {
      state.text.data = state.original;
      state.observer.takeRecords();
    }
    state.applied = undefined;
    state.appliedFrom = undefined;
  }
  return true;
}

/** Analysis and translation observers share provenance; drain host writes before classifying. */
export function isLabelPresentationMutation(mutation: MutationRecord): boolean {
  const source = getLabelSource(mutation.target);
  const state = source && labels.get(source);
  if (state) drainHostWrites(state);
  return (
    !!state &&
    mutation.type === 'characterData' &&
    state.applied !== undefined &&
    state.text.data === state.applied &&
    mutation.oldValue === state.appliedFrom
  );
}

export function releaseLabelSource(source: HTMLElement): boolean {
  const state = labels.get(source);
  if (!state) return false;
  setLabelTextHidden(source, false);
  state.observer.disconnect();
  sources.delete(state.text);
  labels.delete(source);
  source.remove();
  return true;
}
