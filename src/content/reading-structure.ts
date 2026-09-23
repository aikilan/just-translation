export const CONTROL_SELECTOR =
  'button,label,legend,summary,[role="button"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="option"],[role="tab"],[role="checkbox"],[role="radio"],[role="switch"],[role="combobox"]';

export const PROTECTED_SELECTOR = 'code,kbd,samp,math,[translate="no" i],.notranslate';

const SEMANTIC_TEXT_FLOW_TAGS = new Set([
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'P',
  'LI',
  'BLOCKQUOTE',
  'FIGCAPTION',
  'DT',
  'DD',
  'TD',
  'TH',
]);

const STRUCTURAL_CONTAINER_TAGS = new Set([
  'HTML',
  'BODY',
  'MAIN',
  'FORM',
  'FIELDSET',
  'UL',
  'OL',
  'DL',
  'TABLE',
  'THEAD',
  'TBODY',
  'TFOOT',
  'TR',
  'COLGROUP',
  'COL',
  'FIGURE',
  'DETAILS',
]);

const STRUCTURAL_ROLES = new Set(['main', 'form', 'list', 'table', 'row', 'rowgroup']);
const BLOCK_OUTER_DISPLAYS = new Set([
  'block',
  'flow-root',
  'list-item',
  'flex',
  'grid',
  'table',
  'table-row-group',
  'table-header-group',
  'table-footer-group',
  'table-row',
  'table-cell',
  'table-caption',
]);
const TABLE_STRUCTURE_DISPLAYS = new Set([
  'table',
  'inline-table',
  'table-row-group',
  'table-header-group',
  'table-footer-group',
  'table-row',
  'table-column-group',
  'table-column',
]);

export type ReadingOuterDisplay = 'none' | 'contents' | 'inline' | 'block';
export type ReadingLayout = 'normal' | 'flex' | 'grid' | 'table';

/** A current-render snapshot used only for one decision; host style changes are never cached. */
export interface RenderedReadingSemantics {
  display: string;
  outer: ReadingOuterDisplay;
  layout: ReadingLayout;
  isLayoutItem: boolean;
  isStructuralContainer: boolean;
  isBoundary: boolean;
  canOwnProse: boolean;
}

export type RenderedReadingSemanticsReader = (element: HTMLElement) => RenderedReadingSemantics;

function readOuterDisplay(display: string): ReadingOuterDisplay {
  if (display === 'none') return 'none';
  if (display === 'contents') return 'contents';
  const first = display.split(/\s+/u)[0] ?? '';
  if (first === 'inline' || display.startsWith('inline-')) return 'inline';
  return BLOCK_OUTER_DISPLAYS.has(display) || first === 'block' ? 'block' : 'inline';
}

function readLayout(display: string): ReadingLayout {
  const tokens = display.split(/\s+/u);
  if (display === 'flex' || display === 'inline-flex' || tokens.includes('flex')) return 'flex';
  if (display === 'grid' || display === 'inline-grid' || tokens.includes('grid')) return 'grid';
  if (TABLE_STRUCTURE_DISPLAYS.has(display) || tokens.includes('table')) return 'table';
  return 'normal';
}

export function isSemanticTextFlow(element: Element): boolean {
  return SEMANTIC_TEXT_FLOW_TAGS.has(element.tagName);
}

function isStructuralReadingContainer(element: Element, display?: string): boolean {
  const role = element.getAttribute('role')?.toLowerCase();
  return (
    STRUCTURAL_CONTAINER_TAGS.has(element.tagName) ||
    (role !== undefined && STRUCTURAL_ROLES.has(role)) ||
    (display !== undefined && TABLE_STRUCTURE_DISPLAYS.has(display))
  );
}

function classifyRenderedReadingSemantics(
  element: HTMLElement,
  style: CSSStyleDeclaration,
  parentLayout: ReadingLayout,
): RenderedReadingSemantics {
  const display = style.display.trim().toLowerCase();
  const outer = readOuterDisplay(display);
  const layout = readLayout(display);
  const isLayoutItem =
    outer !== 'none' &&
    outer !== 'contents' &&
    (parentLayout === 'flex' || parentLayout === 'grid');
  const isStructuralContainer = isStructuralReadingContainer(element, display);
  const isControl = element.matches(CONTROL_SELECTOR);
  const isBoundary = isControl || isStructuralContainer || outer === 'block' || isLayoutItem;
  const canOwnProse =
    outer !== 'none' &&
    outer !== 'contents' &&
    !isStructuralContainer &&
    !isControl &&
    (outer === 'block' || isLayoutItem);

  return {
    display,
    outer,
    layout,
    isLayoutItem,
    isStructuralContainer,
    isBoundary,
    canOwnProse,
  };
}

/** Creates an ephemeral style snapshot for one discovery pass, never across host mutations. */
export function createRenderedReadingSemanticsReader(): RenderedReadingSemanticsReader {
  const cache = new WeakMap<HTMLElement, RenderedReadingSemantics>();
  const read: RenderedReadingSemanticsReader = (element) => {
    const cached = cache.get(element);
    if (cached) return cached;
    const parent = element.parentElement;
    const parentLayout = parent ? read(parent).layout : 'normal';
    const semantics = classifyRenderedReadingSemantics(
      element,
      getComputedStyle(element),
      parentLayout,
    );
    cache.set(element, semantics);
    return semantics;
  };
  return read;
}

/** Classifies one element from live styles for callers outside a discovery snapshot. */
export function getRenderedReadingSemantics(element: HTMLElement): RenderedReadingSemantics {
  // A single decision needs only the direct parent's layout, not every ancestor's style.
  const parent = element.parentElement;
  return classifyRenderedReadingSemantics(
    element,
    getComputedStyle(element),
    parent ? readLayout(getComputedStyle(parent).display) : 'normal',
  );
}

export function isRenderedReadingBoundary(
  element: HTMLElement,
  read: RenderedReadingSemanticsReader = getRenderedReadingSemantics,
): boolean {
  return read(element).isBoundary;
}

/** Finds the smallest current rendered owner that can be safely rescanned after a mutation. */
export function findNearestRenderedReadingRoot(start: HTMLElement): HTMLElement {
  const read = createRenderedReadingSemanticsReader();
  let current: HTMLElement | null = start;
  while (current) {
    const semantics = read(current);
    if (
      current.matches(CONTROL_SELECTOR) ||
      semantics.canOwnProse ||
      semantics.isStructuralContainer ||
      semantics.layout === 'flex' ||
      semantics.layout === 'grid'
    )
      return current;
    current = current.parentElement;
  }
  return start;
}
