import type { DisplayMode } from '../shared/settings';
import { getTranslationSiteRule } from './site-rules';
import { yieldToPage } from './render-tasks';
import { PROTECTED_MARKER_PATTERN } from '../shared/protected-markers';

const SOURCE_ATTRIBUTE = 'data-justranslate-source';
const TRANSLATION_ATTRIBUTE = 'data-justranslate-translation';
const SOURCE_CONTENT_ATTRIBUTE = 'data-justranslate-source-content';
const READING_RUN_ATTRIBUTE = 'data-justranslate-reading-run';
const TRANSLATION_STATE_ATTRIBUTE = 'data-justranslate-state';
const TRANSLATION_UNIT_ID_ATTRIBUTE = 'data-justranslate-unit-id';
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
  'button',
  'form',
  'nav',
  'footer',
  'aside',
  'svg',
  'math',
  '[translate="no" i]',
  '.notranslate',
  '[contenteditable="true"]',
  '[aria-hidden="true"]',
  '[role="button"]',
  '[role="menuitem"]',
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
): Generator<HTMLElement | null>;
function iterateReadingElements(
  root: ParentNode,
  options: CollectionOptions,
  readOnly: true,
): Generator<OriginalReadingUnit | null>;
function* iterateReadingElements(
  root: ParentNode,
  options: CollectionOptions,
  readOnly = false,
): Generator<OriginalReadingUnit | null> {
  // Inspection is a fresh observation. Arbitrary host attributes/CSS may change fragment
  // eligibility without hitting the incremental cache's ordinary translation invalidators.
  const ownerDocument = root instanceof Document ? root : root.ownerDocument;
  if (readOnly && ownerDocument) getSourceAnalysisCache(ownerDocument).values = new WeakMap();
  const isVisible = options.isVisible ?? isElementVisible;
  const siteRule = getTranslationSiteRule(options.url);
  const scopes = siteRule ? [root] : findPreferredReadingScopes(root, isVisible);
  const seen = new Set<Element>();
  interface Frame {
    element: HTMLElement;
    entered: boolean;
    children: Element[];
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
  for (const scope of scopes) {
    const roots = scope instanceof HTMLElement ? [scope] : Array.from(scope.children);
    for (const start of roots) {
      if (!(start instanceof HTMLElement)) continue;
      if (start.closest(SKIP_SELECTOR)) continue;
      const header = start.closest('header');
      if (header && !header.closest(ARTICLE_SCOPE_SELECTOR)) continue;
      const stack = [frame(start)];
      while (stack.length > 0) {
        const current = stack[stack.length - 1];
        const { element } = current;
        if (!current.entered) {
          current.entered = true;
          if (seen.has(element) || shouldSkipElement(element) || !isVisible(element)) {
            stack.pop();
            yield null;
            continue;
          }
          seen.add(element);
          if (!readOnly && element.closest(`[${SOURCE_ATTRIBUTE}]`)) {
            stack.pop();
            if (stack.length) stack[stack.length - 1].owned = true;
            yield null;
            continue;
          }
          if (readOnly) {
            const children = originalChildNodes(element);
            const runs = siteRule ? [] : inlineReadingRuns(element, children);
            const runNodes = new Set(runs.flat());
            for (const nodes of runs) {
              const analysis = yield* analyzeFragments(element, nodes);
              // Discovery would create a span for this run. Report the same unit without inserting it.
              if (hasReadableText('SPAN', analysis.text)) {
                current.owned = true;
                yield { nodes };
              }
            }
            current.children = children.filter(
              (node): node is Element => node instanceof Element && !runNodes.has(node),
            );
          } else {
            if (!siteRule) wrapInlineReadingRuns(element);
            current.children = Array.from(element.children);
          }
          yield null;
        }
        const child = current.children[current.next++];
        if (child) {
          if (child instanceof HTMLElement) stack.push(frame(child));
          continue;
        }
        stack.pop();
        if (current.owned) {
          if (stack.length) stack[stack.length - 1].owned = true;
          continue;
        }
        const matches = siteRule
          ? element.matches(siteRule.includeSelectors.join(','))
          : element.matches(READING_BLOCK_SELECTOR) ||
            element.hasAttribute(READING_RUN_ATTRIBUTE) ||
            (element.tagName === 'SPAN' &&
              !!element.parentElement &&
              hasLayoutRisk(element.parentElement));
        if (!matches || hasLayoutRisk(element)) continue;
        if (!siteRule && element.tagName === 'A' && hasInlineReadingOwner(element)) continue;
        const analysis = yield* analyzeSourceFragments(element);
        if (!hasReadableText(element.tagName, analysis.text)) {
          if (!readOnly) unwrapReadingRun(element);
          continue;
        }
        if (stack.length) stack[stack.length - 1].owned = true;
        yield element;
      }
    }
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
    container.insertBefore(anchor, nodes[0]);
    anchor.append(...nodes);
  }
}

/** Grouping is shared by materializing discovery and read-only inspection, including raw prose. */
function inlineReadingRuns(container: HTMLElement, children: Node[]): Node[][] {
  if (
    !container.matches('main,article,section,div,li,td,th,blockquote') ||
    hasLayoutRisk(container)
  )
    return [];
  const blockSelector = `${SEMANTIC_READING_ANCESTOR_SELECTOR},div,section,article,header,ul,ol,table,dl,[${READING_RUN_ATTRIBUTE}]`;
  const isBoundary = (node: Node) =>
    node instanceof Element &&
    (node.matches(blockSelector) || (shouldSkipElement(node) && !node.matches(PROTECTED_SELECTOR)));
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
    if (node instanceof HTMLElement && node.hasAttribute(TRANSLATION_ATTRIBUTE)) return [];
    if (node instanceof HTMLElement && node.hasAttribute(SOURCE_CONTENT_ATTRIBUTE))
      return originalChildNodes(node);
    return [node];
  });
}

function unwrapReadingRun(source: HTMLElement): void {
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

function findPreferredReadingScopes(
  root: ParentNode,
  isVisible: (element: HTMLElement) => boolean,
): ParentNode[] {
  const mainScopes = findScopes(root, MAIN_SCOPE_SELECTOR, isVisible);
  if (mainScopes.length > 0) return mainScopes;

  const articleScopes = findScopes(root, ARTICLE_SCOPE_SELECTOR, isVisible);
  return articleScopes.length > 0 ? articleScopes : [root];
}

function findScopes(
  root: ParentNode,
  selector: string,
  isVisible: (element: HTMLElement) => boolean,
): HTMLElement[] {
  const scopes: HTMLElement[] = [];
  if (root instanceof HTMLElement && root.matches(selector) && isVisible(root)) scopes.push(root);
  scopes.push(
    ...Array.from(root.querySelectorAll<HTMLElement>(selector)).filter((element) =>
      isVisible(element),
    ),
  );
  return scopes;
}

function hasLayoutRisk(element: HTMLElement): boolean {
  return ['flex', 'inline-flex', 'grid', 'inline-grid'].includes(getComputedStyle(element).display);
}

export function getElementSourceText(element: HTMLElement): string {
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
      if (mutation.type === 'attributes' && element.hasAttribute(SOURCE_CONTENT_ATTRIBUTE))
        continue;
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
    attributes: true,
    attributeFilter: ['style', 'class', 'hidden', 'aria-hidden', 'translate'],
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
  const cache = getSourceAnalysisCache(element.ownerDocument);
  const cached = cache.values.get(element);
  if (cached) return cached;
  const revision = cache.revision;
  const sourceContent = element.querySelector<HTMLElement>(
    `:scope > [${SOURCE_CONTENT_ATTRIBUTE}]`,
  );
  const analysis = yield* analyzeFragments(
    element,
    Array.from((sourceContent ?? element).childNodes),
    sourceContent ?? undefined,
  );
  cache.drain();
  // Async discovery may overlap mutation; only cache a reading made at the current revision.
  if (cache.revision === revision) cache.values.set(element, analysis);
  return analysis;
}

function* analyzeFragments(
  element: HTMLElement,
  nodes: readonly Node[],
  sourceContent?: HTMLElement,
): Generator<null, SourceAnalysis> {
  const protectedText = new Map<string, string>();
  const characterCounts = new Map<HTMLElement, number>();
  const parts: string[] = [];
  const stack = [...nodes].reverse();
  const literalText = nodes.map((node) => node.textContent ?? '').join('');
  let markerIndex = 0;
  while (stack.length) {
    const node = stack.pop()!;
    if (node.nodeType === 3) {
      parts.push((node.textContent ?? '').replace(/\s+/gu, ' '));
      const parent = node.parentElement === sourceContent ? element : node.parentElement;
      const count = node.textContent?.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
      if (parent && count) characterCounts.set(parent, (characterCounts.get(parent) ?? 0) + count);
    } else if (node instanceof Element) {
      const style = getComputedStyle(node);
      if (
        node.hasAttribute('hidden') ||
        style.display === 'none' ||
        style.visibility === 'hidden'
      ) {
        yield null;
        continue;
      }
      if (node.matches(PROTECTED_SELECTOR)) {
        let marker: string;
        do {
          marker = `[[JT_KEEP_${markerIndex++}]]`;
        } while (literalText.includes(marker));
        protectedText.set(marker, node.textContent ?? '');
        parts.push(marker);
      } else if (!shouldSkipElement(node) && !node.hasAttribute('hidden')) {
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
  const typography = getTranslationElement(source) ? undefined : captureDominantTypography(source);
  const { protectedText } = readSourceFragments(source);
  let text = translatedText;
  for (const [marker, original] of protectedText) {
    if (!text.includes(marker)) throw new Error('AI 返回中缺少原样保留标记');
    text = text.replaceAll(marker, original);
  }
  return () => {
    const translation = ensureTranslationElement(source, typography);
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
  const translation = ensureTranslationElement(source);
  setTranslationState(translation, 'pending');
  translation.setAttribute(TRANSLATION_UNIT_ID_ATTRIBUTE, unitId);
  translation.setAttribute('aria-label', '正在翻译');
  translation.removeAttribute('role');
  translation.removeAttribute('tabindex');
  // The visual state is a CSS spinner; keep the DOM empty so no loading copy affects layout.
  translation.textContent = '';
  return translation;
}

/** Exposes a generic, keyboard-accessible retry control without leaking provider details. */
export function renderTranslationError(source: HTMLElement, unitId: string): HTMLElement {
  const translation = ensureTranslationElement(source);
  setTranslationState(translation, 'error');
  translation.setAttribute(TRANSLATION_UNIT_ID_ATTRIBUTE, unitId);
  translation.setAttribute('aria-label', '翻译失败 · 重试');
  translation.setAttribute('role', 'button');
  translation.tabIndex = 0;
  translation.removeAttribute('title');
  translation.textContent = '翻译失败 · 重试';
  return translation;
}

function ensureTranslationElement(
  source: HTMLElement,
  snapshot?: TranslationTypography,
): HTMLElement {
  const existing = getTranslationElement(source);
  if (existing) return existing;

  const typography = snapshot ?? captureDominantTypography(source);
  source.setAttribute(SOURCE_ATTRIBUTE, '');
  const translation = document.createElement('span');
  translation.setAttribute(TRANSLATION_ATTRIBUTE, '');
  translation.setAttribute('dir', 'auto');
  applyTranslationTypography(translation, typography);

  const sourceContent = document.createElement('span');
  sourceContent.setAttribute(SOURCE_CONTENT_ATTRIBUTE, '');
  while (source.firstChild) sourceContent.append(source.firstChild);
  source.append(sourceContent, translation);
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
  return Object.fromEntries(
    TRANSLATION_TYPOGRAPHY_PROPERTIES.map((property) => [
      property,
      computedStyle.getPropertyValue(property),
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
  document.querySelectorAll<HTMLElement>(`[${SOURCE_ATTRIBUTE}]`).forEach((source) => {
    setSourceDisplayMode(source, mode);
  });
}

/** Batch commits touch their own nodes only; a full-page walk is reserved for explicit mode changes. */
export function setSourceDisplayMode(source: HTMLElement, mode: DisplayMode): void {
  const sourceContent = source.querySelector<HTMLElement>(`:scope > [${SOURCE_CONTENT_ATTRIBUTE}]`);
  const translationIsReady =
    getTranslationElement(source)?.getAttribute(TRANSLATION_STATE_ATTRIBUTE) === 'translated';
  if (sourceContent) sourceContent.hidden = mode === 'translation' && translationIsReady;
}

export function restoreDocument(): void {
  document
    .querySelectorAll<HTMLElement>(`[${SOURCE_ATTRIBUTE}]`)
    .forEach((source) => restoreSourceElement(source));
  cleanupReadingRuns();
}

export function restoreSourceElement(source: HTMLElement): void {
  const translation = getTranslationElement(source);
  translation?.remove();

  const sourceContent = source.querySelector<HTMLElement>(`:scope > [${SOURCE_CONTENT_ATTRIBUTE}]`);
  if (sourceContent) {
    while (sourceContent.firstChild) source.insertBefore(sourceContent.firstChild, sourceContent);
    sourceContent.remove();
  }
  source.removeAttribute(SOURCE_ATTRIBUTE);
  unwrapReadingRun(source);
}

function getTranslationElement(source: HTMLElement): HTMLElement | null {
  return source.querySelector<HTMLElement>(`:scope > [${TRANSLATION_ATTRIBUTE}]`);
}

function hasReadableText(tagName: string, text: string): boolean {
  text = text.replace(PROTECTED_MARKER_PATTERN, '').trim();
  if (!text || !/\p{L}/u.test(text)) return false;
  if (isMetadataOnly(text) || isCodeLikeText(text)) return false;
  const minimumLength = ['DIV', 'ARTICLE', 'SECTION'].includes(tagName) ? 20 : 2;
  return text.length >= minimumLength;
}

function isMetadataOnly(text: string): boolean {
  const compact = text.trim();
  if (/^(?:https?:\/\/|www\.)\S+$/iu.test(compact)) return true;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(compact)) return true;
  if (/^\d{1,4}(?:[-/.]\d{1,2}){1,2}(?:\s+\d{1,2}:\d{2})?$/u.test(compact)) return true;
  if (/^\d{2,4}年(?:\d{1,2}月)?(?:\d{1,2}日)?$/u.test(compact)) return true;
  return /^[A-Z][A-Z0-9&.+-]{1,30}$/u.test(compact);
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
  if (element.hidden) return false;
  const style = getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  return element.getClientRects().length > 0;
}
