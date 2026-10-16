// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest';
import type { PageCommand, VideoSubtitleStatus } from '../shared/messages';

const subtitles = vi.hoisted(() => ({
  initialize: vi.fn(),
  getStatus: vi.fn(),
  setEnabled: vi.fn(),
  setDisplayMode: vi.fn(),
  suspend: vi.fn(),
  resume: vi.fn(),
}));
const controller = vi.hoisted(() => ({
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn(),
  setDisplayMode: vi.fn(),
  getStatus: vi.fn(),
}));
vi.mock('./youtube/youtube-subtitles', () => ({
  isYouTubeWatchHost: () => true,
  YouTubeSubtitles: class {
    initialize = subtitles.initialize;
    getStatus = subtitles.getStatus;
    setEnabled = subtitles.setEnabled;
    setDisplayMode = subtitles.setDisplayMode;
    suspend = subtitles.suspend;
    resume = subtitles.resume;
  },
}));
vi.mock('./controller', () => ({
  TranslationController: class {
    start = controller.start;
    stop = controller.stop;
    setDisplayMode = controller.setDisplayMode;
    getStatus = controller.getStatus;
  },
}));
vi.mock('./ui-language', () => ({ initializeContentLanguage: vi.fn() }));
vi.mock('./retry-interaction', () => ({ registerRetryInteractions: vi.fn() }));
vi.mock('./auto-start', () => ({ tryStartAutomaticTranslation: vi.fn() }));

let message: (command: PageCommand, sender: unknown, respond: (value: unknown) => void) => void;
let listeners: MockInstance<typeof window.addEventListener>;
const VIDEO_STATUS: VideoSubtitleStatus = { enabled: true, phase: 'loading' };

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  controller.getStatus.mockReturnValue({ phase: 'idle', mode: 'segmented' });
  subtitles.getStatus.mockReturnValue(VIDEO_STATUS);
  listeners = vi.spyOn(window, 'addEventListener');
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage: vi.fn(() => new Promise(() => {})),
      onMessage: {
        addListener: (listener: typeof message) => {
          message = listener;
        },
      },
    },
  });
  await import('./content-script');
});

afterEach(() => {
  for (const [type, listener, options] of listeners.mock.calls)
    window.removeEventListener(type, listener, options);
  listeners.mockRestore();
  vi.unstubAllGlobals();
});

it('starts video subtitles with the page and reports them in the page status', () => {
  expect(subtitles.initialize).toHaveBeenCalledOnce();
  const respond = vi.fn();
  message({ type: 'GET_PAGE_STATUS' }, {}, respond);
  expect(respond).toHaveBeenCalledWith({
    phase: 'idle',
    mode: 'segmented',
    videoSubtitles: VIDEO_STATUS,
  });
});

it('turns subtitles on for this tab without touching page translation', () => {
  const respond = vi.fn();
  message({ type: 'SET_VIDEO_SUBTITLES', enabled: true }, {}, respond);
  expect(subtitles.setEnabled).toHaveBeenCalledWith(true);
  expect(controller.start).not.toHaveBeenCalled();
  expect(respond).toHaveBeenCalledWith(expect.objectContaining({ videoSubtitles: VIDEO_STATUS }));
});

it('applies the display mode to page text and subtitles alike', () => {
  message({ type: 'SET_DISPLAY_MODE', displayMode: 'translation' }, {}, vi.fn());
  expect(controller.setDisplayMode).toHaveBeenCalledWith('translation');
  expect(subtitles.setDisplayMode).toHaveBeenCalledWith('translation');
});

it('releases subtitles on pagehide and restores them from the back/forward cache', () => {
  window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
  expect(subtitles.suspend).toHaveBeenCalledOnce();
  window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }));
  expect(subtitles.resume).not.toHaveBeenCalled();
  window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  expect(subtitles.resume).toHaveBeenCalledOnce();
});
