// @vitest-environment jsdom
import { expect, it } from 'vitest';
import './quick-translation-loader.iife';

// Native import exercises the actual lazy loading boundary, without a module mock.
const moduleUrl = `data:text/javascript,${encodeURIComponent(
  'export function openQuickTranslation() { return { ok: true, data: undefined }; }',
)}`;

it('imports and opens the independent entry', async () => {
  expect(await window.__justTranslateOpenQuickTranslation(moduleUrl)).toEqual({
    ok: true,
    data: undefined,
  });
});

it('does not open after pagehide while the module is loading', async () => {
  const opening = window.__justTranslateOpenQuickTranslation(moduleUrl);
  window.dispatchEvent(new Event('pagehide'));
  expect(await opening).toEqual({ ok: false, error: { key: '当前网页已变化，请重新打开翻译' } });
});

it('reports import failures and allows a new attempt', async () => {
  const badModule = `data:text/javascript,${encodeURIComponent('throw new Error("Load failed");')}`;
  expect(await window.__justTranslateOpenQuickTranslation(badModule)).toEqual({
    ok: false,
    error: { text: 'Load failed' },
  });
  expect(await window.__justTranslateOpenQuickTranslation(moduleUrl)).toEqual({
    ok: true,
    data: undefined,
  });
});
