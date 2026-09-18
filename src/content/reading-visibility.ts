/** A subtree can be traversed even when its owner has no box or hides only its own text.
 * `ignoreHidden` is reserved for original nodes hidden by our translation-only mode.
 */
export function canTraverseReadingSubtree(
  element: Element,
  style: CSSStyleDeclaration = getComputedStyle(element),
  ignoreHidden = false,
): boolean {
  if (!ignoreHidden && (element.hasAttribute('hidden') || style.display === 'none')) return false;
  if (style.contentVisibility === 'hidden' || style.opacity === '0') return false;
  const parent = element.parentElement;
  if (
    parent?.matches('details:not([open])') &&
    element !== parent.querySelector(':scope > summary')
  )
    return false;
  return true;
}

/** Visibility is inherited but descendants may explicitly restore it; never use this to prune. */
export function isReadingTextVisible(
  element: Element,
  style: CSSStyleDeclaration = getComputedStyle(element),
): boolean {
  return !['hidden', 'collapse'].includes(style.visibility);
}
