// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getElementTranslationPriority } from './viewport';

const rect = (top: number, left = 10, height = 20, width = 100): DOMRect =>
  new DOMRect(left, top, width, height);
afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});
describe('reading viewport', () => {
  it.each([
    [10, 10, 'visible'],
    [-10, 10, 'visible'],
    [-40, 10, 'background'],
    [10, 2000, 'background'],
    [10, -200, 'background'],
    [800, 10, 'readAhead'],
    [3000, 10, 'background'],
  ] as const)('classifies top=%s left=%s as %s', (top, left, expected) => {
    document.body.innerHTML = '<p>Readable text.</p>';
    vi.spyOn(document.querySelector('p')!, 'getBoundingClientRect').mockReturnValue(
      rect(top, left),
    );
    expect(getElementTranslationPriority(document.querySelector('p')!)).toBe(expected);
  });
  it('intersects nested scroll clipping on both axes', () => {
    document.body.innerHTML =
      '<main style="overflow:auto"><section style="overflow:hidden"><p>Nested text.</p></section></main>';
    vi.spyOn(document.querySelector('main')!, 'getBoundingClientRect').mockReturnValue(
      rect(100, 100, 300, 300),
    );
    vi.spyOn(document.querySelector('section')!, 'getBoundingClientRect').mockReturnValue(
      rect(150, 150, 100, 100),
    );
    const source = document.querySelector('p')!;
    const bounds = vi.spyOn(source, 'getBoundingClientRect');
    bounds.mockReturnValue(rect(160, 160));
    expect(getElementTranslationPriority(source)).toBe('visible');
    bounds.mockReturnValue(rect(300, 160));
    expect(getElementTranslationPriority(source)).toBe('readAhead');
    bounds.mockReturnValue(rect(160, 300));
    expect(getElementTranslationPriority(source)).toBe('background');
  });
});
