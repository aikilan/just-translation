// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  collectTranslatableElements,
  renderTranslation,
  restoreDocument,
  setDocumentDisplayMode,
} from './dom-translator';

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue({ length: 1 } as DOMRectList);
});
afterEach(() => {
  restoreDocument();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

it('restores original elements even after the host moves them outside the translated source', () => {
  document.body.innerHTML =
    '<main><p id="source"><em>Visible original paragraph.</em></p><div id="destination"></div></main>';
  const source = document.querySelector<HTMLElement>('#source')!;
  const moved = source.querySelector('em')!;
  renderTranslation(source, '译文。');
  setDocumentDisplayMode('translation');
  document.querySelector('#destination')!.append(moved);
  restoreDocument();
  expect(moved.hidden).toBe(false);
  expect(moved.hasAttribute('data-justranslate-source-content')).toBe(false);
});

it('keeps identical replacement content hidden when switching to translation-only mode', () => {
  document.body.innerHTML = '<main><p id="source"><em>Visible original paragraph.</em></p></main>';
  const source = document.querySelector<HTMLElement>('#source')!;
  renderTranslation(source, '译文。');
  const replacement = document.createElement('strong');
  replacement.textContent = 'Visible original paragraph.';
  source.querySelector('em')!.replaceWith(replacement);
  setDocumentDisplayMode('translation');
  expect(replacement.closest('[hidden]')).not.toBeNull();
});

it('does not let an entirely visibility-hidden main displace a visible article', () => {
  document.body.innerHTML =
    '<main style="visibility:hidden"><p>Hidden reading paragraph.</p></main><article><p id="visible">Visible reading paragraph.</p></article>';
  expect(collectTranslatableElements(document.body)).toEqual([document.querySelector('#visible')]);
});

it('restores overflow longhands while preserving unrelated host style edits', () => {
  document.body.innerHTML =
    '<main><p style="overflow-y:hidden;height:20px">Visible reading paragraph.</p></main>';
  const source = document.querySelector('p')!;
  renderTranslation(source, '译文。');
  source.style.color = 'red';
  restoreDocument();
  expect(source.style.overflowY).toBe('hidden');
  expect(source.style.color).toBe('red');
});

it('restores detached sources before the host reinserts them', () => {
  document.body.innerHTML = '<main><p><em>Visible original paragraph.</em></p></main>';
  const source = document.querySelector('p')!;
  const original = source.outerHTML;
  renderTranslation(source, '译文。');
  setDocumentDisplayMode('translation');
  source.remove();
  restoreDocument();
  document.querySelector('main')!.append(source);
  expect(source.outerHTML).toBe(original);
  restoreDocument();
  expect(source.outerHTML).toBe(original);
});

it('transfers a moved child between sources without preserving the old managed hidden state', () => {
  document.body.innerHTML =
    '<main><p id="first"><em>Visible original paragraph.</em></p><p id="second">Second paragraph.</p></main>';
  const first = document.querySelector<HTMLElement>('#first')!;
  const second = document.querySelector<HTMLElement>('#second')!;
  const moved = first.querySelector('em')!;
  renderTranslation(first, '第一段。');
  renderTranslation(second, '第二段。');
  setDocumentDisplayMode('translation');
  second.append(moved);
  setDocumentDisplayMode('translation');
  expect(moved.hidden).toBe(true);
  setDocumentDisplayMode('bilingual');
  expect(moved.hidden).toBe(false);
  restoreDocument();
  expect(moved.parentElement).toBe(second);
  expect(moved.hasAttribute('data-justranslate-source-content')).toBe(false);
});

it('releases a managed child moved into a nested original element', () => {
  document.body.innerHTML = '<main><p><em>First text.</em><strong>Second text.</strong></p></main>';
  const source = document.querySelector('p')!;
  const moved = source.querySelector('em')!;
  renderTranslation(source, '译文。');
  setDocumentDisplayMode('translation');
  source.querySelector('strong')!.append(moved);
  restoreDocument();
  expect(moved.hidden).toBe(false);
  expect(moved.hasAttribute('data-justranslate-source-content')).toBe(false);
});

it('still prefers a hidden main with a genuinely visible reading descendant', () => {
  document.body.innerHTML =
    '<main style="visibility:hidden"><p id="visible" style="visibility:visible">Visible reading paragraph.</p></main><article><p>Other article paragraph.</p></article>';
  expect(collectTranslatableElements(document.body)).toEqual([document.querySelector('#visible')]);
});

it('does not abandon an authoritative main just because its reading units are offscreen', () => {
  document.body.innerHTML =
    '<main><p id="main">Main reading paragraph.</p></main><article><p id="outside">Other article paragraph.</p></article>';
  vi.spyOn(document.querySelector('#main')!, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(0, 4000, 200, 30),
  );
  vi.spyOn(document.querySelector('#outside')!, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(0, 10, 200, 30),
  );
  expect(collectTranslatableElements(document.body, { viewportOnly: true })).toEqual([]);
  expect(collectTranslatableElements(document.body)).toEqual([document.querySelector('#main')]);
});

it('preserves an author change on one overflow axis while restoring the other', () => {
  document.body.innerHTML =
    '<main><p style="overflow-x:hidden;overflow-y:clip;height:20px">Visible reading paragraph.</p></main>';
  const source = document.querySelector('p')!;
  renderTranslation(source, '译文。');
  source.style.setProperty('overflow-y', 'scroll', 'important');
  restoreDocument();
  expect(source.style.overflowX).toBe('hidden');
  expect(source.style.overflowY).toBe('scroll');
  expect(source.style.getPropertyPriority('overflow-y')).toBe('important');
});
