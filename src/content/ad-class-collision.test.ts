// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  collectOriginalReadingUnits,
  collectTranslatableElements,
  discoverTranslatableElements,
  getElementSourceText,
  renderTranslation,
  restoreDocument,
} from './dom-translator';

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue({ length: 1 } as DOMRectList);
});
afterEach(() => {
  restoreDocument();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

it.each(['ad', 'ads', 'advert', 'advertisement', 'ADS'])(
  'does not infer an excluded subtree from the ordinary class token %s',
  async (token) => {
    // Models a message shell with an outside subject and nested email layout tables,
    // without relying on the site's domain or production selectors.
    document.body.innerHTML = `<main><h2>Message subject outside the body.</h2>
      <div class="adn ${token}" style="display:flex"><div><table role="presentation"><tbody><tr><td>
        <h1>All extension data in one dashboard.</h1>
        <table role="presentation"><tbody><tr><td><p>Readable body with <a href="#details">an inline link</a>.</p></td></tr></tbody></table>
      </td></tr></tbody></table></div></div></main>`;
    const expected = [
      'Message subject outside the body.',
      'All extension data in one dashboard.',
      'Readable body with an inline link.',
    ];
    const original = document.body.innerHTML;
    const link = document.querySelector('a')!;
    const clicked = vi.fn((event: Event) => event.preventDefault());
    link.addEventListener('click', clicked);
    const readOnly = collectOriginalReadingUnits(document.body);
    expect(
      readOnly.map((unit) =>
        unit instanceof HTMLElement
          ? getElementSourceText(unit)
          : unit.nodes
              .map((node) => node.textContent)
              .join('')
              .trim(),
      ),
    ).toEqual(expected);
    expect(document.body.innerHTML).toBe(original);
    const discovered: HTMLElement[] = [];
    for await (const chunk of discoverTranslatableElements(document.body))
      discovered.push(...chunk);
    expect(discovered.map(getElementSourceText)).toEqual(expected);
    expect(
      discovered.some((parent) =>
        discovered.some((child) => parent !== child && parent.contains(child)),
      ),
    ).toBe(false);
    expect(
      collectTranslatableElements(document.querySelector('h1')!).map(getElementSourceText),
    ).toEqual([expected[1]]);
    for (const source of discovered) renderTranslation(source, '完整的测试译文。');
    expect(document.querySelector('a')).toBe(link);
    link.click();
    expect(clicked).toHaveBeenCalledOnce();
    restoreDocument();
    expect(document.body.innerHTML).toBe(original);
    expect(document.querySelector('a')).toBe(link);
  },
);

it.each([
  'role="advertisement"',
  'id="div-gpt-ad-slot"',
  'id="google_ads_slot"',
  'data-ad-slot="123"',
  'translate="no"',
  'class="notranslate ads"',
  'contenteditable="true"',
  'role="textbox"',
  'role="navigation"',
  'style="display:none"',
  'aria-hidden="true"',
])('continues excluding explicit protected boundaries: %s', (attributes) => {
  document.body.innerHTML = `<main><p>Visible original paragraph.</p>
    <div ${attributes}><p id="excluded">Excluded readable paragraph.</p></div></main>`;
  expect(collectTranslatableElements(document.body).map(getElementSourceText)).toEqual([
    'Visible original paragraph.',
  ]);
  expect(collectOriginalReadingUnits(document.querySelector('#excluded')!)).toEqual([]);
});
