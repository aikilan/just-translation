// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest';
import type { PageCommand, PublicTranslatorSettings, Result } from '../shared/messages';

const observer = vi.hoisted(() => ({ notify: undefined as (() => void) | undefined }));
const actions = vi.hoisted(() => ({
  start: vi.fn().mockResolvedValue(undefined),
  startFullDocument: vi.fn().mockResolvedValue(undefined),
  restart: vi.fn().mockResolvedValue(undefined),
  retryAllFailed: vi.fn().mockResolvedValue(undefined),
  restore: vi.fn(),
  stop: vi.fn(),
  toggle: vi.fn(),
  setDisplayMode: vi.fn(),
  getStatus: vi.fn(),
}));
vi.mock('./controller', () => ({
  TranslationController: class {
    constructor(notify?: () => void) {
      observer.notify = notify;
    }
    start = actions.start;
    startFullDocument = actions.startFullDocument;
    restart = actions.restart;
    retryAllFailed = actions.retryAllFailed;
    restore = actions.restore;
    stop = actions.stop;
    toggle = actions.toggle;
    setDisplayMode = actions.setDisplayMode;
    getStatus = actions.getStatus;
  },
}));
// Language bootstrap has separate race/broadcast tests; these tests isolate page commands.
vi.mock('./ui-language', () => ({ initializeContentLanguage: vi.fn() }));
vi.mock('./retry-interaction', () => ({ registerRetryInteractions: vi.fn() }));

let release: (value: Result<PublicTranslatorSettings>) => void;
let message: Parameters<typeof chrome.runtime.onMessage.addListener>[0];
let listeners: MockInstance<typeof window.addEventListener>;
const settings: PublicTranslatorSettings = {
  uiLanguage: 'system',
  configured: true,
  activeProfileId: 'p',
  profiles: [{ id: 'p', name: 'AI', configured: true }],
  targetLanguage: 'Chinese',
  displayMode: 'bilingual',
  translationConcurrency: 6,
  translationRetryCount: 1,
  translateDynamicContent: true,
  autoTranslateSites: [location.hostname],
  excludedSites: [],
};
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  actions.getStatus.mockReturnValue({ phase: 'idle', mode: 'segmented' });
  listeners = vi.spyOn(window, 'addEventListener');
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage: vi.fn(
        () =>
          new Promise<Result<PublicTranslatorSettings>>((resolve) => {
            release = resolve;
          }),
      ),
      onMessage: {
        addListener: (listener: typeof message) => {
          message = listener;
        },
      },
    },
  });
  await import('./content-script');
});
afterEach(async () => {
  release({ ok: false, error: { text: 'test finished' } });
  await Promise.resolve();
  for (const [type, listener, options] of listeners.mock.calls)
    window.removeEventListener(type, listener, options);
  listeners.mockRestore();
  vi.unstubAllGlobals();
});

it.each([
  'START_TRANSLATION',
  'START_FULL_DOCUMENT_TRANSLATION',
  'RESTART_TRANSLATION',
  'RETRY_FAILED_TRANSLATIONS',
  'STOP_TRANSLATION',
  'RESTORE_PAGE',
  'TOGGLE_TRANSLATION',
] as const)(
  'retires startup auto-translation after the user command %s, even if the page is idle',
  async (type) => {
    message({ type } satisfies PageCommand, {}, vi.fn());
    const manualStarts = actions.start.mock.calls.length;
    release({ ok: true, data: settings });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(actions.start).toHaveBeenCalledTimes(manualStarts);
  },
);

it('still auto-starts when only status and display preferences changed', async () => {
  message({ type: 'GET_PAGE_STATUS' }, {}, vi.fn());
  message({ type: 'SET_DISPLAY_MODE', displayMode: 'translation' }, {}, vi.fn());
  release({ ok: true, data: settings });
  await vi.waitFor(() => expect(actions.start).toHaveBeenCalledOnce());
});

it('does not answer selection commands or interrupt automatic page translation', async () => {
  const respond = vi.fn();
  message({ type: 'START_SELECTION_TRANSLATION', text: 'selected' }, {}, respond);
  expect(respond).not.toHaveBeenCalled();
  release({ ok: true, data: settings });
  await vi.waitFor(() => expect(actions.start).toHaveBeenCalledOnce());
});

it('stops startup on pagehide and resumes only an already running segmented BFCache page', async () => {
  actions.getStatus.mockReturnValue({ phase: 'translating', mode: 'segmented' });
  window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
  expect(actions.stop).toHaveBeenCalledTimes(1);
  release({ ok: true, data: settings });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(actions.start).not.toHaveBeenCalled();
  window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  expect(actions.start).toHaveBeenCalledTimes(1);
  for (const status of [
    { phase: 'stopped', mode: 'segmented' },
    { phase: 'translating', mode: 'full-document' },
  ]) {
    actions.getStatus.mockReturnValue(status);
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  }
  expect(actions.start).toHaveBeenCalledTimes(1);
});

it('dispatches bulk retry and immediately returns page status', () => {
  const respond = vi.fn();
  message({ type: 'RETRY_FAILED_TRANSLATIONS' }, {}, respond);
  expect(actions.retryAllFailed).toHaveBeenCalledOnce();
  expect(actions.restart).not.toHaveBeenCalled();
  expect(respond).toHaveBeenCalledWith(actions.getStatus());
});

it('notifies the background when retry availability changes', async () => {
  const sendMessage = vi
    .fn<() => Promise<Result<void>>>()
    .mockResolvedValue({ ok: true, data: undefined });
  vi.stubGlobal('chrome', { ...chrome, runtime: { ...chrome.runtime, sendMessage } });
  observer.notify?.();
  await Promise.resolve();
  expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'PAGE_RETRY_STATE_CHANGED' });
});
