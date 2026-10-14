// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest';

const actions = vi.hoisted(() => ({
  open: vi.fn(),
  close: vi.fn(),
  create: vi.fn(),
  language: vi.fn(),
  progress: vi.fn(),
}));
vi.mock('./quick-translation-dialog', () => ({
  QuickTranslationDialog: class {
    constructor() {
      actions.create();
    }
    open = actions.open;
    close = actions.close;
    receiveProgress = actions.progress;
  },
}));
vi.mock('./ui-language', () => ({ initializeContentLanguage: actions.language }));
let listeners: MockInstance<typeof window.addEventListener>;
let onMessage: (event: unknown, sender: chrome.runtime.MessageSender) => void;
beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  listeners = vi.spyOn(window, 'addEventListener');
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'extension',
      onMessage: {
        addListener: (listener: typeof onMessage) => {
          onMessage = listener;
        },
      },
    },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const [type, listener, options] of listeners.mock.calls)
    window.removeEventListener(type, listener, options);
  vi.restoreAllMocks();
});

it('owns language and pagehide cleanup without a page controller, and reuses the dialog on reopen', async () => {
  const { openQuickTranslation } = await import('./quick-translation-entry');
  expect(openQuickTranslation()).toEqual({ ok: true, data: undefined });
  expect(actions.language).toHaveBeenCalledOnce();
  window.dispatchEvent(new Event('pagehide'));
  expect(actions.close).toHaveBeenCalledOnce();
  expect(openQuickTranslation()).toEqual({ ok: true, data: undefined });
  expect(actions.create).toHaveBeenCalledOnce();
  expect(actions.open).toHaveBeenCalledTimes(2);
  expect(listeners.mock.calls.filter(([type]) => type === 'pagehide')).toHaveLength(1);
});

it('returns opening failures to the popup and allows another attempt', async () => {
  actions.open.mockImplementationOnce(() => {
    throw new Error('Inactive document');
  });
  const { openQuickTranslation } = await import('./quick-translation-entry');
  expect(openQuickTranslation()).toEqual({ ok: false, error: { text: 'Inactive document' } });
  expect(openQuickTranslation()).toEqual({ ok: true, data: undefined });
  expect(actions.create).toHaveBeenCalledOnce();
});

it('forwards progress only from the extension background to the dialog', async () => {
  const { openQuickTranslation } = await import('./quick-translation-entry');
  openQuickTranslation();
  const event = { type: 'QUICK_TRANSLATION_PROGRESS', requestId: '1', translations: { s0: '译' } };
  onMessage(event, { id: 'extension' });
  expect(actions.progress).toHaveBeenCalledWith(event);
  // Another content script shares the extension ID but always has a sender tab.
  onMessage(event, { id: 'extension', tab: { id: 3 } as chrome.tabs.Tab });
  onMessage({ ...event, translations: 'bad' }, { id: 'extension' });
  onMessage({ type: 'GET_PAGE_STATUS' }, { id: 'extension' });
  expect(actions.progress).toHaveBeenCalledOnce();
});
