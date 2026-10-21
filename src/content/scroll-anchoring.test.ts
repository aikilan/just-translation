// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://x.com/0xCodio/status/2109275834984915150"}
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { renderTranslation, restoreDocument } from './dom-translator';
import { getScrollAnchorExclusionSelector } from './site-rules';

// jsdom has no constructable stylesheets; model only the surface the module uses.
let replaceSync: ReturnType<typeof vi.fn>;
beforeEach(() => {
  replaceSync = vi.fn();
  Object.assign(CSSStyleSheet.prototype, { replaceSync });
  Object.defineProperty(document, 'adoptedStyleSheets', {
    configurable: true,
    writable: true,
    value: [],
  });
});
afterEach(() => {
  restoreDocument();
  document.body.innerHTML = '';
  delete (CSSStyleSheet.prototype as Partial<{ replaceSync: unknown }>).replaceSync;
  delete (document as Partial<{ adoptedStyleSheets: unknown }>).adoptedStyleSheets;
});

it('excludes the X navigation header from scroll anchoring while translations are present', () => {
  document.body.innerHTML = '<header role="banner"></header><main><p>Hello world</p></main>';
  renderTranslation(document.querySelector('p')!, '你好世界');
  renderTranslation(document.querySelector('p')!, '你好，世界');

  expect(document.adoptedStyleSheets).toHaveLength(1);
  expect(replaceSync).toHaveBeenCalledOnce();
  expect(replaceSync).toHaveBeenCalledWith(
    'header[role="banner"] { overflow-anchor: none !important; }',
  );

  restoreDocument();
  expect(document.adoptedStyleSheets).toHaveLength(0);
});

it('keeps page-owned adopted sheets when restoring', () => {
  const pageSheet = new CSSStyleSheet();
  document.adoptedStyleSheets = [pageSheet];
  document.body.innerHTML = '<main><p>Hello world</p></main>';
  renderTranslation(document.querySelector('p')!, '你好世界');
  expect(document.adoptedStyleSheets).toHaveLength(2);

  restoreDocument();
  expect(document.adoptedStyleSheets).toEqual([pageSheet]);
});

it('applies only to X hosts', () => {
  expect(getScrollAnchorExclusionSelector('https://x.com/home')).toBe('header[role="banner"]');
  expect(getScrollAnchorExclusionSelector('https://twitter.com/home')).toBe(
    'header[role="banner"]',
  );
  expect(getScrollAnchorExclusionSelector('https://example.com/')).toBeUndefined();
  expect(getScrollAnchorExclusionSelector('https://notx.com/')).toBeUndefined();
  expect(getScrollAnchorExclusionSelector(undefined)).toBeUndefined();
});
