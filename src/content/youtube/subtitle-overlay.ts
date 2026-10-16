import type { DisplayMode } from '../../shared/settings';

export interface SubtitleLine {
  original: string;
  /** Absent while the line is translating, failed or already in the target language. */
  translation?: string;
}

const STYLE = `
:host {
  all: initial;
  position: absolute;
  left: 0;
  right: 0;
  bottom: var(--jt-bottom, 12px);
  z-index: 35;
  display: flex;
  flex-direction: column;
  align-items: center;
  pointer-events: none;
  font-family: "YouTube Noto", Roboto, Arial, Helvetica, Verdana, "PT Sans Caption", sans-serif;
  font-size: var(--jt-font-size, 20px);
  line-height: 1.35;
  transition: bottom 0.2s ease;
}
.lines { max-width: 86%; display: flex; flex-direction: column; align-items: center; gap: 0.12em; }
.row { text-align: center; }
.line {
  background: rgba(8, 8, 8, 0.75);
  color: #fff;
  padding: 0.06em 0.32em;
  border-radius: 0.18em;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  box-decoration-break: clone;
  -webkit-box-decoration-break: clone;
}
.original .line { font-size: 0.8em; color: #e6e6e6; }
.toast {
  margin-bottom: 0.6em;
  font-size: 0.72em;
  background: rgba(28, 28, 28, 0.9);
  color: #fff;
  padding: 0.4em 0.8em;
  border-radius: 0.4em;
  max-width: 80%;
  text-align: center;
}
[hidden] { display: none !important; }
`;

/** Bilingual subtitle layer inside the YouTube player, so it follows fullscreen and theater mode. */
export class SubtitleOverlay {
  private readonly host: HTMLElement;
  private readonly toast: HTMLElement;
  private readonly originalRow: HTMLElement;
  private readonly translationRow: HTMLElement;
  private readonly originalLine: HTMLElement;
  private readonly translationLine: HTMLElement;
  private readonly resizeObserver: ResizeObserver | undefined;
  private readonly classObserver: MutationObserver;
  private toastTimer: ReturnType<typeof setTimeout> | undefined;
  private shown: { original: string; translation: string } = { original: '', translation: '' };

  constructor(private readonly player: HTMLElement) {
    const document = player.ownerDocument;
    this.host = document.createElement('div');
    this.host.setAttribute('translate', 'no');
    this.host.setAttribute('data-justranslate-subtitle-layer', '');
    const root = this.host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = STYLE;
    this.toast = document.createElement('div');
    this.toast.className = 'toast';
    this.toast.setAttribute('role', 'status');
    this.toast.hidden = true;
    const lines = document.createElement('div');
    lines.className = 'lines';
    [this.originalRow, this.originalLine] = createRow(document, 'original');
    [this.translationRow, this.translationLine] = createRow(document, 'translation');
    lines.append(this.originalRow, this.translationRow);
    root.append(style, this.toast, lines);
    this.resizeObserver =
      typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => this.layout());
    this.classObserver = new MutationObserver(() => this.layout());
  }

  mount(): void {
    if (!this.host.isConnected) this.player.append(this.host);
    this.resizeObserver?.observe(this.player);
    // YouTube marks hidden controls with ytp-autohide; lift the lines above visible controls.
    this.classObserver.observe(this.player, { attributes: true, attributeFilter: ['class'] });
    this.layout();
  }

  unmount(): void {
    this.resizeObserver?.disconnect();
    this.classObserver.disconnect();
    clearTimeout(this.toastTimer);
    this.host.remove();
  }

  show(line: SubtitleLine | undefined, displayMode: DisplayMode): void {
    const original =
      line && (displayMode === 'bilingual' || !line.translation) ? line.original : '';
    const translation = line?.translation ?? '';
    if (original === this.shown.original && translation === this.shown.translation) return;
    this.shown = { original, translation };
    this.originalLine.textContent = original;
    this.originalRow.hidden = !original;
    this.translationLine.textContent = translation;
    this.translationRow.hidden = !translation;
  }

  notify(text: string): void {
    clearTimeout(this.toastTimer);
    this.toast.textContent = text;
    this.toast.hidden = false;
    this.toastTimer = setTimeout(() => {
      this.toast.hidden = true;
    }, 4_000);
  }

  private layout(): void {
    const height = this.player.clientHeight || 360;
    this.host.style.setProperty(
      '--jt-font-size',
      `${Math.round(Math.min(42, Math.max(14, height * 0.042)))}px`,
    );
    const controlsVisible = !this.player.classList.contains('ytp-autohide');
    const controls = this.player.querySelector<HTMLElement>('.ytp-chrome-bottom');
    const bottom = controlsVisible
      ? (controls?.offsetHeight || 48) + 16
      : Math.max(12, Math.round(height * 0.03));
    this.host.style.setProperty('--jt-bottom', `${bottom}px`);
  }
}

function createRow(
  document: Document,
  kind: 'original' | 'translation',
): [HTMLElement, HTMLElement] {
  const row = document.createElement('div');
  row.className = `row ${kind}`;
  row.hidden = true;
  const line = document.createElement('span');
  line.className = 'line';
  line.dir = 'auto';
  row.append(line);
  return [row, line];
}
