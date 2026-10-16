import { t } from '../../shared/i18n';
import type { VideoSubtitlePhase } from '../../shared/messages';

const SVG_NS = 'http://www.w3.org/2000/svg';
export const PAGE_STYLE_ID = 'justtranslate-youtube-subtitles-style';

/** Light-DOM rules: hide YouTube's own captions while ours are shown, and style our button. */
const PAGE_STYLE = `
#movie_player[data-justranslate-subtitles] .ytp-caption-window-container { display: none !important; }
.ytp-button[data-justranslate-subtitle-button] .jt-mark { opacity: 0; transition: opacity 0.1s; }
.ytp-button[data-justranslate-subtitle-button][aria-pressed="true"] .jt-mark { opacity: 1; }
.ytp-button[data-justranslate-subtitle-button][data-state="loading"] svg {
  animation: justtranslate-subtitle-pulse 1s ease-in-out infinite;
}
.ytp-button[data-justranslate-subtitle-button][data-state="unavailable"] { opacity: 0.45; }
@keyframes justtranslate-subtitle-pulse { 50% { opacity: 0.4; } }
`;

export function ensurePageStyle(document: Document): void {
  if (document.getElementById(PAGE_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = PAGE_STYLE_ID;
  style.textContent = PAGE_STYLE;
  (document.head ?? document.documentElement).append(style);
}

/** Toggle next to YouTube's CC button. It controls this tab only, never saved preferences. */
export class SubtitleButton {
  readonly element: HTMLButtonElement;

  constructor(document: Document, onClick: () => void) {
    this.element = document.createElement('button');
    this.element.type = 'button';
    this.element.className = 'ytp-button';
    this.element.setAttribute('data-justranslate-subtitle-button', '');
    this.element.setAttribute('translate', 'no');
    this.element.append(createIcon(document));
    this.element.addEventListener('click', (event) => {
      event.stopPropagation();
      onClick();
    });
    this.update(false, 'off');
  }

  /** Inserts the button before YouTube's CC button; returns false while the controls are missing. */
  attach(player: HTMLElement): boolean {
    if (this.element.isConnected && player.contains(this.element)) return true;
    const controls = player.querySelector('.ytp-right-controls');
    if (!controls) return false;
    ensurePageStyle(player.ownerDocument);
    const captions = controls.querySelector('.ytp-subtitles-button');
    if (captions?.parentElement === controls) controls.insertBefore(this.element, captions);
    else controls.prepend(this.element);
    return true;
  }

  detach(): void {
    this.element.remove();
  }

  update(enabled: boolean, phase: VideoSubtitlePhase): void {
    this.element.setAttribute('aria-pressed', String(enabled && phase === 'on'));
    this.element.dataset.state =
      phase === 'loading' ? 'loading' : phase === 'no-captions' ? 'unavailable' : phase;
    const label =
      phase === 'loading'
        ? t('正在获取字幕…')
        : phase === 'no-captions'
          ? t('此视频没有字幕')
          : enabled
            ? t('关闭双语字幕')
            : t('开启双语字幕');
    this.element.setAttribute('aria-label', label);
    this.element.title = label;
  }
}

function createIcon(document: Document): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 36 36');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  svg.setAttribute('aria-hidden', 'true');
  const shapes: [string, Record<string, string>][] = [
    // A caption frame with two lines of text: original above, translation below.
    [
      'rect',
      {
        x: '8',
        y: '10',
        width: '20',
        height: '15',
        rx: '2.5',
        fill: 'none',
        stroke: '#fff',
        'stroke-width': '2',
      },
    ],
    ['rect', { x: '11.5', y: '14', width: '13', height: '2', rx: '1', fill: '#fff' }],
    [
      'rect',
      { x: '11.5', y: '19', width: '8', height: '2', rx: '1', fill: '#fff', opacity: '0.7' },
    ],
    // Shown while subtitles are on, like YouTube's own CC underline.
    [
      'rect',
      { x: '8', y: '28', width: '20', height: '2.5', rx: '1.25', fill: '#f00', class: 'jt-mark' },
    ],
  ];
  for (const [name, attributes] of shapes) {
    const shape = document.createElementNS(SVG_NS, name);
    for (const [key, value] of Object.entries(attributes)) shape.setAttribute(key, value);
    svg.append(shape);
  }
  return svg;
}
