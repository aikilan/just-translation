import { sendRuntimeMessage } from '../../shared/chrome-api';
import { message, renderMessage, type UiMessage } from '../../shared/i18n';
import {
  getErrorMessage,
  type PublicTranslatorSettings,
  type VideoSubtitlePhase,
  type VideoSubtitleStatus,
} from '../../shared/messages';
import { isUrlExcluded, type DisplayMode } from '../../shared/settings';
import { CAPTION_EVENT, CAPTION_REPLAY_EVENT } from './caption-protocol';
import {
  describeCaptionUrl,
  parseCaptionBody,
  type CaptionSource,
  type CaptionTrack,
} from './captions';
import { NativeCaptions } from './native-captions';
import { buildSentences, findSentenceAt, type SubtitleSentence } from './sentences';
import { SubtitleButton } from './subtitle-button';
import { SubtitleOverlay } from './subtitle-overlay';
import { SubtitleTranslator } from './subtitle-translator';

const CAPTION_WAIT_MS = 10_000;
const PLAYER_WAIT_MS = 8_000;
/** Re-plan the translation window at most this often while playing. */
const REPLAN_INTERVAL_MS = 1_000;
const ERROR_NOTICE_INTERVAL_MS = 30_000;
/** Caption responses of recently opened videos, for going back without reloading them. */
const MAX_RESPONSES = 4;
/** The worker may be restarting when the page loads; navigation also tries again. */
const SETTINGS_RETRY_MS = [1_000, 3_000, 10_000];

export function isYouTubeWatchHost(hostname = location.hostname): boolean {
  return hostname === 'www.youtube.com';
}

function currentVideoId(): string | undefined {
  if (location.pathname !== '/watch') return undefined;
  const id = new URLSearchParams(location.search).get('v');
  return id && /^[\w-]{6,20}$/u.test(id) ? id : undefined;
}

function findPlayer(): HTMLElement | null {
  return document.querySelector<HTMLElement>('#movie_player.html5-video-player');
}

function findCaptionsButton(): HTMLElement | null | undefined {
  return findPlayer()?.querySelector<HTMLElement>('.ytp-subtitles-button');
}

interface CaptionResponse {
  source: CaptionSource;
  body: string;
}

interface ActiveSubtitles {
  videoId: string;
  track: CaptionTrack;
  sentences: SubtitleSentence[];
  translator: SubtitleTranslator;
  overlay: SubtitleOverlay;
  player: HTMLElement;
  video: HTMLVideoElement;
  plannedAt: number;
  plannedPosition: number;
  frame: number | undefined;
  cleanup: (() => void)[];
}

/**
 * Bilingual subtitles for youtube.com/watch. Caption data comes from the player's own requests
 * (see caption-hook.iife.ts); each line is translated near its playback time and drawn in a
 * layer inside the player while YouTube's captions are hidden.
 */
export class YouTubeSubtitles {
  private enabled = false;
  /** This tab's choice made before preferences were known; it wins over the preference. */
  private chosen: boolean | undefined;
  private phase: VideoSubtitlePhase = 'off';
  private error: UiMessage | undefined;
  private displayMode: DisplayMode = 'bilingual';
  private excluded = false;
  /** Navigation events wait until exclusions and preferences are known. */
  private ready = false;
  private loadingSettings = false;
  private settingsRetries = 0;
  /** Unparsed: most caption loads happen while subtitles are off. */
  private readonly responses = new Map<string, CaptionResponse>();
  private active: ActiveSubtitles | undefined;
  /** The video whose captions are awaited; the timer runs once CC is on. */
  private waiting: { videoId: string; timer?: ReturnType<typeof setTimeout> } | undefined;
  /** Opening a video tries once; a failure is not retried on every later media event. */
  private attemptedVideoId: string | undefined;
  private button: SubtitleButton | undefined;
  private buttonObserver: MutationObserver | undefined;
  private readonly nativeCaptions = new NativeCaptions();
  private generation = 0;
  private lastErrorNoticeAt = Number.NEGATIVE_INFINITY;
  private readonly lifetime = new AbortController();

  initialize(): void {
    const { signal } = this.lifetime;
    this.nativeCaptions.initialize(signal);
    document.addEventListener(CAPTION_EVENT, (event) => this.receiveCaptions(event), { signal });
    // The page-world hook keeps responses that arrived before this script started.
    document.dispatchEvent(new CustomEvent(CAPTION_REPLAY_EVENT));
    document.addEventListener('yt-navigate-finish', () => this.navigate(), { signal });
    // Media events do not bubble; capturing them also notices a new video if YouTube renames its
    // navigation event.
    document.addEventListener('loadedmetadata', () => this.navigate(), { signal, capture: true });
    this.loadSettings();
  }

  getStatus(): VideoSubtitleStatus {
    return {
      enabled: this.enabled,
      phase: this.phase,
      ...(this.error ? { error: this.error } : {}),
    };
  }

  setEnabled(enabled: boolean): void {
    // Excluded sites never send captions anywhere, whoever asks.
    if (this.excluded || this.lifetime.signal.aborted) return;
    this.enabled = enabled;
    if (!this.ready) {
      this.chosen = enabled;
      this.updateButton();
      this.loadSettings();
      return;
    }
    if (enabled) {
      const videoId = currentVideoId();
      if (videoId && this.active?.videoId !== videoId) void this.activate(videoId);
      else this.updateButton();
    } else this.deactivate(true);
  }

  setDisplayMode(displayMode: DisplayMode): void {
    this.displayMode = displayMode;
    this.render();
  }

  /** Back/forward cache or unload: release the session but keep this tab's choice. */
  suspend(): void {
    this.deactivate(false);
  }

  /** A page restored from the back/forward cache shows its subtitles again. */
  resume(): void {
    this.attemptedVideoId = undefined;
    this.navigate();
  }

  /** The page is going away: stop everything, and leave YouTube's CC as it is, like a closed tab. */
  dispose(): void {
    this.enabled = false;
    this.deactivate(false);
    this.lifetime.abort();
    this.buttonObserver?.disconnect();
    this.button?.detach();
  }

  private loadSettings(): void {
    if (this.ready || this.excluded || this.loadingSettings || this.lifetime.signal.aborted) return;
    this.loadingSettings = true;
    void this.readSettings().then((settings) => {
      this.loadingSettings = false;
      if (this.lifetime.signal.aborted) return;
      if (!settings) {
        const delay = SETTINGS_RETRY_MS[this.settingsRetries++];
        if (delay !== undefined) setTimeout(() => this.loadSettings(), delay);
        return;
      }
      this.excluded = isUrlExcluded(location.href, settings.excludedSites);
      if (this.excluded) {
        this.enabled = false;
        return;
      }
      this.ready = true;
      this.displayMode = settings.displayMode;
      this.enabled = this.chosen ?? settings.youtubeSubtitles;
      this.watchForControls();
      this.navigate();
    });
  }

  private navigate(): void {
    if (this.lifetime.signal.aborted) return;
    if (!this.ready) {
      this.loadSettings();
      return;
    }
    this.mountButton();
    const videoId = currentVideoId();
    if (videoId !== this.attemptedVideoId) this.attemptedVideoId = undefined;
    if (this.active && this.active.videoId !== videoId) this.deactivate(false);
    if (this.waiting && this.waiting.videoId !== videoId) this.deactivate(false);
    if (this.enabled && videoId && !this.active && !this.waiting && !this.attemptedVideoId)
      void this.activate(videoId);
  }

  private receiveCaptions(event: Event): void {
    const detail = (event as CustomEvent<unknown>).detail;
    if (typeof detail !== 'string') return;
    let payload: unknown;
    try {
      payload = JSON.parse(detail);
    } catch {
      return;
    }
    if (!payload || typeof payload !== 'object') return;
    const { url, body } = payload as { url?: unknown; body?: unknown };
    if (typeof url !== 'string' || typeof body !== 'string') return;
    const source = describeCaptionUrl(url);
    if (!source) return;
    this.responses.delete(source.videoId);
    this.responses.set(source.videoId, { source, body });
    if (this.responses.size > MAX_RESPONSES)
      this.responses.delete(this.responses.keys().next().value!);
    // A new track for the current video: the one awaited, one the viewer turned on after a
    // failure, or another language chosen in the player.
    if (
      !this.ready ||
      !this.enabled ||
      source.videoId !== currentVideoId() ||
      this.active?.track.key === source.key
    )
      return;
    const track = parseCaptionBody(source, body);
    if (track) void this.useTrack(track);
  }

  private async activate(videoId: string): Promise<void> {
    const generation = ++this.generation;
    this.attemptedVideoId = videoId;
    this.clearWaiting();
    // Waiting starts now: the player may load the track while its controls are still appearing.
    const waiting: NonNullable<typeof this.waiting> = { videoId };
    this.waiting = waiting;
    this.setPhase('loading');
    const stored = this.responses.get(videoId);
    const track = stored && parseCaptionBody(stored.source, stored.body);
    if (track) {
      await this.useTrack(track);
      return;
    }
    const captionsButton = await this.waitForCaptionsButton(generation);
    if (generation !== this.generation) return;
    if (!captionsButton) {
      this.clearWaiting();
      this.setPhase('no-captions');
      this.notify(message('此视频没有字幕'));
      return;
    }
    waiting.timer = setTimeout(() => {
      if (generation !== this.generation) return;
      this.waiting = undefined;
      this.fail(message('未能获取字幕，请打开 YouTube 字幕后重试'));
    }, CAPTION_WAIT_MS);
    // The player asks for the track only while its CC is on.
    this.nativeCaptions.turnOn(captionsButton);
  }

  private async useTrack(track: CaptionTrack): Promise<void> {
    const generation = ++this.generation;
    this.clearWaiting();
    this.teardownActive();
    const player = findPlayer();
    const video = player?.querySelector<HTMLVideoElement>('video');
    const sentences = buildSentences(track);
    if (!player || !video || !sentences.length) {
      this.setPhase('no-captions');
      return;
    }
    const settings = await this.readSettings();
    if (generation !== this.generation || !this.enabled) return;
    if (!settings?.ready) {
      this.fail(settings?.configurationError ?? message('当前翻译引擎不可用'));
      return;
    }
    this.displayMode = settings.displayMode;
    const overlay = new SubtitleOverlay(player);
    const translator = new SubtitleTranslator(sentences, track.languageCode, {
      onChange: () => this.render(),
      onError: (error) => this.reportTranslationError(error),
    });
    const active: ActiveSubtitles = {
      videoId: track.videoId,
      track,
      sentences,
      translator,
      overlay,
      player,
      video,
      plannedAt: Number.NEGATIVE_INFINITY,
      plannedPosition: 0,
      frame: undefined,
      cleanup: [],
    };
    this.active = active;
    overlay.mount();
    player.setAttribute('data-justranslate-subtitles', '');
    const listen = (target: EventTarget, type: string, handler: () => void) => {
      target.addEventListener(type, handler);
      active.cleanup.push(() => target.removeEventListener(type, handler));
    };
    // One frame loop while playing: a frame is requested only when none is pending.
    const frame = () => {
      active.frame = undefined;
      if (this.active !== active) return;
      this.render();
      scheduleFrame();
    };
    const scheduleFrame = () => {
      if (active.frame === undefined && !video.paused) active.frame = requestAnimationFrame(frame);
    };
    listen(video, 'play', () => {
      this.render();
      scheduleFrame();
    });
    listen(video, 'timeupdate', () => this.render());
    listen(video, 'seeked', () => {
      // A seek needs its translations planned now, not at the next interval.
      active.plannedAt = Number.NEGATIVE_INFINITY;
      this.render();
    });
    active.cleanup.push(() => {
      if (active.frame !== undefined) cancelAnimationFrame(active.frame);
    });
    this.setPhase('on');
    this.render();
    scheduleFrame();
    try {
      await translator.start(settings.activeTranslator);
    } catch (error) {
      if (this.active === active) this.fail(getErrorMessage(error));
    }
  }

  private render(): void {
    const active = this.active;
    if (!active) return;
    // Ads play in the same video element; their time is not the video's.
    if (active.player.classList.contains('ad-showing')) {
      active.overlay.show(undefined, this.displayMode);
      return;
    }
    const position = active.video.currentTime * 1000;
    const now = performance.now();
    if (
      now - active.plannedAt >= REPLAN_INTERVAL_MS ||
      Math.abs(position - active.plannedPosition) > 5_000
    ) {
      active.plannedAt = now;
      active.plannedPosition = position;
      active.translator.setPosition(position);
    }
    const sentence = findSentenceAt(active.sentences, position);
    if (!sentence) {
      active.overlay.show(undefined, this.displayMode);
      return;
    }
    const translation = active.translator.translationOf(sentence.id);
    active.overlay.show(
      {
        original: sentence.text,
        translation: translation.state === 'translated' ? translation.text : undefined,
      },
      this.displayMode,
    );
  }

  /** Turning subtitles off also switches CC back off if the extension turned it on. */
  private deactivate(restoreCaptions: boolean): void {
    this.generation += 1;
    this.clearWaiting();
    this.teardownActive();
    if (restoreCaptions) this.nativeCaptions.restore(findCaptionsButton());
    this.setPhase('off');
  }

  private teardownActive(): void {
    const active = this.active;
    if (!active) return;
    this.active = undefined;
    for (const cleanup of active.cleanup) cleanup();
    active.translator.stop();
    active.overlay.unmount();
    active.player.removeAttribute('data-justranslate-subtitles');
  }

  private clearWaiting(): void {
    clearTimeout(this.waiting?.timer);
    this.waiting = undefined;
  }

  private fail(error: UiMessage): void {
    this.teardownActive();
    this.error = error;
    this.phase = 'error';
    this.updateButton();
    this.notify(error);
  }

  private reportTranslationError(error: UiMessage): void {
    const now = performance.now();
    if (now - this.lastErrorNoticeAt < ERROR_NOTICE_INTERVAL_MS) return;
    this.lastErrorNoticeAt = now;
    this.active?.overlay.notify(renderMessage(message('字幕翻译失败：{{p0}}', { p0: error })));
  }

  private notify(text: UiMessage): void {
    const player = findPlayer();
    if (!player) return;
    // Notices outlive an inactive layer: show them on a short-lived one.
    const overlay = this.active?.overlay ?? new SubtitleOverlay(player);
    if (!this.active) {
      overlay.mount();
      setTimeout(() => {
        if (this.active?.overlay !== overlay) overlay.unmount();
      }, 4_500);
    }
    overlay.notify(renderMessage(text));
  }

  private setPhase(phase: VideoSubtitlePhase): void {
    this.phase = phase;
    if (phase !== 'error') this.error = undefined;
    this.updateButton();
  }

  private updateButton(): void {
    this.button?.update(this.enabled, this.phase);
  }

  private mountButton(): void {
    const player = findPlayer();
    if (!player) return;
    this.button ??= new SubtitleButton(document, () => this.setEnabled(!this.enabled));
    if (this.button.attach(player)) this.updateButton();
  }

  /** The player and its controls are created after this script runs. */
  private watchForControls(): void {
    this.mountButton();
    if (this.button?.element.isConnected) return;
    this.buttonObserver = new MutationObserver(() => {
      this.mountButton();
      // The player keeps its controls across in-site navigation; navigate() re-checks them.
      if (this.button?.element.isConnected) this.buttonObserver?.disconnect();
    });
    this.buttonObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  /**
   * This video's CC button once it can be used. Right after navigation the button may still show
   * the previous video or an ad, so an unavailable button is watched until the time runs out;
   * ads do not count against it.
   */
  private async waitForCaptionsButton(generation: number): Promise<HTMLElement | undefined> {
    let deadline = performance.now() + PLAYER_WAIT_MS;
    while (generation === this.generation) {
      const player = findPlayer();
      const button = player?.querySelector<HTMLElement>('.ytp-subtitles-button');
      if (player?.classList.contains('ad-showing')) deadline = performance.now() + PLAYER_WAIT_MS;
      else if (button && !isUnavailable(button)) return button;
      if (performance.now() > deadline) return undefined;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return undefined;
  }

  private async readSettings(): Promise<PublicTranslatorSettings | undefined> {
    try {
      const result = await sendRuntimeMessage<PublicTranslatorSettings>({
        type: 'GET_PUBLIC_SETTINGS',
      });
      return result.ok ? result.data : undefined;
    } catch {
      return undefined;
    }
  }
}

function isUnavailable(button: HTMLElement): boolean {
  return (
    button.getAttribute('aria-disabled') === 'true' ||
    button.hidden ||
    getComputedStyle(button).display === 'none'
  );
}
