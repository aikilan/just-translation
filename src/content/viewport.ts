import type { TranslationPriority } from '../shared/messages';

/** Classifies a reading block against both viewport axes and ancestor scroll clipping. */
export function getElementTranslationPriority(element: HTMLElement): TranslationPriority {
  const height = window.innerHeight || document.documentElement.clientHeight;
  const width = window.innerWidth || document.documentElement.clientWidth;
  const bounds = element.getBoundingClientRect();
  if (bounds.right < 0 || bounds.left > width) return 'background';
  let top = 0;
  let bottom = height;
  let left = 0;
  let right = width;
  for (
    let parent = element.parentElement;
    parent && parent !== document.body;
    parent = parent.parentElement
  ) {
    const style = getComputedStyle(parent);
    const clipsX = /^(auto|scroll|hidden|clip)$/.test(style.overflowX || style.overflow);
    const clipsY = /^(auto|scroll|hidden|clip)$/.test(style.overflowY || style.overflow);
    if (!clipsX && !clipsY) continue;
    const clip = parent.getBoundingClientRect();
    if (clipsX) {
      left = Math.max(left, clip.left);
      right = Math.min(right, clip.right);
    }
    if (clipsY) {
      top = Math.max(top, clip.top);
      bottom = Math.min(bottom, clip.bottom);
    }
  }
  if (bounds.right < left || bounds.left > right || right < left || bottom < top)
    return 'background';
  if (bounds.bottom >= top && bounds.top <= bottom) return 'visible';
  if (bounds.top > bottom && bounds.top <= bottom + (bottom - top)) return 'readAhead';
  return 'background';
}
