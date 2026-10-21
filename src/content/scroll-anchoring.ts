import { getScrollAnchorExclusionSelector } from './site-rules';

const exclusionSheets = new WeakMap<Document, CSSStyleSheet>();

/** Lets native scroll anchoring keep the reader in place while translations grow the page.
 * An adopted sheet writes no DOM, so neither page nor translation observers see this change.
 */
export function excludeHostScrollAnchors(document: Document): void {
  if (exclusionSheets.has(document) || !('adoptedStyleSheets' in document)) return;
  const selector = getScrollAnchorExclusionSelector(document.location?.href);
  if (!selector) return;
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`${selector} { overflow-anchor: none !important; }`);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  exclusionSheets.set(document, sheet);
}

export function restoreHostScrollAnchors(document: Document): void {
  const sheet = exclusionSheets.get(document);
  if (!sheet) return;
  exclusionSheets.delete(document);
  document.adoptedStyleSheets = document.adoptedStyleSheets.filter((value) => value !== sheet);
}
