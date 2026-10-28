import { t, subscribeUiLanguage } from '../shared/i18n';
import type { PublicTranslatorSettings, Result } from '../shared/messages';
import { isUrlExcluded } from '../shared/settings';
import { activeTranslatorName, type ActiveTranslator } from '../shared/translation-engines';
import type { SelectionAnchor } from './selection-translation-view';
import { positionSelectionPopup } from './selection-translation-view';

const ICON_SIZE = 28;
const MAX_SELECTION_CHARACTERS = 5_000;
/** Lets double/triple-click selections and keyboard extension settle before reading them. */
const SETTLE_DELAY_MS = 120;
/** Extension UI hosts; selecting inside them never offers another translation. */
const OWN_UI_SELECTOR =
  '[data-justranslate-selection],[data-justranslate-selection-icon],[data-justranslate-quick]';
const EDITABLE_SELECTOR = 'input,textarea,select,[contenteditable]:not([contenteditable="false"])';
/** Settings are reused across nearby selections instead of asking the background each time. */
const SETTINGS_TTL_MS = 5_000;

export interface SelectionIconRequest {
  text: string;
  anchor: SelectionAnchor;
  translator: ActiveTranslator;
}

type SettingsReader = () => Promise<Result<PublicTranslatorSettings>>;

/**
 * Offers a translate button beside a finished page selection. Showing it sends nothing: the
 * selected text leaves the page only when the user clicks, and the label names the recipient.
 */
export class SelectionIcon {
  private readonly host = document.createElement('div');
  private readonly button = document.createElement('button');
  private readonly events = new AbortController();
  private visible?: { request: SelectionIconRequest; dismiss: AbortController };
  private timer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private translatorName = '';
  private settings?: { at: number; result: Promise<Result<PublicTranslatorSettings>> };
  private readonly unsubscribe: () => void;

  constructor(
    private readonly readSettings: SettingsReader,
    private readonly onTranslate: (request: SelectionIconRequest) => void,
  ) {
    this.host.setAttribute('data-justranslate-selection-icon', '');
    this.host.setAttribute('translate', 'no');
    this.host.className = 'notranslate';
    const shadow = this.host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = ICON_STYLES;
    this.button.type = 'button';
    this.button.setAttribute('popover', 'manual');
    this.button.append(createIcon());
    // Keep the page selection: focusing the button would collapse it before the click lands.
    this.button.addEventListener('pointerdown', (event) => event.preventDefault());
    this.button.addEventListener('mousedown', (event) => event.preventDefault());
    this.button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const request = this.visible?.request;
      this.hide();
      if (request) this.onTranslate(request);
    });
    shadow.append(style, this.button);
    this.unsubscribe = subscribeUiLanguage(() => this.relabel());

    const options = { signal: this.events.signal };
    // Settings change in the popup or options page; returning to this page re-reads them.
    const invalidate = () => (this.settings = undefined);
    window.addEventListener('focus', invalidate, options);
    document.addEventListener('visibilitychange', invalidate, options);
    document.addEventListener('mouseup', (event) => this.schedule(event), options);
    document.addEventListener(
      'keyup',
      (event) => {
        if (event.shiftKey || event.key === 'Shift') this.schedule(event);
      },
      options,
    );
  }

  destroy(): void {
    this.hide();
    this.events.abort();
    this.unsubscribe();
  }

  hide(): void {
    clearTimeout(this.timer);
    this.generation += 1;
    const visible = this.visible;
    if (!visible) return;
    this.visible = undefined;
    visible.dismiss.abort();
    if (this.host.isConnected) this.button.hidePopover?.();
    this.host.remove();
  }

  private schedule(event: Event): void {
    if (event.composedPath().includes(this.host)) return;
    this.hide();
    const generation = this.generation;
    this.timer = setTimeout(() => void this.evaluate(event, generation), SETTLE_DELAY_MS);
  }

  private async evaluate(event: Event, generation: number): Promise<void> {
    const candidate = readSelection(event);
    if (!candidate) return;
    const result = await this.readCachedSettings();
    // A later selection, click or dismissal retires this evaluation.
    if (generation !== this.generation || !result?.ok) return;
    const settings = result.data;
    if (!settings.selectionIcon || isFrameExcluded(settings.excludedSites)) return;
    // The selection may have changed while settings were read.
    const current = readSelection(event);
    if (!current || current.text !== candidate.text) return;
    this.translatorName = activeTranslatorName(settings.activeTranslator, settings.profiles);
    this.show(
      {
        text: current.text,
        anchor: rangeAnchor(current.range),
        translator: settings.activeTranslator,
      },
      current.range,
    );
  }

  private readCachedSettings(): Promise<Result<PublicTranslatorSettings> | undefined> {
    const now = Date.now();
    if (!this.settings || now - this.settings.at > SETTINGS_TTL_MS) {
      const cached = { at: now, result: this.readSettings() };
      this.settings = cached;
      // Failures are not remembered; the next selection asks again.
      void cached.result.then(
        (result) => {
          if (!result.ok && this.settings === cached) this.settings = undefined;
        },
        () => {
          if (this.settings === cached) this.settings = undefined;
        },
      );
    }
    return this.settings.result.catch(() => undefined);
  }

  private show(request: SelectionIconRequest, range: Range): void {
    const rect = request.anchor.getRect();
    if (!rect) return;
    const dismiss = new AbortController();
    this.visible = { request, dismiss };
    this.relabel();
    document.documentElement.append(this.host);
    this.button.showPopover?.();
    const { left, top } = positionSelectionPopup(
      { left: rect.right + 4, right: rect.right + 4, top: rect.top, bottom: rect.bottom + 2 },
      ICON_SIZE,
      ICON_SIZE,
      document.documentElement.clientWidth || window.innerWidth,
      document.documentElement.clientHeight || window.innerHeight,
    );
    this.button.style.left = `${left}px`;
    this.button.style.top = `${top}px`;

    const options = { capture: true, signal: dismiss.signal };
    const hide = () => this.hide();
    document.addEventListener(
      'pointerdown',
      (event) => {
        if (!event.composedPath().includes(this.host)) hide();
      },
      options,
    );
    document.addEventListener(
      'keydown',
      (event) => {
        if (event.key === 'Escape') hide();
      },
      options,
    );
    document.addEventListener(
      'selectionchange',
      () => {
        if (window.getSelection()?.isCollapsed !== false) hide();
      },
      options,
    );
    // Only scrolling that moves the selection hides the button; unrelated carousels, tickers and
    // self-scrolling panes elsewhere on the page do not.
    window.addEventListener(
      'scroll',
      (event) => {
        const target = event.target;
        if (
          target === document ||
          (target instanceof Node && target.contains(range.commonAncestorContainer))
        )
          hide();
      },
      { ...options, passive: true },
    );
    window.addEventListener('resize', hide, options);
    window.addEventListener('blur', hide, options);
    window.addEventListener('pagehide', hide, options);
  }

  private relabel(): void {
    const label = t('翻译选中文字 · {{p0}}', { p0: this.translatorName });
    this.button.setAttribute('aria-label', label);
    this.button.title = label;
  }
}

/** An embedded frame follows its own host's rule and every ancestor's, including the top site. */
export function isFrameExcluded(
  excludedSites: string[],
  urls: readonly string[] = [location.href, ...Array.from(location.ancestorOrigins ?? [])],
): boolean {
  return urls.some((url) => isUrlExcluded(url, excludedSites));
}

/** Returns a finished, readable selection outside editors and extension UI. */
function readSelection(event: Event): { text: string; range: Range } | undefined {
  const target = event.composedPath().find((node): node is Element => node instanceof Element);
  if (target?.closest(OWN_UI_SELECTOR) || target?.closest(EDITABLE_SELECTOR)) return undefined;
  const active = document.activeElement;
  if (
    active instanceof HTMLElement &&
    (active.matches(EDITABLE_SELECTOR) || active.isContentEditable)
  )
    return undefined;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return undefined;
  const range = selection.getRangeAt(0);
  const container =
    range.commonAncestorContainer instanceof Element
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
  if (container?.closest(OWN_UI_SELECTOR) || container?.closest(EDITABLE_SELECTOR))
    return undefined;
  const text = selection.toString();
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > MAX_SELECTION_CHARACTERS || !/\p{L}/u.test(trimmed))
    return undefined;
  return { text, range: range.cloneRange() };
}

/** Anchors to the last line of the selection so the button sits where the pointer ended. */
export function rangeAnchor(range: Range): SelectionAnchor {
  const start = range.startContainer;
  const end = range.endContainer;
  return {
    getRect: () => {
      if (!start.isConnected || !end.isConnected) return null;
      const rects = Array.from(range.getClientRects()).filter(
        (rect) => rect.width > 0 || rect.height > 0,
      );
      const last = rects.at(-1);
      const whole = range.getBoundingClientRect();
      if (!last) return whole.width || whole.height ? whole : null;
      return { left: whole.left, right: last.right, top: whole.top, bottom: last.bottom };
    },
  };
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const ICON_PATHS = [
  'm5 8 6 6',
  'm4 14 6-6 2-3',
  'M2 5h12',
  'M7 2h1',
  'm22 22-5-10-5 10',
  'M14 18h6',
];

/** Built node by node: some hosts enforce Trusted Types on HTML string sinks. */
function createIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
  for (const [name, value] of Object.entries({
    viewBox: '0 0 24 24',
    width: '16',
    height: '16',
    'aria-hidden': 'true',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  }))
    svg.setAttribute(name, value);
  for (const d of ICON_PATHS) {
    const path = document.createElementNS(SVG_NAMESPACE, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

const ICON_STYLES = `
:host { all: initial; }
button {
  --surface: #fff;
  --text: #4f46e5;
  --border: #e2e2ea;
  color-scheme: light dark;
  position: fixed;
  inset: auto;
  box-sizing: border-box;
  display: grid;
  place-items: center;
  width: ${ICON_SIZE}px;
  height: ${ICON_SIZE}px;
  margin: 0;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text);
  box-shadow: 0 4px 14px rgb(0 0 0 / 16%);
  cursor: pointer;
  overflow: visible;
}
button:hover { background: color-mix(in srgb, var(--text) 10%, var(--surface)); }
button:focus-visible { outline: 2px solid var(--text); outline-offset: 2px; }
@media (prefers-color-scheme: dark) {
  button { --surface: #26272d; --text: #a5b4fc; --border: #3a3b44; }
}
`;
