// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  collectOriginalReadingUnits,
  collectTranslatableElements,
  getElementSourceText,
  getTranslationUnitKind,
  discoverTranslatableElements,
  renderTranslation,
  restoreDocument,
  type OriginalReadingUnit,
} from './dom-translator';

const collectionOptions = { isVisible: () => true };

function collectTexts(): string[] {
  return collectTranslatableElements(document.body, collectionOptions).map(getElementSourceText);
}

function getOriginalUnitText(unit: OriginalReadingUnit): string {
  if (unit instanceof HTMLElement) return getElementSourceText(unit);
  return unit.nodes
    .map((node) => node.textContent ?? '')
    .join('')
    .replace(/\s+/gu, ' ')
    .trim();
}

describe('rendered reading semantics', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    restoreDocument();
    vi.restoreAllMocks();
  });

  it('accounts for every text node around a block nested inside inline wrappers', () => {
    document.body.innerHTML =
      '<main><x-owner style="display:block">Before words <x-inline>inside before <x-block style="display:block">Nested words</x-block> inside after</x-inline> after words.</x-owner></main>';
    const original = document.body.innerHTML;
    const inline = document.querySelector('x-inline')!;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const texts: Node[] = [];
    while (walker.nextNode()) texts.push(walker.currentNode);
    const inspected = collectOriginalReadingUnits(document.body, collectionOptions).map(
      getOriginalUnitText,
    );
    const units = collectTranslatableElements(document.body, collectionOptions);
    expect(units.map(getElementSourceText)).toEqual([
      'Before words',
      'inside before',
      'Nested words',
      'inside after',
      'after words.',
    ]);
    expect(units.map(getElementSourceText)).toEqual(inspected);
    for (const node of texts) expect(units.filter((unit) => unit.contains(node))).toHaveLength(1);
    for (const unit of units) renderTranslation(unit, '译文');
    restoreDocument();
    expect(document.querySelector('x-inline')).toBe(inline);
    expect(document.body.innerHTML).toBe(original);
  });

  it('keeps short inline text in the custom sentence that owns it', () => {
    document.body.innerHTML =
      '<main><x-owner style="display:block">Read <span>this</span>.</x-owner></main>';
    expect(collectTexts()).toEqual(['Read this.']);
  });

  it.each(['span', 'div', 'x-heading'])(
    'classifies a short independent %s block as prose',
    (tag) => {
      document.body.innerHTML = `<main><${tag} style="display:block">Short title</${tag}></main>`;
      const source = document.querySelector<HTMLElement>('main > *')!;
      expect(collectTranslatableElements(document.body, collectionOptions)).toEqual([source]);
      expect(getTranslationUnitKind(source)).toBe('prose');
    },
  );

  it.each(['inline-flex', 'inline-grid'])('preserves pure text in an embedded %s', (display) => {
    document.body.innerHTML = `<main><p>Before <x-inline style="display:${display}">middle words</x-inline> after.</p></main>`;
    expect(collectTexts()).toEqual(['Before middle words after.']);
  });

  it('does not repeatedly traverse an inline owner for every child', () => {
    document.body.innerHTML = `<main><div>${'<span>readable words </span>'.repeat(100)}</div></main>`;
    const owner = document.querySelector('div')!;
    const children = vi.spyOn(owner, 'children', 'get');
    expect(collectTexts()).toHaveLength(1);
    expect(children.mock.calls.length).toBeLessThan(10);
  });

  it('yields and can cancel during structure analysis of a large inline tree', async () => {
    document.body.innerHTML = `<main><x-owner style="display:block">${'<x-inline>readable words </x-inline>'.repeat(2000)}</x-owner></main>`;
    const abort = new AbortController();
    const yielded = vi.fn(() => {
      abort.abort();
      return Promise.resolve();
    });
    const units: HTMLElement[] = [];
    for await (const chunk of discoverTranslatableElements(document.body, {
      ...collectionOptions,
      signal: abort.signal,
      yieldTask: yielded,
    }))
      units.push(...chunk);
    expect(yielded).toHaveBeenCalled();
    expect(units).toEqual([]);
  });

  it('collects arbitrary light-DOM block elements without overlapping their inline children', () => {
    document.body.innerHTML = `
      <main>
        <x-heading style="display:block"><x-text style="display:inline">A custom heading</x-text></x-heading>
        <x-paragraph style="display:block">A custom paragraph with <a href="/guide">an inline link</a>.</x-paragraph>
        <x-quote style="display:block"><x-text style="display:inline">A custom quotation.</x-text></x-quote>
      </main>
    `;

    const elements = collectTranslatableElements(document.body, collectionOptions);

    expect(elements.map(getElementSourceText)).toEqual([
      'A custom heading',
      'A custom paragraph with an inline link.',
      'A custom quotation.',
    ]);
    expect(
      elements.some((owner) => elements.some((unit) => owner !== unit && owner.contains(unit))),
    ).toBe(false);
    expect(getTranslationUnitKind(document.querySelector('x-heading')!)).toBe('prose');
  });

  it('uses rendered display instead of tag names to decide inline and block ownership', () => {
    document.body.innerHTML = `
      <main>
        <div id="sentence" style="display:block">Before <div style="display:inline">inline words</div> after.</div>
        <span id="standalone" style="display:block">A span rendered as an independent reading block.</span>
      </main>
    `;

    expect(collectTexts()).toEqual([
      'Before inline words after.',
      'A span rendered as an independent reading block.',
    ]);
  });

  it('covers block display variants while keeping inline formatting inside its sentence', () => {
    document.body.innerHTML = `
      <main>
        <x-flow style="display:flow-root">Flow-root reading content.</x-flow>
        <x-list-item style="display:list-item">List-item reading content.</x-list-item>
        <x-cell style="display:table-cell">Table-cell reading content.</x-cell>
        <p>Sentence with <x-chip style="display:inline-block">inline-block words</x-chip> and <x-wrap style="display:contents"><em>contents text</em></x-wrap>.</p>
        <x-hidden style="display:none">Hidden custom content.</x-hidden>
      </main>
    `;

    expect(collectTexts()).toEqual([
      'Flow-root reading content.',
      'List-item reading content.',
      'Table-cell reading content.',
      'Sentence with inline-block words and contents text.',
    ]);
  });

  it('splits custom block prose around nested blocks and controls in DOM order', () => {
    document.body.innerHTML = `
      <main>
        <x-container style="display:block">Opening <a href="/guide">guide text</a>.
          <x-paragraph style="display:block">Nested custom paragraph.</x-paragraph>
          Between blocks <button>Confirm action</button> Closing words.
        </x-container>
      </main>
    `;

    expect(collectTexts()).toEqual([
      'Opening guide text.',
      'Nested custom paragraph.',
      'Between blocks',
      'Confirm action',
      'Closing words.',
    ]);
  });

  it('keeps direct flex and grid items independent regardless of their tag names', () => {
    document.body.innerHTML = `
      <main>
        <x-flex style="display:flex"><x-item>First flex item.</x-item><span>Second flex item.</span></x-flex>
        <x-grid style="display:grid"><x-item>First grid item.</x-item><span>Second grid item.</span></x-grid>
      </main>
    `;

    expect(collectTexts()).toEqual([
      'First flex item.',
      'Second flex item.',
      'First grid item.',
      'Second grid item.',
    ]);
  });

  it('keeps read-only and materialized custom-element discovery equivalent', () => {
    document.body.innerHTML = `
      <main>
        <x-paragraph style="display:block">Before <button>Submit form</button> after.</x-paragraph>
      </main>
    `;

    const inspected = collectOriginalReadingUnits(document.body, collectionOptions).map(
      getOriginalUnitText,
    );
    const materialized = collectTexts();

    expect(inspected).toEqual(['Before', 'Submit form', 'after.']);
    expect(materialized).toEqual(inspected);
  });

  it('preserves custom-element child identity, events, styles and exact restoration', () => {
    document.body.innerHTML = `
      <main><x-paragraph style="display:block;color:rgb(12, 34, 56)">Read <strong>the complete guide</strong>.</x-paragraph></main>
    `;
    const originalHtml = document.body.innerHTML;
    const source = document.querySelector<HTMLElement>('x-paragraph')!;
    const strong = source.querySelector('strong')!;
    const onClick = vi.fn();
    strong.addEventListener('click', onClick);

    expect(collectTranslatableElements(document.body, collectionOptions)).toEqual([source]);
    renderTranslation(source, '阅读完整指南。');
    strong.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    restoreDocument();

    expect(onClick).toHaveBeenCalledOnce();
    expect(source.querySelector('strong')).toBe(strong);
    expect(source.style.color).toBe('rgb(12, 34, 56)');
    expect(document.body.innerHTML).toBe(originalHtml);
  });
});
