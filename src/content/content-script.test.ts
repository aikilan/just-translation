// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest';
import type { PageCommand, PublicTranslatorSettings, Result } from '../shared/messages';

const actions = vi.hoisted(() => ({
  start: vi.fn().mockResolvedValue(undefined),
  startFullDocument: vi.fn().mockResolvedValue(undefined),
  restart: vi.fn().mockResolvedValue(undefined),
  restore: vi.fn(),
  stop: vi.fn(),
  toggle: vi.fn(),
  setDisplayMode: vi.fn(),
  getStatus: vi.fn(),
}));
vi.mock('./controller', () => ({
  TranslationController: class {
    start = actions.start;
    startFullDocument = actions.startFullDocument;
    restart = actions.restart;
    restore = actions.restore;
    stop = actions.stop;
    toggle = actions.toggle;
    setDisplayMode = actions.setDisplayMode;
    getStatus = actions.getStatus;
  },
}));
vi.mock('./retry-interaction', () => ({ registerRetryInteractions: vi.fn() }));

let release: (value: Result<PublicTranslatorSettings>) => void;
let message: Parameters<typeof chrome.runtime.onMessage.addListener>[0];
let listeners: MockInstance<typeof window.addEventListener>;
const settings: PublicTranslatorSettings = {
  configured: true,
  activeProfileId: 'p',
  profiles: [{ id: 'p', name: 'AI', configured: true }],
  targetLanguage: 'Chinese',
  displayMode: 'bilingual',
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
  release({ ok: false, error: 'test finished' });
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
