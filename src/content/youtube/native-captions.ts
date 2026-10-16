import { ensurePageStyle } from './subtitle-button';

/** Kept in youtube.com's own storage, so every YouTube tab knows about it. */
export const CAPTIONS_TURNED_ON_KEY = 'justtranslate:youtube-captions-turned-on';
export const NATIVE_CAPTIONS_HIDDEN_ATTRIBUTE = 'data-justranslate-native-captions-hidden';

/**
 * YouTube remembers its CC switch across videos, tabs and reloads. When the extension switches CC
 * on only to receive caption data, it records that the viewer's own choice was off, and YouTube's
 * caption window stays hidden until the extension switches CC back off or the viewer changes CC.
 */
export class NativeCaptions {
  /** Used only when the page's storage cannot be written. */
  private turnedOnHere = false;

  initialize(signal: AbortSignal): void {
    ensurePageStyle(document);
    this.apply();
    // Only real input is the viewer's choice; the extension's own clicks are not trusted events.
    document.addEventListener(
      'click',
      (event) => {
        if (
          event.isTrusted &&
          event.target instanceof Element &&
          event.target.closest('.ytp-subtitles-button')
        )
          this.record(false);
      },
      { capture: true, signal },
    );
    document.addEventListener(
      'keydown',
      (event) => {
        if (event.isTrusted && isCaptionShortcut(event)) this.record(false);
      },
      { capture: true, signal },
    );
    // Another YouTube tab switched CC.
    window.addEventListener(
      'storage',
      (event) => {
        if (event.key === CAPTIONS_TURNED_ON_KEY || event.key === null) this.apply();
      },
      { signal },
    );
  }

  /** Switches CC on so the player loads the track, remembering that the viewer had it off. */
  turnOn(button: HTMLElement): void {
    if (button.getAttribute('aria-pressed') === 'true') return;
    this.record(true);
    button.click();
  }

  /** Switches CC back off if the extension turned it on and nobody changed it since. */
  restore(button: HTMLElement | null | undefined): void {
    if (!this.turnedOn) return;
    if (button?.getAttribute('aria-pressed') === 'true') button.click();
    this.record(false);
  }

  private get turnedOn(): boolean {
    return this.turnedOnHere || readTurnedOn();
  }

  private record(turnedOn: boolean): void {
    try {
      if (turnedOn) localStorage.setItem(CAPTIONS_TURNED_ON_KEY, '1');
      else localStorage.removeItem(CAPTIONS_TURNED_ON_KEY);
      this.turnedOnHere = false;
    } catch {
      // Without storage the choice lasts for this page only.
      this.turnedOnHere = turnedOn;
    }
    this.apply();
  }

  private apply(): void {
    document.documentElement.toggleAttribute(NATIVE_CAPTIONS_HIDDEN_ATTRIBUTE, this.turnedOn);
  }
}

function readTurnedOn(): boolean {
  try {
    return localStorage.getItem(CAPTIONS_TURNED_ON_KEY) === '1';
  } catch {
    return false;
  }
}

/** YouTube's own keyboard shortcut for captions. */
function isCaptionShortcut(event: KeyboardEvent): boolean {
  if (event.key.toLowerCase() !== 'c' || event.ctrlKey || event.metaKey || event.altKey)
    return false;
  const target = event.target;
  return !(
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  );
}
