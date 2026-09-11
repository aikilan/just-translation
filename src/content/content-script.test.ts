// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';

const { start, stop, getStatus, autoStart } = vi.hoisted(() => ({
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn(),
  getStatus: vi.fn(),
  autoStart: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./controller', () => ({
  TranslationController: class {
    start = start;
    stop = stop;
    getStatus = getStatus;
  },
}));
vi.mock('./retry-interaction', () => ({ registerRetryInteractions: vi.fn() }));
vi.mock('./auto-start', () => ({ tryStartAutomaticTranslation: autoStart }));
afterEach(() => vi.unstubAllGlobals());

it('stops old page work on pagehide and resumes a previously running BFCache document only', async () => {
  vi.stubGlobal('chrome', { runtime: { onMessage: { addListener: vi.fn() } } });
  await import('./content-script');
  getStatus.mockReturnValue({ phase: 'translating' });
  window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
  expect(stop).toHaveBeenCalledTimes(1);
  window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  expect(start).toHaveBeenCalledTimes(1);
  getStatus.mockReturnValue({ phase: 'stopped' });
  window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
  window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  expect(start).toHaveBeenCalledTimes(1);
  expect(autoStart).toHaveBeenCalledTimes(1);
});
