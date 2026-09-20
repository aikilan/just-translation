import { isLabelPresentationMutation } from './label-presentation';

export const SOURCE_CONTENT_ATTRIBUTE = 'data-justranslate-source-content';
export const SOURCE_TEXT_ATTRIBUTE = 'data-justranslate-source-text';

interface HiddenState {
  owner: HTMLElement;
  original: string | null;
  managed: boolean;
  appliedHidden?: string | null;
}
interface StyleValue {
  name: string;
  value: string;
  priority: string;
  applied: string;
}
interface PresentationState {
  nodes: Set<Element>;
  hidden: boolean;
  originalStyle: string | null;
  appliedStyle: string | null;
  styles: StyleValue[];
}
const hiddenStates = new WeakMap<Element, HiddenState>();
const presentations = new Map<HTMLElement, PresentationState>();

/** Read layout before committing. Only a claimed reading unit may expand to fit its translation;
 * scrolling/layout ancestors and page controls are never rewritten.
 */
export function prepareSourcePresentation(source: HTMLElement, inlineLabel = false): () => void {
  if (presentations.has(source)) return () => synchronizeSourcePresentation(source);
  const computed = getComputedStyle(source);
  const overrides: Record<string, string> = {};
  const clips = [computed.overflow, computed.overflowX, computed.overflowY].some((value) =>
    /^(hidden|clip)$/.test(value),
  );
  const clamp = computed.getPropertyValue('-webkit-line-clamp');
  if (!inlineLabel && (clips || (clamp && clamp !== 'none' && clamp !== 'unset'))) {
    Object.assign(overrides, {
      'overflow-x': 'visible',
      'overflow-y': 'visible',
      height: 'auto',
      'max-height': 'none',
      'block-size': 'auto',
      'max-block-size': 'none',
      '-webkit-line-clamp': 'unset',
    });
  }
  // A direct-text flex leaf needs a new line for the translation item. Existing child items
  // are discovered separately; their layout owner does not reach this presentation path.
  if (!inlineLabel && ['flex', 'inline-flex'].includes(computed.display))
    overrides['flex-wrap'] = 'wrap';
  return () => {
    if (presentations.has(source)) {
      synchronizeSourcePresentation(source);
      return;
    }
    // Inline reads do not force layout; capture at commit so intervening page edits are retained.
    const originalStyle = source.getAttribute('style');
    const styles = Object.entries(overrides).map(([name, applied]) => ({
      name,
      applied,
      value: source.style.getPropertyValue(name),
      priority: source.style.getPropertyPriority(name),
    }));
    for (const { name, applied } of styles) source.style.setProperty(name, applied, 'important');
    presentations.set(source, {
      nodes: new Set(),
      hidden: false,
      originalStyle,
      styles,
      appliedStyle: source.getAttribute('style'),
    });
    synchronizeSourcePresentation(source);
  };
}

/** Enumerate owned sources, including detached ones that still need restoration. */
export function getPresentedSources(document: Document): HTMLElement[] {
  return [...presentations.keys()].filter((source) => source.ownerDocument === document);
}

/** Reconcile node ownership independently of text equality and current DOM parentage. */
export function synchronizeSourcePresentation(source: HTMLElement): void {
  const presentation = presentations.get(source);
  if (!presentation) return;
  for (const node of presentation.nodes) {
    if (node.parentNode !== source) releaseOriginalNode(node);
  }
  // Release foreign ownership first: a moved text anchor must be unwrapped before adoption.
  for (const node of Array.from(source.children)) {
    const state = hiddenStates.get(node);
    if (state && state.owner !== source) releaseOriginalNode(node);
  }
  // Preserve element parentage/listeners; only bare Text needs an anchor for display mode.
  for (const node of Array.from(source.childNodes)) {
    if (node instanceof Element && node.hasAttribute('data-justranslate-translation')) continue;
    let child: Element;
    if (node instanceof Element) child = node;
    else if (node.nodeType === Node.TEXT_NODE) {
      child = source.ownerDocument.createElement('span');
      child.setAttribute(SOURCE_TEXT_ATTRIBUTE, '');
      source.insertBefore(child, node);
      child.append(node);
    } else continue;
    if (!hiddenStates.has(child)) {
      child.setAttribute(SOURCE_CONTENT_ATTRIBUTE, '');
      hiddenStates.set(child, {
        owner: source,
        original: child.getAttribute('hidden'),
        managed: false,
      });
      presentation.nodes.add(child);
    }
    applyOriginalHidden(child, presentation.hidden);
  }
}

/** Release the actual node wherever the host moved it; repeated cleanup is harmless. */
function releaseOriginalNode(child: Element): void {
  const state = hiddenStates.get(child);
  if (!state) return;
  applyOriginalHidden(child, false);
  presentations.get(state.owner)?.nodes.delete(child);
  hiddenStates.delete(child);
  child.removeAttribute(SOURCE_CONTENT_ATTRIBUTE);
  if (child.hasAttribute(SOURCE_TEXT_ATTRIBUTE)) {
    child.removeAttribute(SOURCE_TEXT_ATTRIBUTE);
    child.replaceWith(...child.childNodes);
  }
}

/** Lets original-source inspection see nodes hidden solely by our display mode. */
export function isHiddenByTranslation(element: Element): boolean {
  const state = hiddenStates.get(element);
  return !!state?.managed && state.original === null && element.getAttribute('hidden') === '';
}

export function setOriginalContentHidden(source: HTMLElement, hidden: boolean): void {
  const presentation = presentations.get(source);
  if (!presentation) return;
  presentation.hidden = hidden;
  synchronizeSourcePresentation(source);
}

function applyOriginalHidden(child: Element, hidden: boolean): void {
  const state = hiddenStates.get(child);
  if (!state || state.original !== null) return;
  if (hidden) {
    if (!child.hasAttribute('hidden')) {
      child.setAttribute('hidden', '');
      state.managed = true;
      state.appliedHidden = '';
    }
  } else if (state.managed) {
    if (child.getAttribute('hidden') === '') {
      child.removeAttribute('hidden');
      state.appliedHidden = null;
    }
    state.managed = false;
  }
}

/** Restore only our own changes. Page-authored edits made during translation win. */
export function restoreSourcePresentation(source: HTMLElement): void {
  const state = presentations.get(source);
  if (state) {
    for (const child of state.nodes) releaseOriginalNode(child);
    if (source.getAttribute('style') === state.appliedStyle) {
      if (state.originalStyle === null) source.removeAttribute('style');
      else source.setAttribute('style', state.originalStyle);
    } else {
      for (const { name, value, priority, applied } of state.styles) {
        if (
          source.style.getPropertyValue(name) !== applied ||
          source.style.getPropertyPriority(name) !== 'important'
        )
          continue;
        if (value) source.style.setProperty(name, value, priority);
        else source.style.removeProperty(name);
      }
    }
    presentations.delete(source);
  }
}

/** Ignore only extension-authored attributes, never page class/style/data changes on original children. */
export function isSourcePresentationMutation(mutation: MutationRecord): boolean {
  if (isLabelPresentationMutation(mutation)) return true;
  if (mutation.type !== 'attributes' || !(mutation.target instanceof HTMLElement)) return false;
  if (mutation.attributeName?.startsWith('data-justranslate-')) return true;
  const element = mutation.target;
  if (mutation.attributeName === 'hidden') {
    const state = hiddenStates.get(element);
    return (
      state?.appliedHidden !== undefined && state.appliedHidden === element.getAttribute('hidden')
    );
  }
  if (mutation.attributeName === 'style') {
    const state = presentations.get(element);
    return !!state && state.appliedStyle === element.getAttribute('style');
  }
  return false;
}
