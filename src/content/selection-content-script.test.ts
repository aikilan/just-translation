// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PageCommand } from '../shared/messages';
import type { ActiveTranslator } from '../shared/translation-engines';

const actions = vi.hoisted(() => ({ start: vi.fn(), anchor: { getRect: vi.fn() } }));
const GOOGLE_TRANSLATOR: ActiveTranslator = { kind: 'builtin', engine: 'google-free' };
vi.mock('./ui-language', () => ({ initializeContentLanguage: vi.fn() }));
vi.mock('./selection-translation', () => ({
  SelectionTranslationController: class {
    start = actions.start;
  },
  captureSelectionAnchor: () => actions.anchor,
}));

let listener: Parameters<typeof chrome.runtime.onMessage.addListener>[0];
let contextMenu: EventListener;
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  const add = vi.spyOn(document, 'addEventListener');
  vi.stubGlobal('chrome', {
    runtime: {
      onMessage: {
        addListener: (value: typeof listener) => {
          listener = value;
        },
      },
    },
  });
  await import('./selection-content-script');
  contextMenu = add.mock.calls.find(([type]) => type === 'contextmenu')![1] as EventListener;
});
afterEach(() => {
  document.removeEventListener('contextmenu', contextMenu, true);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('only answers selection commands, using the previously captured anchor', () => {
  document.body.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
  const respond = vi.fn();
  listener({ type: 'GET_PAGE_STATUS' } satisfies PageCommand, {}, respond);
  expect(respond).not.toHaveBeenCalled();
  listener(
    {
      type: 'START_SELECTION_TRANSLATION',
      text: 'exact selected text',
      translator: GOOGLE_TRANSLATOR,
    } satisfies PageCommand,
    {},
    respond,
  );
  expect(actions.start).toHaveBeenCalledWith(
    'exact selected text',
    actions.anchor,
    GOOGLE_TRANSLATOR,
  );
  expect(respond).toHaveBeenCalledWith({ ok: true });
});

it('does not translate in a newly navigated document with no selection anchor', () => {
  const respond = vi.fn();
  listener(
    {
      type: 'START_SELECTION_TRANSLATION',
      text: 'old document selection',
      translator: GOOGLE_TRANSLATOR,
    } satisfies PageCommand,
    {},
    respond,
  );
  expect(actions.start).not.toHaveBeenCalled();
  expect(respond).toHaveBeenCalledWith({ ok: false });
});
