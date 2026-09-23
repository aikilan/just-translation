// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SelectionTranslationController, captureSelectionAnchor } from './selection-translation';
import { SelectionTranslationView, positionSelectionPopup } from './selection-translation-view';
import type { Result, RuntimeRequest } from '../shared/messages';
import type { ActiveTranslator } from '../shared/translation-engines';

let controller: SelectionTranslationController;
let send: ReturnType<typeof vi.fn<(request: RuntimeRequest) => Promise<Result<unknown>>>>;
const anchor = { getRect: () => ({ left: 20, right: 100, top: 20, bottom: 40 }) };
const GOOGLE_TRANSLATOR: ActiveTranslator = { kind: 'builtin', engine: 'google-free' };
const shadow = () => document.querySelector('[data-justranslate-selection]')!.shadowRoot!;
beforeEach(() => {
  document.body.innerHTML = '<p>Original text</p>';
  Object.defineProperty(HTMLElement.prototype, 'showPopover', {
    configurable: true,
    value(this: HTMLElement) {
      this.setAttribute('data-open', '');
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'hidePopover', {
    configurable: true,
    value(this: HTMLElement) {
      this.removeAttribute('data-open');
    },
  });
  send = vi.fn(() =>
    Promise.resolve({
      ok: true,
      data: { text: '译文', targetLanguage: 'Chinese', translatorName: 'Google' },
    }),
  );
  controller = new SelectionTranslationController(send);
});
afterEach(() => {
  controller.close();
  vi.restoreAllMocks();
});

it('opens immediately, renders plain text, and never replaces source content', async () => {
  let resolve!: (value: Result<unknown>) => void;
  send.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  controller.start('Original text', anchor, GOOGLE_TRANSLATOR);
  expect(shadow().textContent).toContain('翻译中');
  resolve({
    ok: true,
    data: {
      text: '<img src=x onerror=alert(1)>',
      targetLanguage: 'Chinese',
      translatorName: 'Google',
    },
  });
  await vi.waitFor(() => expect(shadow().textContent).toContain('<img src=x'));
  expect(shadow().querySelector('.language')?.textContent).toContain('Google');
  expect(shadow().querySelector('img')).toBeNull();
  expect(document.querySelector('p')!.textContent).toBe('Original text');
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'TRANSLATE_SELECTION', translator: GOOGLE_TRANSLATOR }),
  );
  expect(shadow().querySelector('details')!.open).toBe(false);
  expect(shadow().querySelector('.content')!.contains(shadow().querySelector('.result'))).toBe(
    true,
  );
  expect(
    shadow().querySelector('.content')!.contains(shadow().querySelector('[data-action="copy"]')),
  ).toBe(false);
});
it('rejects a result that does not identify the receiving translation engine', async () => {
  send.mockResolvedValueOnce({
    ok: true,
    data: { text: '译文', targetLanguage: 'Chinese' },
  });
  controller.start('text', anchor, GOOGLE_TRANSLATOR);
  await vi.waitFor(() => expect(shadow().textContent).toContain('后台未返回有效译文'));
});
it('cancels replaced requests and ignores their late results', async () => {
  const releases: ((value: Result<unknown>) => void)[] = [];
  send.mockImplementation((request: RuntimeRequest) =>
    request.type === 'TRANSLATE_SELECTION'
      ? new Promise((r) => releases.push(r))
      : Promise.resolve({ ok: true, data: undefined }),
  );
  controller.start('first', anchor, GOOGLE_TRANSLATOR);
  controller.start('second', anchor, GOOGLE_TRANSLATOR);
  releases[1]({
    ok: true,
    data: { text: 'second result', targetLanguage: 'Chinese', translatorName: 'Google' },
  });
  releases[0]({
    ok: true,
    data: { text: 'stale result', targetLanguage: 'Chinese', translatorName: 'Google' },
  });
  await vi.waitFor(() => expect(shadow().textContent).toContain('second result'));
  expect(shadow().textContent).not.toContain('stale result');
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'CANCEL_SELECTION_TRANSLATION' }),
  );
});
it('shows failures and retries with a fresh request identity', async () => {
  send.mockResolvedValueOnce({ ok: false, error: { text: '请先在设置页完成 API 配置' } });
  controller.start('text', anchor, GOOGLE_TRANSLATOR);
  await vi.waitFor(() => expect(shadow().textContent).toContain('请先在设置页'));
  (shadow().querySelector('[data-action="retry"]') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(shadow().textContent).toContain('译文'));
  const requests = send.mock.calls.map(([r]) => r).filter((r) => r.type === 'TRANSLATE_SELECTION');
  expect(requests).toHaveLength(2);
  expect(requests[0].requestId).not.toBe(requests[1].requestId);
  expect(requests.every((request) => request.translator === GOOGLE_TRANSLATOR)).toBe(true);
});
it.each(['escape', 'outside', 'pagehide'])('closes and cancels on %s', (action) => {
  controller.start('text', anchor, GOOGLE_TRANSLATOR);
  if (action === 'escape')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  if (action === 'outside')
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  if (action === 'pagehide') window.dispatchEvent(new Event('pagehide'));
  expect(document.querySelector('[data-justranslate-selection]')).toBeNull();
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'CANCEL_SELECTION_TRANSLATION' }),
  );
});
it('closes when anchor nodes are removed', async () => {
  const node = document.querySelector('p')!;
  controller.start(
    'text',
    { getRect: () => (node.isConnected ? anchor.getRect() : null) },
    GOOGLE_TRANSLATOR,
  );
  node.remove();
  await vi.waitFor(() =>
    expect(document.querySelector('[data-justranslate-selection]')).toBeNull(),
  );
});
it('anchors editable selection to the pointer and follows element movement', () => {
  const input = document.createElement('textarea');
  document.body.append(input);
  let top = 100;
  vi.spyOn(input, 'getBoundingClientRect').mockImplementation(() => ({ left: 20, top }) as DOMRect);
  const captured = captureSelectionAnchor(
    new MouseEvent('contextmenu', { clientX: 40, clientY: 120 }),
    input,
  );
  expect(captured.getRect()).toMatchObject({ left: 40, top: 120 });
  top = 150;
  expect(captured.getRect()).toMatchObject({ top: 170 });
  input.remove();
  expect(captured.getRect()).toBeNull();
});
it('keeps popups inside viewport and flips above a bottom-edge selection', () => {
  expect(
    positionSelectionPopup({ left: 790, right: 800, top: 570, bottom: 590 }, 380, 200, 800, 600),
  ).toEqual({ left: 408, top: 362 });
});
it('reports clipboard failure without losing the selectable result', async () => {
  const view = new SelectionTranslationView({ close: vi.fn(), retry: vi.fn() });
  view.show('source', anchor);
  view.success({ text: 'copy me', targetLanguage: 'Chinese', translatorName: 'Google' });
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
  });
  (shadow().querySelector('[data-action="copy"]') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(shadow().textContent).toContain('手动选择复制'));
  expect(shadow().textContent).toContain('copy me');
  view.destroy();
});
