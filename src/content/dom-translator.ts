import {
  applyDocumentTitleTranslations,
  applyTitleTranslation,
  getTitleSourceText,
  isDocumentTitle,
  restoreDocumentTitles,
  restoreTitle,
  stageTitleTranslation,
} from './document-title';
import { getElementTranslationPriority } from './viewport';
import type { DisplayMode } from '../shared/settings';
import { getTranslationSiteRule } from './site-rules';
import { yieldToPage } from './render-tasks';
import { PROTECTED_MARKER_PATTERN } from '../shared/protected-markers';
import { canTraverseReadingSubtree, isReadingTextVisible } from './reading-visibility';
import {
  getLabelSource,
  getLabelText,
  getLabelTextParent,
  registerLabelSource,
  releaseLabelSource,
  setLabelTextHidden,
} from './label-presentation';

import {
  SOURCE_TEXT_ATTRIBUTE,
  getPresentedSources,
  isHiddenByTranslation,
  isSourcePresentationMutation,
  prepareSourcePresentation,
  restoreSourcePresentation,
  setOriginalContentHidden,
} from './source-presentation';

const SOURCE_ATTRIBUTE = 'data-justranslate-source';
const TRANSLATION_ATTRIBUTE = 'data-justranslate-translation';

const READING_RUN_ATTRIBUTE = 'data-justranslate-reading-run';
const TRANSLATION_STATE_ATTRIBUTE = 'data-justranslate-state';
const TRANSLATION_UNIT_ID_ATTRIBUTE = 'data-justranslate-unit-id';
const LABEL_ATTRIBUTE = 'data-justranslate-label';
const CONTROL_SELECTOR =
  'button,label,legend,summary,[role="button"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="option"],[role="tab"],[role="checkbox"],[role="radio"],[role="switch"],[role="combobox"]';
const OVERLAY_SELECTOR = 'dialog,[role="dialog"],[role="listbox"],[role="menu"]';
export type TranslationUnitKind = 'prose' | 'label';

/** Compact interface leaves and control text use inline, translation-only presentation. */
export function getTranslationUnitKind(element: HTMLElement): TranslationUnitKind {
  if (element.hasAttribute(LABEL_ATTRIBUTE) || element.closest(CONTROL_SELECTOR)) return 'label';
  const compact =
    element.matches('div,span') &&
    !element.closest(SEMANTIC_READING_ANCESTOR_SELECTOR) &&
    (element.tagName !== 'SPAN' ||
      !hasInlineReadingOwner(element) ||
      (element.parentElement?.textContent?.trim().length ?? 0) < 20) &&
    !element.querySelector(
      `${SEMANTIC_READING_ANCESTOR_SELECTOR},div,section,article,${CONTROL_SELECTOR}`,
    ) &&
    (element.textContent?.trim().length ?? 0) < 20;
  return compact ? 'label' : 'prose';
}

const SOURCE_COLOR_PROPERTY = '--justranslate-source-color';
const TRANSLATION_TYPOGRAPHY_PROPERTIES = [
  'color',
  'font-family',
  'font-size',
  'font-style',
  'font-weight',
  'font-stretch',
  'font-variant',
  'line-height',
  'letter-spacing',
  'word-spacing',
  'text-align',
  'text-decoration-color',
  'text-decoration-line',
  'text-decoration-style',
  'text-decoration-thickness',
  'text-indent',
  'text-shadow',
  'text-transform',
] as const;

type TranslationTypographyProperty = (typeof TRANSLATION_TYPOGRAPHY_PROPERTIES)[number];
type TranslationTypography = Readonly<Record<TranslationTypographyProperty, string>>;

const READING_BLOCK_SELECTOR = [
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'li',
  'blockquote',
  'figcaption',
  'dt',
  'dd',
  'td',
  'th',
  'a',
  'article',
  'section',
  'div',
].join(',');

const SEMANTIC_READING_ANCESTOR_SELECTOR = [
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'li',
  'blockquote',
  'figcaption',
  'dt',
  'dd',
  'td',
  'th',
].join(',');

const SKIP_SELECTOR = [
  'script',
  'style',
  'noscript',
  'template',
  'pre',
  'code',
  'kbd',
  'samp',
  'textarea',
  'input',
  'select',
  'nav',
  'footer',
  'aside',
  'svg',
  'math',
  '[translate="no" i]',
  '.notranslate',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="textbox"]',
  '[aria-hidden="true"]',
  '[role="navigation"]',
  '[role="banner"]',
  '[role="complementary"]',
  '[role="contentinfo"]',
  '[role="advertisement"]',
  '[id^="div-gpt-ad" i]',
  '[id^="google_ads" i]',
  '[data-ad-slot]',
  '[class~="ad" i]',
  '[class~="ads" i]',
  '[class~="advert" i]',
  '[class~="advertisement" i]',
  `[${TRANSLATION_ATTRIBUTE}]`,
].join(',');

const MAIN_SCOPE_SELECTOR = 'main,[role="main"]';
const ARTICLE_SCOPE_SELECTOR = 'article,[role="article"]';
const PROTECTED_SELECTOR = 'code,kbd,samp,math,[translate="no" i],.notranslate';

export interface CollectionOptions {
  isVisible?: (element: HTMLElement) => boolean;
  url?: string;
  /** Restrict candidate extraction, never ancestor traversal, to the current reading viewport. */
  viewportOnly?: boolean;
  /** Already claimed reading leaves can be skipped before traversing their inline descendants. */
  knownElements?: ReadonlySet<HTMLElement>;
}

interface DiscoveryOptions extends CollectionOptions {
  signal?: AbortSignal;
  yieldTask?: () => Promise<void>;
}

/** Selects reading-oriented leaf blocks and avoids controls, code, and duplicate ancestors. */
export function collectTranslatableElements(
  root: ParentNode,
  options: CollectionOptions = {},
): HTMLElement[] {
  return [...iterateReadingElements(root, options)].filter((element) => element !== null);
}

/** An added prose run has no original anchor yet; inspection must report it without writing DOM. */
export interface UnanchoredReadingRun {
  nodes: readonly Node[];
}
export type OriginalReadingUnit = HTMLElement | UnanchoredReadingRun;

/** Reuses the same reading rules, but treats our content wrappers as transparent and never writes. */
export function collectOriginalReadingUnits(
  root: ParentNode,
  options: CollectionOptions = {},
): OriginalReadingUnit[] {
  return [...iterateReadingElements(root, options, true)].filter((unit) => unit !== null);
}

export function discoverOriginalReadingUnits(
  root: ParentNode,
  options: DiscoveryOptions = {},
): AsyncGenerator<OriginalReadingUnit[], void> {
  return discoverReadingUnits(iterateReadingElements(root, options, true), options);
}

/** Emits a first microbatch without traversing the rest of the page; traversal itself is budgeted. */
export function discoverTranslatableElements(
  root: ParentNode,
  options: DiscoveryOptions = {},
): AsyncGenerator<HTMLElement[], void> {
  return discoverReadingUnits(iterateReadingElements(root, options), options);
}

async function* discoverReadingUnits<T>(
  iterator: Generator<T | null>,
  options: DiscoveryOptions,
): AsyncGenerator<T[], void> {
  let chunk: T[] = [];
  let startedAt = performance.now();
  let visited = 0;
  let maximum = 4;
  for (const element of iterator) {
    if (options.signal?.aborted) return;
    if (element) chunk.push(element);
    visited += 1;
    if (chunk.length >= maximum || visited >= 300 || performance.now() - startedAt >= 8) {
      if (chunk.length > 0) {
        yield chunk;
        chunk = [];
        maximum = 24;
      }
      if (options.signal?.aborted) return;
      await (options.yieldTask ?? yieldToPage)();
      startedAt = performance.now();
      visited = 0;
    }
  }
  if (!options.signal?.aborted && chunk.length > 0) yield chunk;
}

/** Postorder traversal claims leaves before ancestors without materializing all reading candidates. */
function iterateReadingElements(
  root: ParentNode,
  options: CollectionOptions,
  readOnly?: false,
  withinScope?: boolean,
): Generator<HTMLElement | null>;
function iterateReadingElements(
  root: ParentNode,
  options: CollectionOptions,
  readOnly: true,
  withinScope?: boolean,
): Generator<OriginalReadingUnit | null>;
function* iterateReadingElements(
  root: ParentNode,
  options: CollectionOptions,
  readOnly = false,
  withinScope = false,
): Generator<OriginalReadingUnit | null> {
  // Inspection is a fresh observation. Arbitrary host attributes/CSS may change fragment
  // eligibility without hitting the incremental cache's ordinary translation invalidators.
  const ownerDocument = root instanceof Document ? root : root.ownerDocument;
  if (readOnly && ownerDocument) getSourceAnalysisCache(ownerDocument).values = new WeakMap();
  // A page scan includes its tab title even though the normal reading root is body.
  // Scoped rescans include it only when the changed subtree actually owns the title.
  const title = ownerDocument?.head?.querySelector('title');
  if (
    title &&
    !withinScope &&
    (root === ownerDocument?.body || root === ownerDocument || root.contains(title)) &&
    !options.knownElements?.has(title) &&
    !title.closest('[translate="no" i],.notranslate') &&
    /\p{L}/u.test(getTitleSourceText(title))
  )
    yield title;
  const isVisible = options.isVisible ?? isElementVisible;
  const siteRule = getTranslationSiteRule(options.url);
  const scopeGroups =
    siteRule || withinScope ? [[root]] : findPreferredReadingScopes(root, options);
  const seen = new Set<Element>();
  interface Frame {
    element: HTMLElement;
    entered: boolean;
    children: (Element | Node[])[];
    next: number;
    owned: boolean;
  }
  const frame = (element: HTMLElement): Frame => ({
    element,
    entered: false,
    children: [],
    next: 0,
    owned: false,
  });
  for (const scopes of scopeGroups) {
    if (!scopes) {
      yield null;
      continue;
    }
    let hasReadingUnit = false;
    for (const scope of scopes) {
      const roots = scope instanceof HTMLElement ? [scope] : Array.from(scope.children);
      for (const start of roots) {
        if (!(start instanceof HTMLElement)) continue;
        if (start.closest(SKIP_SELECTOR) || hasSuppressedAncestor(start)) continue;
        const header = start.closest('header');
        if (header && !header.closest(ARTICLE_SCOPE_SELECTOR)) continue;
        const stack = [frame(start)];
        while (stack.length > 0) {
          const current = stack[stack.length - 1];
          const { element } = current;
          if (!current.entered) {
            current.entered = true;
            if (options.knownElements?.has(element)) {
              hasReadingUnit = true;
              stack.pop();
              if (stack.length) stack[stack.length - 1].owned = true;
              yield null;
              continue;
            }
            if (
              seen.has(element) ||
              shouldSkipElement(element) ||
              !canTraverseReadingSubtree(
                element,
                getComputedStyle(element),
                isHiddenByTranslation(element),
              ) ||
              (options.isVisible && !options.isVisible(element))
            ) {
              stack.pop();
              yield null;
              continue;
            }
            seen.add(element);
            if (!readOnly && element.closest(`[${SOURCE_ATTRIBUTE}]`)) {
              hasReadingUnit = true;
              stack.pop();
              if (stack.length) stack[stack.length - 1].owned = true;
              yield null;
              continue;
            }
            if (readOnly) {
              const children = originalChildNodes(element);
              const runs = siteRule ? [] : inlineReadingRuns(element, children);
              const runNodes = new Set(runs.flat());
              const runStarts = new Map(runs.map((nodes) => [nodes[0], nodes]));
              current.children = [];
              // Inspect virtual runs at their DOM position, just like materialized anchors.
              for (const node of children) {
                const run = runStarts.get(node);
                if (run) current.children.push(run);
                else if (node instanceof Element && !runNodes.has(node))
                  current.children.push(node);
              }
            } else {
              if (!siteRule) wrapInlineReadingRuns(element);
              current.children = Array.from(element.children);
            }
            yield null;
          }
          const child = current.children[current.next++];
          if (child) {
            if (Array.isArray(child)) {
              const analysis = yield* analyzeFragments(element, child);
              if (hasReadableText(analysis.text, !!element.closest(CONTROL_SELECTOR))) {
                hasReadingUnit = true;
                current.owned = true;
                yield { nodes: child };
              }
            }
            if (child instanceof HTMLElement) stack.push(frame(child));
            continue;
          }
          stack.pop();
          if (current.owned) {
            if (stack.length) stack[stack.length - 1].owned = true;
            continue;
          }
          const inlineLayoutChild =
            !element.matches(READING_BLOCK_SELECTOR) &&
            !!element.parentElement &&
            hasLayoutRisk(element.parentElement);
          // A semantic sentence retains its inline emphasis/text; layout divs still own separate items.
          if (
            inlineLayoutChild &&
            !element.hasAttribute(READING_RUN_ATTRIBUTE) &&
            element.parentElement?.matches(SEMANTIC_READING_ANCESTOR_SELECTOR) &&
            !element.parentElement.querySelector(SEMANTIC_READING_ANCESTOR_SELECTOR)
          )
            continue;
          const matches = siteRule
            ? element.matches(siteRule.includeSelectors.join(','))
            : element.matches(READING_BLOCK_SELECTOR) ||
              element.hasAttribute(READING_RUN_ATTRIBUTE) ||
              inlineLayoutChild ||
              (element.matches('span') &&
                getTranslationUnitKind(element) === 'label' &&
                (!hasInlineReadingOwner(element) ||
                  (element.parentElement?.textContent?.trim().length ?? 0) < 20));
          if (!matches || !isVisible(element)) continue;
          // Empty layout owners must not absorb controls or nested blocks rejected during discovery.
          if (
            hasLayoutRisk(element) &&
            element.querySelector(`${SEMANTIC_READING_ANCESTOR_SELECTOR},div,section,article`)
          )
            continue;
          if (!siteRule && element.tagName === 'A' && hasInlineReadingOwner(element)) continue;
          const analysis = yield* analyzeSourceFragments(element);
          if (!hasReadableText(analysis.text, !!element.closest(CONTROL_SELECTOR))) {
            if (!readOnly) unwrapReadingRun(element);
            continue;
          }
          // Scope authority depends on readable text, even when it is outside this viewport pass.
          hasReadingUnit = true;
          if (options.viewportOnly && getElementTranslationPriority(element) !== 'visible') {
            if (stack.length) stack[stack.length - 1].owned = true;
            continue;
          }
          if (stack.length) stack[stack.length - 1].owned = true;
          yield element;
        }
      }
    }
    if (hasReadingUnit) return;
  }
}

function shouldSkipElement(element: Element): boolean {
  return (
    element.matches(SKIP_SELECTOR) ||
    (element.tagName === 'HEADER' && !element.closest(ARTICLE_SCOPE_SELECTOR))
  );
}

/** Inline links belong to the surrounding sentence, not to an independent translation unit.
 * Do not absorb links into layout containers that also contain separate reading blocks.
 */
function hasInlineReadingOwner(element: HTMLElement): boolean {
  if (element.parentElement?.closest(`[${READING_RUN_ATTRIBUTE}]`)) return true;
  const semantic = element.parentElement?.closest(SEMANTIC_READING_ANCESTOR_SELECTOR);
  if (semantic) return true;
  const owner = element.parentElement?.closest<HTMLElement>('div,section,article');
  if (!owner || hasLayoutRisk(owner)) return false;
  return !owner.querySelector(`${SEMANTIC_READING_ANCESTOR_SELECTOR},div,section,article`);
}

/** Mixed containers need disjoint reading units: a nested paragraph must not swallow its
 * surrounding raw prose. Reversible anchors move the original nodes (never clone links/events). */
function wrapInlineReadingRuns(container: HTMLElement): void {
  for (const nodes of inlineReadingRuns(container, Array.from(container.childNodes))) {
    const anchor = container.ownerDocument.createElement('span');
    anchor.setAttribute(READING_RUN_ATTRIBUTE, '');
    if (getTranslationUnitKind(container) === 'label') anchor.setAttribute(LABEL_ATTRIBUTE, '');
    if (
      getTranslationUnitKind(container) === 'label' &&
      nodes.length === 1 &&
      nodes[0].nodeType === Node.TEXT_NODE
    ) {
      registerLabelSource(anchor, nodes[0] as Text);
    } else {
      container.insertBefore(anchor, nodes[0]);
      anchor.append(...nodes);
    }
  }
}

/** Grouping is shared by materializing discovery and read-only inspection, including raw prose. */
function inlineReadingRuns(container: HTMLElement, children: Node[]): Node[][] {
  if (container.hasAttribute(READING_RUN_ATTRIBUTE)) return [];
  // Anchor only text, never the button or its icons/input/badge children.
  if (getTranslationUnitKind(container) === 'label')
    return children
      .filter(
        (node) =>
          node.nodeType === Node.TEXT_NODE &&
          !getLabelSource(node) &&
          /\p{L}/u.test(node.textContent ?? ''),
      )
      .map((node) => [node]);
  if (
    !container.matches(
      `main,article,section,div,form,fieldset,${SEMANTIC_READING_ANCESTOR_SELECTOR}`,
    )
  )
    return [];
  if (hasLayoutRisk(container)) {
    if (
      container.matches(SEMANTIC_READING_ANCESTOR_SELECTOR) &&
      !container.querySelector(`${SEMANTIC_READING_ANCESTOR_SELECTOR},${CONTROL_SELECTOR}`)
    )
      return [];
    // A text node is an anonymous flex/grid item. Anchor only text runs, never reparent element items.
    if (!children.some((node) => node instanceof Element)) return [];
    return children
      .filter((node) => node.nodeType === 3 && /\p{L}/u.test(node.textContent ?? ''))
      .map((node) => [node]);
  }
  const blockSelector = `${SEMANTIC_READING_ANCESTOR_SELECTOR},div,section,article,header,ul,ol,table,dl,details,summary,[${READING_RUN_ATTRIBUTE}]`;
  const isBoundary = (node: Node) =>
    node instanceof Element &&
    (node.matches(blockSelector) ||
      ((shouldSkipElement(node) || node.matches(CONTROL_SELECTOR) || node.matches('form')) &&
        !node.matches(PROTECTED_SELECTOR)));
  if (!children.some(isBoundary)) return [];
  const runs: Node[][] = [];
  let run: Node[] = [];
  const flush = () => {
    // A lone link remains its own reading node; only prose needs a synthetic anchor.
    const ownsProse = run.some(
      (node) =>
        (node.nodeType === 3 && /\p{L}/u.test(node.textContent ?? '')) ||
        (node instanceof HTMLElement &&
          node.tagName !== 'A' &&
          !node.matches(PROTECTED_SELECTOR) &&
          /\p{L}/u.test(node.textContent ?? '')),
    );
    if (ownsProse) runs.push(run);
    run = [];
  };
  for (const node of children) {
    if (isBoundary(node)) flush();
    else run.push(node);
  }
  flush();
  return runs;
}

/** Preserve host nodes and ignore only extension-owned feedback/container indirection. */
function originalChildNodes(element: HTMLElement): Node[] {
  return Array.from(element.childNodes).flatMap((node) => {
    if (getLabelSource(node)) return [];
    if (node instanceof HTMLElement && node.hasAttribute(TRANSLATION_ATTRIBUTE)) return [];
    if (node instanceof HTMLElement && node.hasAttribute(SOURCE_TEXT_ATTRIBUTE))
      return originalChildNodes(node);
    return [node];
  });
}

function unwrapReadingRun(source: HTMLElement): void {
  if (releaseLabelSource(source)) return;
  if (source.hasAttribute(READING_RUN_ATTRIBUTE)) source.replaceWith(...source.childNodes);
}

/** Also removes unselected/queued anchors when translation is stopped before preflight completes. */
export function cleanupReadingRuns(): void {
  document
    .querySelectorAll<HTMLElement>(`[${READING_RUN_ATTRIBUTE}]:not([${SOURCE_ATTRIBUTE}])`)
    .forEach(unwrapReadingRun);
  sourceAnalysisCaches.get(document)?.disconnect();
  sourceAnalysisCaches.delete(document);
}

/** Local discovery intersects the same page-level scopes used by initial discovery. */
function* findPreferredReadingScopes(
  root: ParentNode,
  options: CollectionOptions,
): Generator<ParentNode[] | null> {
  const isVisible = options.isVisible ?? canTraverseReadingSubtree;
  const page = root.ownerDocument?.body;
  const local = !!page && root instanceof Node && root !== page && page.contains(root);
  const scopeRoot = local ? page : root;
  const overlays = findScopes(scopeRoot, OVERLAY_SELECTOR, isVisible);
  const mainScopes = findScopes(scopeRoot, MAIN_SCOPE_SELECTOR, isVisible);
  const articleScopes = findScopes(scopeRoot, ARTICLE_SCOPE_SELECTOR, isVisible);
  const groups = [
    ...(mainScopes.length ? [[...mainScopes, ...overlays]] : []),
    ...(articleScopes.length ? [[...articleScopes, ...overlays]] : []),
    [scopeRoot],
  ];
  for (const scopes of groups) {
    if (!local) {
      yield scopes;
      continue;
    }
    // Probe without changing DOM and stop at the first readable unit. Keep yielding traversal
    // work so async discovery retains its budget even when a preferred scope is empty/hidden.
    let readable = false;
    for (const scope of scopes) {
      for (const unit of iterateReadingElements(
        scope,
        { ...options, knownElements: undefined, viewportOnly: false },
        true,
        true,
      )) {
        if (unit) {
          readable = true;
          break;
        }
        yield null;
      }
      if (readable) break;
    }
    if (!readable) continue;
    yield scopes.flatMap((scope) =>
      scope.contains(root) ? [root] : root.contains(scope) ? [scope] : [],
    );
    return;
  }
}

function findScopes(
  root: ParentNode,
  selector: string,
  isVisible: (element: HTMLElement) => boolean,
): HTMLElement[] {
  const scopes: HTMLElement[] = [];
  if (
    root instanceof HTMLElement &&
    root.matches(selector) &&
    isVisible(root) &&
    !hasSuppressedAncestor(root)
  )
    scopes.push(root);
  scopes.push(
    ...Array.from(root.querySelectorAll<HTMLElement>(selector)).filter(
      (element) => isVisible(element) && !hasSuppressedAncestor(element),
    ),
  );
  return scopes;
}

function hasLayoutRisk(element: HTMLElement): boolean {
  return ['flex', 'inline-flex', 'grid', 'inline-grid'].includes(getComputedStyle(element).display);
}

export function getElementSourceText(element: HTMLElement): string {
  if (isDocumentTitle(element)) return getTitleSourceText(element).replace(/\s+/gu, ' ').trim();
  return readSourceFragments(element).text;
}

interface SourceAnalysis {
  text: string;
  protectedText: Map<string, string>;
  dominant: HTMLElement;
}

interface SourceAnalysisCache {
  values: WeakMap<HTMLElement, SourceAnalysis>;
  revision: number;
  drain: () => void;
  disconnect: () => void;
}

const sourceAnalysisCaches = new WeakMap<Document, SourceAnalysisCache>();

/** A DOM analysis cache, not a translation cache. Drain mutations before every read so even
 * synchronous page changes invalidate text/markers/styles before a request or render can use them. */
function getSourceAnalysisCache(document: Document): SourceAnalysisCache {
  const existing = sourceAnalysisCaches.get(document);
  if (existing) {
    existing.drain();
    return existing;
  }
  const cache: SourceAnalysisCache = {
    values: new WeakMap(),
    revision: 0,
    drain: () => undefined,
    disconnect: () => undefined,
  };
  const invalidate = (mutations: MutationRecord[]) => {
    for (const mutation of mutations) {
      const element =
        mutation.target.nodeType === 1
          ? (mutation.target as Element)
          : mutation.target.parentElement;
      if (!element || element.closest(`[${TRANSLATION_ATTRIBUTE}]`)) continue;
      if (isSourcePresentationMutation(mutation)) continue;
      cache.revision += 1;
      if (mutation.type === 'attributes' || element.closest('style,head')) {
        // Inherited typography or a stylesheet can affect any descendant's dominant text.
        cache.values = new WeakMap();
        continue;
      }
      for (let current: Element | null = element; current; current = current.parentElement) {
        cache.values.delete(current as HTMLElement);
      }
    }
  };
  const observer = new MutationObserver(invalidate);
  observer.observe(document, {
    subtree: true,
    childList: true,
    characterData: true,
    characterDataOldValue: true,
    attributes: true,
  });
  cache.drain = () => invalidate(observer.takeRecords());
  cache.disconnect = () => observer.disconnect();
  sourceAnalysisCaches.set(document, cache);
  return cache;
}

function readSourceFragments(element: HTMLElement): SourceAnalysis {
  const analysis = analyzeSourceFragments(element);
  let result = analysis.next();
  while (!result.done) result = analysis.next();
  return result.value;
}

/** The same fragment walker serves synchronous validation and budgeted discovery. Protected
 * values remain local; only visible, unprotected text contributes to dominant typography. */
function* analyzeSourceFragments(element: HTMLElement): Generator<null, SourceAnalysis> {
  const label = getLabelText(element);
  if (label !== undefined)
    return {
      text: label.replace(/\s+/gu, ' ').trim(),
      protectedText: new Map(),
      dominant: getLabelTextParent(element) ?? element,
    };
  const cache = getSourceAnalysisCache(element.ownerDocument);
  const cached = cache.values.get(element);
  if (cached) return cached;
  const revision = cache.revision;
  const analysis = yield* analyzeFragments(element, originalChildNodes(element));
  cache.drain();
  // Async discovery may overlap mutation; only cache a reading made at the current revision.
  if (cache.revision === revision) cache.values.set(element, analysis);
  return analysis;
}

function* analyzeFragments(
  element: HTMLElement,
  nodes: readonly Node[],
): Generator<null, SourceAnalysis> {
  const protectedText = new Map<string, string>();
  const characterCounts = new Map<HTMLElement, number>();
  const styles = new Map<Element, CSSStyleDeclaration>();
  const styleOf = (owner: Element): CSSStyleDeclaration => {
    let style = styles.get(owner);
    if (!style) {
      style = getComputedStyle(owner);
      styles.set(owner, style);
    }
    return style;
  };
  const parts: string[] = [];
  const stack = [...nodes].reverse();
  const literalText = nodes.map((node) => node.textContent ?? '').join('');
  let markerIndex = 0;
  while (stack.length) {
    const node = stack.pop()!;
    if (node.nodeType === 3) {
      const parent = node.parentElement?.hasAttribute(SOURCE_TEXT_ATTRIBUTE)
        ? node.parentElement.parentElement
        : node.parentElement;
      if (
        !parent ||
        !isReadingTextVisible(parent, styleOf(parent)) ||
        parent.matches('details:not([open])')
      ) {
        yield null;
        continue;
      }
      parts.push((node.textContent ?? '').replace(/\s+/gu, ' '));
      const count = node.textContent?.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
      if (parent && count) characterCounts.set(parent, (characterCounts.get(parent) ?? 0) + count);
    } else if (node instanceof Element) {
      const style = styleOf(node);
      if (!canTraverseReadingSubtree(node, style, isHiddenByTranslation(node))) {
        yield null;
        continue;
      }
      if (node.matches(PROTECTED_SELECTOR)) {
        if (!isReadingTextVisible(node, style)) {
          yield null;
          continue;
        }
        let marker: string;
        do {
          marker = `[[JT_KEEP_${markerIndex++}]]`;
        } while (literalText.includes(marker));
        protectedText.set(marker, node.textContent ?? '');
        parts.push(marker);
      } else if (!shouldSkipElement(node)) {
        if (node.tagName === 'BR') parts.push('\n');
        else stack.push(...Array.from(node.childNodes).reverse());
      }
    }
    yield null;
  }
  let dominant = element;
  let largestCount = -1;
  for (const [owner, count] of characterCounts) {
    if (count <= largestCount) continue;
    dominant = owner;
    largestCount = count;
  }
  const analysis: SourceAnalysis = {
    text: parts
      .join('')
      .replace(/[^\S\n]+/gu, ' ')
      .trim(),
    protectedText,
    dominant,
  };

  return analysis;
}

/** Reads the nearest BCP-47 declaration so the background can safely filter target text. */
export function getElementDeclaredLanguage(element: HTMLElement): string | undefined {
  const language = element.closest<HTMLElement>('[lang]')?.getAttribute('lang')?.trim();
  return language || undefined;
}

/** Keeps source and translation inside the same semantic block to preserve parent DOM structure. */
export function renderTranslation(source: HTMLElement, translatedText: string): HTMLElement {
  return prepareTranslationRender(source, translatedText)();
}

/** Read-only preparation lets callers batch typography reads before any DOM writes. */
export function prepareTranslationRender(
  source: HTMLElement,
  translatedText: string,
): () => HTMLElement {
  if (isDocumentTitle(source))
    return () => {
      stageTitleTranslation(source, translatedText);
      return source;
    };
  const preparation = getTranslationElement(source) ? undefined : prepareTranslationElement(source);
  const { protectedText } = readSourceFragments(source);
  let text = translatedText;
  for (const [marker, original] of protectedText) {
    if (!text.includes(marker)) throw new Error('AI 返回中缺少原样保留标记');
    text = text.replaceAll(marker, original);
  }
  return () => {
    const translation = ensureTranslationElement(source, preparation);
    setTranslationState(translation, 'translated');
    translation.removeAttribute(TRANSLATION_UNIT_ID_ATTRIBUTE);
    translation.removeAttribute('aria-label');
    translation.removeAttribute('role');
    translation.removeAttribute('tabindex');
    translation.textContent = text;
    return translation;
  };
}

/** Creates immediate per-node feedback before any API request is awaited. */
export function renderTranslationPending(source: HTMLElement, unitId: string): HTMLElement {
  if (isDocumentTitle(source)) return source;
  const translation = ensureTranslationElement(source);
  setTranslationState(translation, 'pending');
  translation.setAttribute(TRANSLATION_UNIT_ID_ATTRIBUTE, unitId);
  if (getTranslationUnitKind(source) === 'label') return translation;
  translation.setAttribute('aria-label', '正在翻译');
  translation.removeAttribute('role');
  translation.removeAttribute('tabindex');
  // The visual state is a CSS spinner; keep the DOM empty so no loading copy affects layout.
  translation.textContent = '';
  return translation;
}

/** Exposes a generic, keyboard-accessible retry control without leaking provider details. */
export function renderTranslationError(source: HTMLElement, unitId: string): HTMLElement {
  if (isDocumentTitle(source)) return source;
  const translation = ensureTranslationElement(source);
  setTranslationState(translation, 'error');
  translation.setAttribute(TRANSLATION_UNIT_ID_ATTRIBUTE, unitId);
  if (getTranslationUnitKind(source) === 'label') {
    if (!setLabelTextHidden(source, false)) setOriginalContentHidden(source, false);
    translation.replaceChildren();
    translation.removeAttribute('role');
    translation.removeAttribute('tabindex');
    translation.removeAttribute('aria-label');
    return translation;
  }
  translation.setAttribute('aria-label', '翻译失败 · 重试');
  translation.setAttribute('role', 'button');
  translation.tabIndex = 0;
  translation.removeAttribute('title');
  translation.textContent = '翻译失败 · 重试';
  return translation;
}

interface TranslationElementPreparation {
  typography: TranslationTypography;
  present: () => void;
}

function prepareTranslationElement(source: HTMLElement): TranslationElementPreparation {
  return {
    typography: captureDominantTypography(source),
    present: prepareSourcePresentation(source, getTranslationUnitKind(source) === 'label'),
  };
}

function ensureTranslationElement(
  source: HTMLElement,
  preparation?: TranslationElementPreparation,
): HTMLElement {
  const existing = getTranslationElement(source);
  if (existing) return existing;

  const { typography, present } = preparation ?? prepareTranslationElement(source);
  source.setAttribute(SOURCE_ATTRIBUTE, '');
  if (getTranslationUnitKind(source) === 'label') source.setAttribute(LABEL_ATTRIBUTE, '');
  const translation = document.createElement('span');
  translation.setAttribute(TRANSLATION_ATTRIBUTE, '');
  translation.setAttribute('dir', 'auto');
  applyTranslationTypography(translation, typography);

  present();
  source.append(translation);
  return translation;
}

function setTranslationState(
  translation: HTMLElement,
  state: 'pending' | 'translated' | 'error',
): void {
  translation.setAttribute(TRANSLATION_STATE_ATTRIBUTE, state);
  const sourceColor = translation.style.getPropertyValue(SOURCE_COLOR_PROPERTY);
  if (sourceColor) {
    translation.style.setProperty('color', sourceColor, 'important');
  }
}

/** Captures typography before the source is wrapped and page selectors can change. */
function captureDominantTypography(source: HTMLElement): TranslationTypography {
  const reference = readSourceFragments(source).dominant;
  const computedStyle = getComputedStyle(reference);
  // Browsers conceal :visited colors in computed styles. A translation inside a link
  // must inherit its live color, including when the saved color is reapplied on retry.
  const inheritsLinkColor = source.closest('a[href]') !== null;
  return Object.fromEntries(
    TRANSLATION_TYPOGRAPHY_PROPERTIES.map((property) => [
      property,
      property === 'color' && inheritsLinkColor
        ? 'inherit'
        : computedStyle.getPropertyValue(property),
    ]),
  ) as TranslationTypography;
}

function applyTranslationTypography(
  translation: HTMLElement,
  typography: TranslationTypography,
): void {
  for (const property of TRANSLATION_TYPOGRAPHY_PROPERTIES) {
    const value = typography[property];
    if (value) translation.style.setProperty(property, value, 'important');
  }
  if (typography.color) {
    translation.style.setProperty(SOURCE_COLOR_PROPERTY, typography.color);
  }
}

export function setDocumentDisplayMode(mode: DisplayMode): void {
  applyDocumentTitleTranslations();
  document.querySelectorAll<HTMLElement>(`[${SOURCE_ATTRIBUTE}]`).forEach((source) => {
    setSourceDisplayMode(source, mode);
  });
}

/** Batch commits touch their own nodes only; a full-page walk is reserved for explicit mode changes. */
export function setSourceDisplayMode(source: HTMLElement, mode: DisplayMode): void {
  if (isDocumentTitle(source)) {
    applyTitleTranslation(source);
    return;
  }
  const translationIsReady =
    getTranslationElement(source)?.getAttribute(TRANSLATION_STATE_ATTRIBUTE) === 'translated';
  const hidden =
    (mode === 'translation' || getTranslationUnitKind(source) === 'label') && translationIsReady;
  if (!setLabelTextHidden(source, hidden)) setOriginalContentHidden(source, hidden);
}

export function restoreDocument(): void {
  restoreDocumentTitles();
  getPresentedSources(document).forEach(restoreSourceElement);
  cleanupReadingRuns();
}

export function restoreSourceElement(source: HTMLElement): void {
  if (isDocumentTitle(source)) {
    restoreTitle(source);
    return;
  }
  const translation = getTranslationElement(source);
  translation?.remove();

  restoreSourcePresentation(source);
  source.removeAttribute(SOURCE_ATTRIBUTE);
  source.removeAttribute(LABEL_ATTRIBUTE);
  unwrapReadingRun(source);
}

function getTranslationElement(source: HTMLElement): HTMLElement | null {
  return source.querySelector<HTMLElement>(`:scope > [${TRANSLATION_ATTRIBUTE}]`);
}

/** Reads raw original text without style/layout access for the final synchronous commit guard. */
export function getOriginalSourceText(element: HTMLElement): string {
  if (isDocumentTitle(element)) return getTitleSourceText(element);
  const label = getLabelText(element);
  if (label !== undefined) return label;
  return originalChildNodes(element)
    .map((node) => node.textContent ?? '')
    .join('');
}

function hasReadableText(text: string, label = false): boolean {
  text = text.replace(PROTECTED_MARKER_PATTERN, '').trim();
  if (!text || !/\p{L}/u.test(text)) return false;
  if (isMetadataOnly(text, label) || isCodeLikeText(text)) return false;
  return true;
}

function isMetadataOnly(text: string, label: boolean): boolean {
  const compact = text.trim();
  if (/^(?:https?:\/\/|www\.)\S+$/iu.test(compact)) return true;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(compact)) return true;
  if (/^\d{1,4}(?:[-/.]\d{1,2}){1,2}(?:\s+\d{1,2}:\d{2})?$/u.test(compact)) return true;
  if (/^\d{2,4}年(?:\d{1,2}月)?(?:\d{1,2}日)?$/u.test(compact)) return true;
  return !label && /^[A-Z][A-Z0-9&.+-]{1,30}$/u.test(compact);
}

function isCodeLikeText(text: string): boolean {
  let score = 0;
  if (
    /(?:^|[^\p{L}])(?:function|const|let|var|return|document|window|googletag)(?:$|[^\p{L}])/iu.test(
      text,
    )
  ) {
    score += 1;
  }
  if (/(?:=>|===|!==|\{[^}]*\}|;)/u.test(text)) score += 1;
  if ((text.match(/[\w$]+(?:\.[\w$]+)+\s*\(/gu)?.length ?? 0) >= 1) score += 1;
  if ((text.match(/[{}()[\];]/gu)?.length ?? 0) >= 6) score += 1;
  return score >= 2;
}

function isElementVisible(element: HTMLElement): boolean {
  return (
    isReadingTextVisible(element) &&
    (isHiddenByTranslation(element) || element.getClientRects().length > 0)
  );
}

/** Preferred scopes and incremental roots must not bypass hidden ancestors. */
function hasSuppressedAncestor(element: HTMLElement): boolean {
  for (let current: Element | null = element; current; current = current.parentElement) {
    if (
      !canTraverseReadingSubtree(current, getComputedStyle(current), isHiddenByTranslation(current))
    )
      return true;
  }
  return false;
}
