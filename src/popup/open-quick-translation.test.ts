// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openQuickTranslationInTab } from './open-quick-translation';

vi.mock('../content/quick-translation-loader.iife.ts?script&iife', () => ({
  default: 'quick-loader.js',
}));
vi.mock('../content/quick-translation-entry.ts?script&module', () => ({
  default: 'quick-entry.js',
}));
const open = vi.fn().mockResolvedValue({ ok: true, data: undefined });
const executeScript =
  vi.fn<
    (
      injection: chrome.scripting.ScriptInjection<[string], unknown>,
    ) => Promise<chrome.scripting.InjectionResult<unknown>[]>
  >();
beforeEach(() => {
  vi.clearAllMocks();
  window.__justTranslateOpenQuickTranslation = open;
  vi.stubGlobal('chrome', {
    runtime: { getURL: (path: string) => `chrome-extension://test/${path}` },
    scripting: { executeScript },
  });
  executeScript.mockResolvedValue([{ frameId: 0, documentId: 'page', result: { ok: true } }]);
});
afterEach(() => vi.unstubAllGlobals());

it('injects only the independent editor in the top-frame isolated world', async () => {
  await openQuickTranslationInTab(7);
  expect(executeScript).toHaveBeenNthCalledWith(1, {
    target: { tabId: 7, frameIds: [0] },
    world: 'ISOLATED',
    files: ['quick-loader.js'],
  });
  expect(executeScript).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({
      target: { tabId: 7, documentIds: ['page'] },
      world: 'ISOLATED',
      args: ['chrome-extension://test/quick-entry.js'],
    }),
  );
  const inject = executeScript.mock.calls[1][0].func!;
  expect(await inject('entry-url')).toEqual({ ok: true, data: undefined });
  expect(open).toHaveBeenCalledExactlyOnceWith('entry-url');
});

it('does not open on another document after the loader was injected', async () => {
  executeScript.mockResolvedValueOnce([{ frameId: 0, documentId: 'page', result: undefined }]);
  executeScript.mockResolvedValueOnce([
    { frameId: 0, documentId: 'new-page', result: { ok: true } },
  ]);
  await expect(openQuickTranslationInTab(7)).rejects.toThrow();
});

it.each([{ results: [] }, { results: [{ frameId: 3, documentId: 'frame' }] }])(
  'stops when the loader has no main document: %j',
  async ({ results }) => {
    executeScript.mockResolvedValueOnce(results);
    await expect(openQuickTranslationInTab(7)).rejects.toThrow();
    expect(executeScript).toHaveBeenCalledOnce();
  },
);

it.each([
  { results: [] },
  { results: [{ frameId: 0, documentId: 'page', result: undefined }] },
  { results: [{ frameId: 3, documentId: 'frame', result: { ok: true } }] },
])('requires an explicit main-frame acknowledgement: %j', async ({ results }) => {
  executeScript.mockResolvedValueOnce([{ frameId: 0, documentId: 'page', result: undefined }]);
  executeScript.mockResolvedValueOnce(results);
  await expect(openQuickTranslationInTab(7)).rejects.toThrow();
});
