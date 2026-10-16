// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PublicTranslatorSettings, Result, RuntimeRequest } from '../../shared/messages';
import { DEFAULT_SETTINGS } from '../../shared/settings';
import { CAPTION_EVENT, CAPTION_REPLAY_EVENT } from './caption-protocol';
import { CAPTIONS_TURNED_ON_KEY, NATIVE_CAPTIONS_HIDDEN_ATTRIBUTE } from './native-captions';
import { YouTubeSubtitles } from './youtube-subtitles';

const TRANSLATOR = { kind: 'builtin', engine: 'google-free' } as const;

function captionBody(...lines: [startMs: number, text: string][]) {
  return JSON.stringify({
    events: lines.map(([tStartMs, utf8]) => ({
      tStartMs,
      dDurationMs: 3_000,
      segs: [{ utf8 }],
    })),
  });
}

function captionUrl(videoId: string, lang = 'en') {
  return `https://www.youtube.com/api/timedtext?v=${videoId}&lang=${lang}&fmt=json3&pot=token`;
}

/** What the page-world hook does when the player loads a track. */
function deliverCaptions(videoId: string, body: string, lang = 'en') {
  document.dispatchEvent(
    new CustomEvent(CAPTION_EVENT, {
      detail: JSON.stringify({ url: captionUrl(videoId, lang), body }),
    }),
  );
}

const settle = async (rounds = 20) => {
  for (let index = 0; index < rounds; index++) await new Promise((resolve) => setTimeout(resolve));
};

describe('YouTube bilingual subtitles', () => {
  let settings: PublicTranslatorSettings;
  let requests: RuntimeRequest[];
  let shadowRoots: ShadowRoot[];
  let subtitles: YouTubeSubtitles | undefined;
  let captionsByVideo: Record<string, string>;
  let video: HTMLVideoElement;
  let testLifetime: AbortController;
  let settingsFailures: number;

  const player = () => document.querySelector<HTMLElement>('#movie_player')!;
  const ccButton = () => document.querySelector<HTMLButtonElement>('.ytp-subtitles-button')!;
  const ourButton = () =>
    document.querySelector<HTMLButtonElement>('[data-justranslate-subtitle-button]');
  const layer = () => {
    const host = document.querySelector('[data-justranslate-subtitle-layer]');
    return host ? shadowRoots.find((root) => root.host === host) : undefined;
  };
  const shownLines = () => {
    const root = layer();
    if (!root) return undefined;
    const text = (kind: string) => {
      const row = root.querySelector<HTMLElement>(`.row.${kind}`)!;
      return row.hidden ? '' : row.textContent;
    };
    return { original: text('original'), translation: text('translation') };
  };
  const toast = () => {
    const element = layer()?.querySelector<HTMLElement>('.toast');
    return element && !element.hidden ? element.textContent : undefined;
  };
  const playAt = (seconds: number) => {
    video.currentTime = seconds;
    video.dispatchEvent(new Event('timeupdate'));
  };
  const openVideo = (videoId: string) => {
    history.replaceState(null, '', `/watch?v=${videoId}`);
  };

  beforeEach(() => {
    settings = {
      ...DEFAULT_SETTINGS,
      profiles: [],
      ready: true,
      supportsFullDocument: false,
      activeTranslator: TRANSLATOR,
    };
    requests = [];
    shadowRoots = [];
    testLifetime = new AbortController();
    settingsFailures = 0;
    captionsByVideo = {};
    localStorage.clear();
    document.documentElement.removeAttribute(NATIVE_CAPTIONS_HIDDEN_ATTRIBUTE);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Called with the host below.
    const attachShadow = HTMLElement.prototype.attachShadow;
    vi.spyOn(HTMLElement.prototype, 'attachShadow').mockImplementation(function (
      this: HTMLElement,
      init: ShadowRootInit,
    ) {
      const root = attachShadow.call(this, init);
      shadowRoots.push(root);
      return root;
    });
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => setTimeout(callback, 16));
    vi.stubGlobal('cancelAnimationFrame', (handle: number) => clearTimeout(handle));
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: vi.fn(async (request: RuntimeRequest): Promise<Result<unknown>> => {
          requests.push(request);
          await Promise.resolve();
          switch (request.type) {
            case 'GET_PUBLIC_SETTINGS':
              if (settingsFailures-- > 0) throw new Error('worker restarting');
              return { ok: true, data: structuredClone(settings) };
            case 'BEGIN_TRANSLATION_SESSION':
              return {
                ok: true,
                data: {
                  configurationId: 'config',
                  context: { translator: TRANSLATOR, targetLanguage: 'Simplified Chinese' },
                  batchProfiles: {
                    visible: { maxCharacters: 1_000, maxItems: 1 },
                    readAhead: { maxCharacters: 1_000, maxItems: 1 },
                    background: { maxCharacters: 1_000, maxItems: 1 },
                  },
                  maxConcurrency: 2,
                },
              };
            case 'RESOLVE_TRANSLATION_CANDIDATES':
              return {
                ok: true,
                data: {
                  cachedTranslations: {},
                  skippedIds: [],
                  missIds: request.candidates.map((candidate) => candidate.id),
                },
              };
            case 'TRANSLATE_BATCH':
              return {
                ok: true,
                data: {
                  translations: Object.fromEntries(
                    request.segments.map((segment) => [segment.requestId, `译文 ${segment.text}`]),
                  ),
                  failures: {},
                },
              };
            default:
              return { ok: true, data: undefined };
          }
        }),
      },
    });
    document.body.innerHTML = `
      <div id="movie_player" class="html5-video-player">
        <video></video>
        <div class="ytp-caption-window-container"></div>
        <div class="ytp-chrome-bottom">
          <div class="ytp-right-controls">
            <button class="ytp-subtitles-button ytp-button" aria-pressed="false"></button>
          </div>
        </div>
      </div>`;
    document.head.innerHTML = '';
    video = document.querySelector('video')!;
    Object.defineProperty(video, 'currentTime', { value: 0, writable: true });
    // The player loads the track of the open video whenever its CC turns on.
    ccButton().addEventListener('click', () => {
      const pressed = ccButton().getAttribute('aria-pressed') === 'true';
      ccButton().setAttribute('aria-pressed', String(!pressed));
      const videoId = new URLSearchParams(location.search).get('v')!;
      if (!pressed && captionsByVideo[videoId]) deliverCaptions(videoId, captionsByVideo[videoId]);
    });
    openVideo('video00001');
    captionsByVideo.video00001 = captionBody([0, 'Hello world.'], [5_000, 'Good night.']);
  });

  afterEach(() => {
    subtitles?.dispose();
    subtitles = undefined;
    testLifetime.abort();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function start(options: Partial<PublicTranslatorSettings> = {}) {
    Object.assign(settings, options);
    subtitles = new YouTubeSubtitles();
    subtitles.initialize();
    await settle();
    return subtitles;
  }

  it('turns on from the saved preference and shows the original above its translation', async () => {
    const subtitles = await start({ youtubeSubtitles: true });
    expect(ccButton().getAttribute('aria-pressed')).toBe('true');
    expect(subtitles.getStatus()).toEqual({ enabled: true, phase: 'on' });
    expect(player().hasAttribute('data-justranslate-subtitles')).toBe(true);
    expect(document.getElementById('justtranslate-youtube-subtitles-style')?.textContent).toContain(
      '#movie_player[data-justranslate-subtitles] .ytp-caption-window-container',
    );
    playAt(1);
    await settle();
    expect(shownLines()).toEqual({ original: 'Hello world.', translation: '译文 Hello world.' });
    playAt(6);
    expect(shownLines()).toEqual({ original: 'Good night.', translation: '译文 Good night.' });
    expect(requests).toContainEqual(
      expect.objectContaining({ type: 'BEGIN_TRANSLATION_SESSION', translator: TRANSLATOR }),
    );
    expect(ourButton()?.getAttribute('aria-pressed')).toBe('true');
    expect(ourButton()?.nextElementSibling).toBe(ccButton());
  });

  it('shows only the translation in translation-only mode', async () => {
    const subtitles = await start({ youtubeSubtitles: true, displayMode: 'translation' });
    playAt(1);
    await settle();
    expect(shownLines()).toEqual({ original: '', translation: '译文 Hello world.' });
    subtitles.setDisplayMode('bilingual');
    expect(shownLines()).toEqual({ original: 'Hello world.', translation: '译文 Hello world.' });
  });

  it('toggles this tab from the player button and gives YouTube its captions back', async () => {
    await start();
    expect(ccButton().getAttribute('aria-pressed')).toBe('false');
    expect(ourButton()?.getAttribute('aria-pressed')).toBe('false');
    ourButton()!.click();
    await settle();
    expect(ccButton().getAttribute('aria-pressed')).toBe('true');
    expect(ourButton()?.getAttribute('aria-pressed')).toBe('true');
    expect(layer()).toBeDefined();
    expect(localStorage.getItem(CAPTIONS_TURNED_ON_KEY)).toBe('1');
    ourButton()!.click();
    await settle();
    expect(ccButton().getAttribute('aria-pressed')).toBe('false');
    expect(localStorage.getItem(CAPTIONS_TURNED_ON_KEY)).toBeNull();
    expect(document.documentElement.hasAttribute(NATIVE_CAPTIONS_HIDDEN_ATTRIBUTE)).toBe(false);
    expect(layer()).toBeUndefined();
    expect(player().hasAttribute('data-justranslate-subtitles')).toBe(false);
    expect(requests.map((request) => request.type)).toContain('END_TRANSLATION_SESSION');
    // The button never changes saved preferences.
    expect(requests.map((request) => request.type)).not.toContain('UPDATE_READING_PREFERENCES');
  });

  it('leaves captions the viewer turned on when subtitles are switched off', async () => {
    ccButton().setAttribute('aria-pressed', 'true');
    document.addEventListener(
      CAPTION_REPLAY_EVENT,
      () => deliverCaptions('video00001', captionsByVideo.video00001),
      { signal: testLifetime.signal },
    );
    const subtitles = await start({ youtubeSubtitles: true });
    // The track arrived before this script and came back through the replay request.
    expect(subtitles.getStatus().phase).toBe('on');
    subtitles.setEnabled(false);
    expect(ccButton().getAttribute('aria-pressed')).toBe('true');
    expect(subtitles.getStatus()).toEqual({ enabled: false, phase: 'off' });
  });

  it("keeps YouTube's captions hidden after the tab closes when CC was off before", async () => {
    await start({ youtubeSubtitles: true });
    expect(ccButton().getAttribute('aria-pressed')).toBe('true');
    // The tab closes: YouTube keeps CC on, but the viewer never chose it.
    subtitles!.dispose();
    subtitles = undefined;
    const next = await start({ youtubeSubtitles: false });
    expect(next.getStatus()).toEqual({ enabled: false, phase: 'off' });
    expect(document.documentElement.hasAttribute(NATIVE_CAPTIONS_HIDDEN_ATTRIBUTE)).toBe(true);
    expect(document.getElementById('justtranslate-youtube-subtitles-style')?.textContent).toContain(
      `html[${NATIVE_CAPTIONS_HIDDEN_ATTRIBUTE}] .ytp-caption-window-container`,
    );
    // The extension's own clicks are not the viewer's choice.
    ccButton().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    ccButton().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(localStorage.getItem(CAPTIONS_TURNED_ON_KEY)).toBe('1');
    // Turning subtitles on and off here gives the viewer's CC choice back.
    next.setEnabled(true);
    await settle();
    expect(next.getStatus().phase).toBe('on');
    next.setEnabled(false);
    expect(ccButton().getAttribute('aria-pressed')).toBe('false');
    expect(document.documentElement.hasAttribute(NATIVE_CAPTIONS_HIDDEN_ATTRIBUTE)).toBe(false);
  });

  it('follows another tab that gives CC back', async () => {
    localStorage.setItem(CAPTIONS_TURNED_ON_KEY, '1');
    await start();
    expect(document.documentElement.hasAttribute(NATIVE_CAPTIONS_HIDDEN_ATTRIBUTE)).toBe(true);
    localStorage.removeItem(CAPTIONS_TURNED_ON_KEY);
    window.dispatchEvent(new StorageEvent('storage', { key: CAPTIONS_TURNED_ON_KEY }));
    expect(document.documentElement.hasAttribute(NATIVE_CAPTIONS_HIDDEN_ATTRIBUTE)).toBe(false);
  });

  it('tells the viewer when a video has no captions', async () => {
    vi.useFakeTimers();
    try {
      ccButton().setAttribute('aria-disabled', 'true');
      settings.youtubeSubtitles = true;
      subtitles = new YouTubeSubtitles();
      subtitles.initialize();
      await vi.advanceTimersByTimeAsync(1_000);
      // A disabled button may still show the previous video: it is watched for a while.
      expect(subtitles.getStatus().phase).toBe('loading');
      await vi.advanceTimersByTimeAsync(9_000);
      expect(subtitles.getStatus()).toEqual({ enabled: true, phase: 'no-captions' });
      expect(toast()).toBe('此视频没有字幕');
      expect(ccButton().getAttribute('aria-pressed')).toBe('false');
      expect(ourButton()?.dataset.state).toBe('unavailable');
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits out a CC button still showing the previous video or an ad', async () => {
    vi.useFakeTimers();
    try {
      ccButton().setAttribute('aria-disabled', 'true');
      player().classList.add('ad-showing');
      settings.youtubeSubtitles = true;
      subtitles = new YouTubeSubtitles();
      subtitles.initialize();
      // A long ad does not use up the wait.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(subtitles.getStatus().phase).toBe('loading');
      player().classList.remove('ad-showing');
      await vi.advanceTimersByTimeAsync(2_000);
      expect(subtitles.getStatus().phase).toBe('loading');
      ccButton().removeAttribute('aria-disabled');
      await vi.advanceTimersByTimeAsync(500);
      expect(ccButton().getAttribute('aria-pressed')).toBe('true');
      expect(subtitles.getStatus().phase).toBe('on');
    } finally {
      vi.useRealTimers();
    }
  });

  it('tries reading preferences again when the worker did not answer', async () => {
    vi.useFakeTimers();
    try {
      settingsFailures = 1;
      settings.youtubeSubtitles = true;
      subtitles = new YouTubeSubtitles();
      subtitles.initialize();
      await vi.advanceTimersByTimeAsync(100);
      expect(ourButton()).toBeNull();
      await vi.advanceTimersByTimeAsync(1_500);
      expect(ourButton()).not.toBeNull();
      expect(subtitles.getStatus().phase).toBe('on');
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up when the player never loads a track', async () => {
    vi.useFakeTimers();
    try {
      delete captionsByVideo.video00001;
      settings.youtubeSubtitles = true;
      subtitles = new YouTubeSubtitles();
      subtitles.initialize();
      await vi.advanceTimersByTimeAsync(100);
      expect(subtitles.getStatus().phase).toBe('loading');
      expect(ccButton().getAttribute('aria-pressed')).toBe('true');
      await vi.advanceTimersByTimeAsync(20_000);
      expect(subtitles.getStatus()).toMatchObject({
        enabled: true,
        phase: 'error',
        error: { key: '未能获取字幕，请打开 YouTube 字幕后重试' },
      });
      // Captions the viewer then turns on are used without another click on our button.
      deliverCaptions('video00001', captionBody([0, 'Late line.']));
      await vi.advanceTimersByTimeAsync(100);
      expect(subtitles.getStatus().phase).toBe('on');
    } finally {
      vi.useRealTimers();
    }
  });

  it('follows in-site navigation to the next video', async () => {
    captionsByVideo.video00002 = captionBody([0, 'Second video.']);
    const subtitles = await start({ youtubeSubtitles: true });
    expect(subtitles.getStatus().phase).toBe('on');
    openVideo('video00002');
    document.dispatchEvent(new Event('yt-navigate-finish'));
    await settle();
    expect(requests.filter((request) => request.type === 'END_TRANSLATION_SESSION')).toHaveLength(
      1,
    );
    expect(subtitles.getStatus().phase).toBe('loading');
    // CC stays on across videos; the player loads the next track by itself.
    deliverCaptions('video00002', captionsByVideo.video00002);
    await settle();
    playAt(1);
    await settle();
    expect(shownLines()).toEqual({ original: 'Second video.', translation: '译文 Second video.' });
    // Leaving the watch page ends the session and keeps the player button.
    history.replaceState(null, '', '/');
    document.dispatchEvent(new Event('yt-navigate-finish'));
    expect(subtitles.getStatus().phase).toBe('off');
    expect(layer()).toBeUndefined();
    expect(ourButton()).not.toBeNull();
  });

  it('switches tracks when the viewer picks another caption language', async () => {
    const subtitles = await start({ youtubeSubtitles: true });
    deliverCaptions('video00001', captionBody([0, 'Bonjour le monde.']), 'fr');
    await settle();
    playAt(1);
    await settle();
    expect(shownLines()?.original).toBe('Bonjour le monde.');
    expect(subtitles.getStatus().phase).toBe('on');
    expect(requests).toContainEqual(
      expect.objectContaining({
        type: 'RESOLVE_TRANSLATION_CANDIDATES',
        candidates: [expect.objectContaining({ declaredLanguage: 'fr' })],
      }),
    );
  });

  it('hides lines while an ad plays in the same video element', async () => {
    await start({ youtubeSubtitles: true });
    playAt(1);
    await settle();
    expect(shownLines()?.original).toBe('Hello world.');
    player().classList.add('ad-showing');
    playAt(1);
    expect(shownLines()).toEqual({ original: '', translation: '' });
  });

  it('ignores forged or unrelated caption events', async () => {
    const subtitles = await start({ youtubeSubtitles: true });
    for (const detail of [
      { url: 'https://evil.example/api/timedtext?v=video00001&lang=de', body: '{}' },
      'not json',
      42,
    ])
      document.dispatchEvent(
        new CustomEvent(CAPTION_EVENT, {
          detail: typeof detail === 'object' ? JSON.stringify(detail) : detail,
        }),
      );
    await settle();
    playAt(1);
    await settle();
    expect(shownLines()?.original).toBe('Hello world.');
    expect(subtitles.getStatus().phase).toBe('on');
  });

  it('does nothing on excluded sites, even when asked from the popup', async () => {
    const subtitles = await start({ youtubeSubtitles: true, excludedSites: [location.hostname] });
    expect(ourButton()).toBeNull();
    subtitles.setEnabled(true);
    await settle();
    expect(ccButton().getAttribute('aria-pressed')).toBe('false');
    expect(subtitles.getStatus()).toEqual({ enabled: false, phase: 'off' });
    expect(requests.map((request) => request.type)).not.toContain('BEGIN_TRANSLATION_SESSION');
  });

  it('explains an unusable translation engine', async () => {
    const subtitles = await start({
      youtubeSubtitles: true,
      ready: false,
      configurationError: { text: '请先配置翻译服务' },
    });
    expect(subtitles.getStatus()).toEqual({
      enabled: true,
      phase: 'error',
      error: { text: '请先配置翻译服务' },
    });
    expect(toast()).toBe('请先配置翻译服务');
    expect(requests.map((request) => request.type)).not.toContain('BEGIN_TRANSLATION_SESSION');
  });
});
