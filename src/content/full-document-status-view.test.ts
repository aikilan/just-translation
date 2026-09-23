// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { FullDocumentStatusView, isFullDocumentStatusMutation } from './full-document-status-view';
import { collectOriginalReadingUnits } from './dom-translator';
import type { PageTranslationStatus } from '../shared/messages';

const status: PageTranslationStatus = {
  mode: 'full-document',
  phase: 'translating',
  stage: 'collecting',
  translated: 0,
  failed: 0,
  total: 0,
  displayMode: 'bilingual',
};
let view: FullDocumentStatusView;
afterEach(() => {
  view?.destroy();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});
it('is independently accessible even with no body text, preserves focus and exposes stop', () => {
  document.body.innerHTML = '<button>Page button</button>';
  const original = document.querySelector('button')!;
  original.focus();
  const stop = vi.fn();
  view = new FullDocumentStatusView({ stop, retry: vi.fn() });
  view.update(status);
  const host = document.querySelector('[data-justranslate-full-status]')!;
  expect(document.activeElement).toBe(original);
  expect(host.shadowRoot?.querySelector('[role="status"]')?.textContent).toBe('收集全文');
  host.shadowRoot!.querySelector('button')!.click();
  expect(stop).toHaveBeenCalledOnce();
  view.update({ ...status, phase: 'stopped' });
  expect(host.isConnected).toBe(false);
});
it('excludes itself from collection and distinguishes mixed host mutations', () => {
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue({ length: 1 } as DOMRectList);
  document.body.innerHTML = '<main><p>Original readable paragraph.</p></main>';
  const before = collectOriginalReadingUnits(document.body);
  view = new FullDocumentStatusView({ stop: vi.fn(), retry: vi.fn() });
  const observer = new MutationObserver(() => undefined);
  observer.observe(document.documentElement, { childList: true });
  view.update(status);
  expect(observer.takeRecords().every(isFullDocumentStatusMutation)).toBe(true);
  expect(collectOriginalReadingUnits(document.body)).toEqual(before);
  document.documentElement.append(document.createElement('div'));
  expect(observer.takeRecords().some(isFullDocumentStatusMutation)).toBe(false);
  document.documentElement.lastElementChild!.remove();
  observer.disconnect();
});
it('closes a failed view without retrying and removes pagehide ownership', () => {
  const stop = vi.fn();
  const retry = vi.fn();
  view = new FullDocumentStatusView({ stop, retry });
  view.update({ ...status, phase: 'error', error: { text: 'Failure' } });
  const host = document.querySelector('[data-justranslate-full-status]')!;
  host.shadowRoot!.querySelectorAll('button')[1].click();
  window.dispatchEvent(new Event('pagehide'));
  expect(host.isConnected).toBe(false);
  expect(stop).not.toHaveBeenCalled();
  expect(retry).not.toHaveBeenCalled();
});
