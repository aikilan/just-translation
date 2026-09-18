// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  collectOriginalReadingUnits,
  collectTranslatableElements,
  getElementSourceText,
  renderTranslation,
  prepareTranslationRender,
  restoreDocument,
  setDocumentDisplayMode,
} from './dom-translator';
import { getElementTranslationPriority } from './viewport';

beforeEach(() => {
  // jsdom has no layout; model browser box existence, leaving CSS visibility to the collector.
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function (
    this: HTMLElement,
  ) {
    return {
      length: ['none', 'contents'].includes(getComputedStyle(this).display) ? 0 : 1,
    } as DOMRectList;
  });
});
afterEach(() => {
  restoreDocument();
  document.body.innerHTML = '';
  document.head.innerHTML = '';
  vi.restoreAllMocks();
});

describe('style-aware reading discovery', () => {
  it('ignores hidden preferred main scopes when a visible article exists elsewhere', () => {
    document.body.innerHTML =
      '<div style="display:none"><main><p>Hidden article text.</p></main></div><article><p id="target">Visible article text.</p></article>';
    expect(collectTranslatableElements(document.body)).toEqual([document.querySelector('#target')]);
  });

  it.each(['flex', 'grid'])(
    'preserves an entire %s sentence with inline links and emphasis',
    (display) => {
      document.body.innerHTML = `<main><p id="target" style="display:${display}">Before <a href="/guide">the link</a> and <em>emphasis</em> after.</p></main>`;
      const source = document.querySelector('p')!;
      expect(collectTranslatableElements(document.body)).toEqual([source]);
      expect(getElementSourceText(source)).toBe('Before the link and emphasis after.');
    },
  );
  it.each([
    '<div style="display:contents"><p id="target">Visible reading paragraph.</p></div>',
    '<div style="visibility:hidden"><p id="target" style="visibility:visible">Visible reading paragraph.</p></div>',
    '<p id="target" style="display:flex">Visible reading paragraph.</p>',
    '<p id="target" style="display:grid">Visible reading paragraph.</p>',
    '<div style="display:flex"><em id="target">Visible reading paragraph.</em></div>',
  ])('discovers readable leaves without claiming their ancestors: %s', (html) => {
    document.body.innerHTML = `<main>${html}<p id="control">Another reading paragraph.</p></main>`;
    const expected = [document.querySelector('#target'), document.querySelector('#control')];
    expect(collectTranslatableElements(document.body)).toEqual(expected);
    expect(collectOriginalReadingUnits(document.body)).toEqual(expected);
  });

  it.each([
    'display:none',
    'visibility:hidden',
    'visibility:collapse',
    'content-visibility:hidden',
    'opacity:0',
  ])('excludes a hidden subtree from both discovery and source text: %s', (style) => {
    document.body.innerHTML = `<main><div style="${style}"><p>Hidden reading paragraph.</p></div><p id="target">Visible <span style="${style}">hidden words</span>reading paragraph.</p></main>`;
    const [target] = collectTranslatableElements(document.body);
    expect(collectTranslatableElements(document.body)).toEqual([document.querySelector('#target')]);
    expect(getElementSourceText(target)).toBe('Visible reading paragraph.');
  });

  it('reads visible descendants inside a hidden inline ancestor', () => {
    document.body.innerHTML =
      '<main><p>Before <span style="visibility:hidden">hidden <em style="visibility:visible">visible</em></span> after.</p></main>';
    expect(getElementSourceText(document.querySelector('p')!)).toBe('Before visible after.');
  });

  it('does not bypass a hidden ancestor when starting from a preferred main scope', () => {
    document.body.innerHTML =
      '<div style="content-visibility:hidden"><main><p>Hidden article paragraph.</p></main></div>';
    expect(collectTranslatableElements(document.body)).toEqual([]);
  });

  it('excludes closed details content and discovers it after opening', () => {
    document.body.innerHTML =
      '<main><details><summary>Toggle</summary><p id="target">Hidden reading paragraph.</p></details></main>';
    expect(collectTranslatableElements(document.body)).not.toContain(
      document.querySelector('#target'),
    );
    document.querySelector('details')!.open = true;
    expect(collectTranslatableElements(document.body)).toContain(document.querySelector('#target'));
  });

  it('preserves raw text alongside separate flex items without duplicate ownership', () => {
    document.body.innerHTML =
      '<main><div style="display:flex">Opening raw prose.<span>Another readable item.</span></div></main>';
    const units = collectTranslatableElements(document.body);
    expect(units.map(getElementSourceText)).toEqual([
      'Opening raw prose.',
      'Another readable item.',
    ]);
    expect(collectOriginalReadingUnits(document.body)).toEqual(units);
  });

  it('invalidates fragment visibility when arbitrary host attributes change CSS', () => {
    document.head.innerHTML = '<style>[data-state="closed"] span{display:none}</style>';
    document.body.innerHTML = '<main><p>Visible <span>extra words</span>.</p></main>';
    const source = document.querySelector('p')!;
    expect(getElementSourceText(source)).toBe('Visible extra words.');
    source.dataset.state = 'closed';
    expect(getElementSourceText(source)).toBe('Visible .');
  });

  it('does not clip the viewport against a contents ancestor without a layout box', () => {
    document.body.innerHTML =
      '<main><div style="display:contents;overflow:hidden"><p>Visible reading paragraph.</p></div></main>';
    const source = document.querySelector('p')!;
    vi.spyOn(source, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 10, 100, 20));
    expect(getElementTranslationPriority(source)).toBe('visible');
  });
});

describe('non-destructive translation rendering', () => {
  it('hides and restores inline SVG without moving it out of the original parent', () => {
    document.body.innerHTML =
      '<main><p>Visible words.<svg viewBox="0 0 10 10"><path d="M0 0 L10 10" /></svg></p></main>';
    const source = document.querySelector('p')!;
    const icon = source.querySelector('svg')!;
    const original = source.outerHTML;
    renderTranslation(source, '译文。');
    setDocumentDisplayMode('translation');
    expect(icon.hasAttribute('hidden')).toBe(true);
    expect(icon.parentElement).toBe(source);
    restoreDocument();
    expect(source.outerHTML).toBe(original);
  });
  it('preserves host inline edits between render preparation and commit', () => {
    document.body.innerHTML =
      '<main><p style="height:20px;overflow:hidden">Visible reading paragraph.</p></main>';
    const source = document.querySelector('p')!;
    const commit = prepareTranslationRender(source, '译文。');
    source.style.height = '40px';
    const original = source.outerHTML;
    commit();
    restoreDocument();
    expect(source.outerHTML).toBe(original);
  });
  it('preserves existing child element hierarchy, styling, events and restore identity', () => {
    document.head.innerHTML = '<style>p > .emphasis{font-weight:700}</style>';
    document.body.innerHTML = '<main><p>Hello <a class="emphasis">reading link</a>.</p></main>';
    const source = document.querySelector('p')!;
    const link = source.querySelector('a')!;
    const clicked = vi.fn();
    link.addEventListener('click', clicked);
    const original = source.outerHTML;
    renderTranslation(source, '你好。');
    expect(link.parentElement).toBe(source);
    expect(getComputedStyle(link).fontWeight).toBe('700');
    link.click();
    expect(clicked).toHaveBeenCalledOnce();
    setDocumentDisplayMode('translation');
    expect(link.hidden).toBe(true);
    expect(getElementSourceText(source)).toBe('Hello reading link.');
    setDocumentDisplayMode('bilingual');
    expect(link.hidden).toBe(false);
    restoreDocument();
    expect(source.outerHTML).toBe(original);
    expect(source.querySelector('a')).toBe(link);
  });

  it.each([
    'height:20px;max-height:20px;overflow:hidden',
    'display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:1;overflow:hidden',
  ])(
    'releases only the reading block clipping and restores its exact inline styles: %s',
    (style) => {
      document.body.innerHTML = `<main style="overflow:auto"><p style="${style}">Visible reading paragraph.</p></main>`;
      const source = document.querySelector('p')!;
      const original = source.outerHTML;
      renderTranslation(source, '可见的译文。');
      // Assert effective axes: jsdom does not recompute overflow shorthand from longhands.
      expect(getComputedStyle(source).overflowX).toBe('visible');
      expect(getComputedStyle(source).overflowY).toBe('visible');
      expect(getComputedStyle(document.querySelector('main')!).overflow).toBe('auto');
      restoreDocument();
      expect(source.outerHTML).toBe(original);
    },
  );

  it('preserves page style edits made while translation is present', () => {
    document.body.innerHTML =
      '<main><p style="height:20px;overflow:hidden">Visible reading paragraph.</p></main>';
    const source = document.querySelector('p')!;
    renderTranslation(source, '译文。');
    source.style.color = 'red';
    source.style.height = '80px';
    restoreDocument();
    expect(source.style.height).toBe('80px');
    expect(source.style.color).toBe('red');
    expect(source.style.overflow).toBe('hidden');
  });

  it('preserves initially hidden children when switching modes and restores them exactly', () => {
    document.body.innerHTML =
      '<main><p>Visible words.<span hidden="until-found">Hidden words.</span></p></main>';
    const source = document.querySelector('p')!;
    const child = source.querySelector('span')!;
    const original = source.outerHTML;
    renderTranslation(source, '译文。');
    setDocumentDisplayMode('translation');
    setDocumentDisplayMode('bilingual');
    expect(child.getAttribute('hidden')).toBe('until-found');
    restoreDocument();
    expect(source.outerHTML).toBe(original);
  });
});
