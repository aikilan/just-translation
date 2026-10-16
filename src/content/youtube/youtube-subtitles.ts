import { sendRuntimeMessage } from '../../shared/chrome-api';
import { message, renderMessage, type UiMessage } from '../../shared/i18n';
import type {
  PublicTranslatorSettings,
  VideoSubtitlePhase,
  VideoSubtitleStatus,
} from '../../shared/messages';
import { isUrlExcluded, type DisplayMode } from '../../shared/settings';
import { CAPTION_EVENT, CAPTION_REPLAY_EVENT } from './caption-protocol';
import { parseCaptionResponse, type CaptionTrack } from './captions';
import { buildSentences, findSentenceAt, type SubtitleSentence } from './sentences';
import { SubtitleButton } from './subtitle-button';
import { SubtitleOverlay } from './subtitle-overlay';
import { SubtitleTranslator } from './subtitle-translator';

const CAPTION_WAIT_MS = 10_000;
const PLAYER_WAIT_MS = 8_000;
/** Re-plan the translation window at most this often while playing. */
const REPLAN_INTERVAL_MS = 1_000;
const ERROR_NOTICE_INTERVAL_MS = 30_000;
/** Tracks of recently opened videos, for going back without reloading captions. */
const MAX_TRACKS = 8;

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
  private phase: VideoSubtitlePhase = 'off';
  private error: UiMessage | undefined;
  private displayMode: DisplayMode = 'bilingual';
  private excluded = false;
  /** Navigation events wait until exclusions and preferences are known. */
  private ready = false;
  private readonly tracks = new Map<string, CaptionTrack>();
  private active: ActiveSubtitles | undefined;
  /** The video whose captions are awaited, with its give-up timer. */
  private waiting: { videoId: string; timer: ReturnType<typeof setTimeout> } | undefined;
  /** Opening a video tries once; a failure is not retried on every later media event. */
  private attemptedVideoId: string | undefined;
  private button: SubtitleButton | undefined;
  private buttonObserver: MutationObserver | undefined;
  /** We switched YouTube's CC on to receive the track; switch it back when turned off. */
  private captionsTurnedOn = false;
  private generation = 0;
  private lastErrorNoticeAt = Number.NEGATIVE_INFINITY;
  private readonly lifetime = new AbortController();

  initialize(): void {
    const { signal } = this.lifetime;
    document.addEventListener(CAPTION_EVENT, (event) => this.receiveCaptions(event), { signal });
    // The page-world hook keeps responses that arrived before this script started.
    document.dispatchEvent(new CustomEvent(CAPTION_REPLAY_EVENT));
    document.addEventListener('yt-navigate-finish', () => this.navigate(), { signal });
    // Media events do not bubble; capturing them also notices a new video if YouTube renames its
    // navigation event.
    document.addEventListener('loadedmetadata', () => this.navigate(), { signal, capture: true });
    void this.readSettings().then((settings) => {
      if (!settings || signal.aborted) return;
      this.excluded = isUrlExcluded(location.href, settings.excludedSites);
      if (this.excluded) return;
      this.ready = true;
      this.watchForControls();
      if (settings.youtubeSubtitles) this.enabled = true;
      this.navigate();
    });
  }

  getStatus(): VideoSubtitleStatus {
    return {
      enabled: this.enabled,
      phase: this.phase,
      ...(this.error ? { error: this.error } : {}),
    };
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
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

  dispose(): void {
    this.lifetime.abort();
    this.enabled = false;
    this.deactivate(true);
    this.buttonObserver?.disconnect();
    this.button?.detach();
  }

  private navigate(): void {
    if (!this.ready || this.lifetime.signal.aborted) return;
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
    const track = parseCaptionResponse(url, body);
    if (!track) return;
    this.tracks.delete(track.videoId);
    this.tracks.set(track.videoId, track);
    if (this.tracks.size > MAX_TRACKS) this.tracks.delete(this.tracks.keys().next().value!);
    // A new track for the current video: the one awaited, one the viewer turned on after a
    // failure, or another language chosen in the player.
    if (this.enabled && track.videoId === currentVideoId() && this.active?.track.key !== track.key)
      void this.useTrack(track);
  }

  private async activate(videoId: string): Promise<void> {
    const generation = ++this.generation;
    this.attemptedVideoId = videoId;
    this.clearWaiting();
    // Waiting starts now: the player may load the track while the controls are still appearing.
    this.waiting = {
      videoId,
      timer: setTimeout(() => {
        if (generation !== this.generation) return;
        this.waiting = undefined;
        this.fail(message('未能获取字幕，请打开 YouTube 字幕后重试'));
      }, PLAYER_WAIT_MS + CAPTION_WAIT_MS),
    };
    this.setPhase('loading');
    const settings = await this.readSettings();
    if (generation !== this.generation || !this.enabled) return;
    if (settings) this.displayMode = settings.displayMode;
    const track = this.tracks.get(videoId);
    if (track) {
      await this.useTrack(track);
      return;
    }
    const captionsButton = await this.waitForCaptionsButton(generation);
    if (generation !== this.generation) return;
    if (!captionsButton || isUnavailable(captionsButton)) {
      this.clearWaiting();
      this.setPhase('no-captions');
      this.notify(message('此视频没有字幕'));
      return;
    }
    // The player asks for the track only while its CC is on.
    if (captionsButton.getAttribute('aria-pressed') !== 'true') {
      captionsButton.click();
      this.captionsTurnedOn = true;
    }
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
    const tick = () => {
      active.frame = undefined;
      if (this.active !== active) return;
      this.render();
      if (!video.paused) active.frame = requestAnimationFrame(tick);
    };
    listen(video, 'play', tick);
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
    tick();
    try {
      await translator.start(settings.activeTranslator);
    } catch (error) {
      if (this.active === active) this.fail(toMessage(error));
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

  private deactivate(restoreCaptions: boolean): void {
    this.generation += 1;
    this.clearWaiting();
    this.teardownActive();
    if (restoreCaptions && this.captionsTurnedOn) {
      const captionsButton = findPlayer()?.querySelector<HTMLElement>('.ytp-subtitles-button');
      if (captionsButton?.getAttribute('aria-pressed') === 'true') captionsButton.click();
    }
    if (restoreCaptions) this.captionsTurnedOn = false;
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
    if (this.waiting) clearTimeout(this.waiting.timer);
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

  private async waitForCaptionsButton(generation: number): Promise<HTMLElement | undefined> {
    const deadline = performance.now() + PLAYER_WAIT_MS;
    while (generation === this.generation) {
      const button = findPlayer()?.querySelector<HTMLElement>('.ytp-subtitles-button');
      if (button) return button;
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

function toMessage(error: unknown): UiMessage {
  return error && typeof error === 'object' && 'uiMessage' in error
    ? (error as { uiMessage: UiMessage }).uiMessage
    : error instanceof Error
      ? { text: error.message }
      : message('发生未知错误');
}
