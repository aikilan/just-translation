import type { SelectionTranslationResult } from '../shared/messages';
import styles from './selection-translation.css?inline';

export interface SelectionRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}
export interface SelectionAnchor {
  getRect(): SelectionRect | null;
}
interface ViewActions {
  close: () => void;
  retry: () => void;
}

/** Fixed coordinates in the selected document; iframe results stay within that frame's viewport. */
export function positionSelectionPopup(
  anchor: SelectionRect,
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
): { left: number; top: number } {
  const below = anchor.bottom + 8;
  const top = below + height <= viewportHeight - 12 ? below : anchor.top - height - 8;
  return {
    left: Math.max(12, Math.min(anchor.left, viewportWidth - width - 12)),
    top: Math.max(12, Math.min(top, viewportHeight - height - 12)),
  };
}

/** Owns only presentation and DOM listeners; request lifetime belongs to the controller. */
export class SelectionTranslationView {
  private readonly host = document.createElement('div');
  private readonly popup = document.createElement('section');
  private readonly status = document.createElement('p');
  private readonly result = document.createElement('div');
  private readonly source = document.createElement('p');
  private readonly language = document.createElement('span');
  private readonly copy: HTMLButtonElement;
  private readonly retry: HTMLButtonElement;
  private readonly events = new AbortController();
  private readonly observer = new MutationObserver(() => this.position());
  private anchor?: SelectionAnchor;
  private previousFocus?: Element | null;
  private translated = '';

  constructor(private readonly actions: ViewActions) {
    this.host.setAttribute('data-justranslate-selection', '');
    this.host.setAttribute('translate', 'no');
    this.host.className = 'notranslate';
    const shadow = this.host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = styles;
    this.popup.setAttribute('popover', 'manual');
    this.popup.setAttribute('role', 'dialog');
    this.popup.setAttribute('aria-label', '划选翻译');
    const header = document.createElement('header');
    const title = document.createElement('strong');
    title.textContent = '只是翻译';
    this.language.className = 'language';
    const close = this.button('close', '关闭', actions.close);
    close.setAttribute('aria-label', '关闭划选翻译');
    header.append(title, this.language, close);
    this.status.className = 'status';
    this.status.setAttribute('role', 'status');
    this.status.setAttribute('aria-live', 'polite');
    this.result.className = 'result';
    this.result.setAttribute('dir', 'auto');
    this.result.tabIndex = 0;
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = '查看原文';
    this.source.className = 'source';
    this.source.setAttribute('dir', 'auto');
    details.append(summary, this.source);
    details.addEventListener('toggle', () => this.position(), { signal: this.events.signal });
    const footer = document.createElement('footer');
    this.copy = this.button('copy', '复制译文', () => {
      void this.copyTranslation();
    });
    this.retry = this.button('retry', '重试', actions.retry);
    footer.append(this.copy, this.retry);
    const content = document.createElement('div');
    content.className = 'content';
    content.append(this.status, this.result, details);
    this.popup.append(header, content, footer);
    shadow.append(style, this.popup);
  }

  show(text: string, anchor: SelectionAnchor): void {
    this.anchor = anchor;
    this.source.textContent = text;
    this.previousFocus = document.activeElement;
    document.documentElement.append(this.host);
    this.popup.showPopover();
    this.pending();
    if (!this.host.isConnected) return;
    const options = { capture: true, signal: this.events.signal };
    document.addEventListener(
      'pointerdown',
      (event) => {
        if (!event.composedPath().includes(this.host)) this.actions.close();
      },
      options,
    );
    document.addEventListener(
      'keydown',
      (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          this.actions.close();
        }
      },
      options,
    );
    window.addEventListener('scroll', () => this.position(), options);
    window.addEventListener('resize', () => this.position(), options);
    window.visualViewport?.addEventListener('resize', () => this.position(), options);
    window.visualViewport?.addEventListener('scroll', () => this.position(), options);
    window.addEventListener('pagehide', this.actions.close, { signal: this.events.signal });
    this.observer.observe(document.documentElement, { childList: true, subtree: true });
    this.popup
      .querySelector<HTMLButtonElement>('[data-action="close"]')!
      .focus({ preventScroll: true });
  }

  pending(): void {
    this.translated = '';
    this.result.textContent = '';
    this.language.textContent = '';
    this.status.textContent = '翻译中…';
    this.popup.setAttribute('aria-busy', 'true');
    this.copy.hidden = true;
    this.retry.hidden = true;
    this.position();
  }

  success(result: SelectionTranslationResult): void {
    this.translated = result.text;
    this.result.textContent = result.text;
    this.language.textContent = result.targetLanguage;
    this.status.textContent = '翻译完成';
    this.popup.setAttribute('aria-busy', 'false');
    this.copy.hidden = false;
    this.retry.hidden = true;
    this.position();
  }

  error(message: string): void {
    this.status.textContent = message;
    this.popup.setAttribute('aria-busy', 'false');
    this.retry.hidden = false;
    this.copy.hidden = true;
    this.position();
  }

  destroy(): void {
    const restoreFocus = document.activeElement === this.host;
    this.events.abort();
    this.observer.disconnect();
    if (this.host.isConnected) this.popup.hidePopover();
    this.host.remove();
    if (restoreFocus && this.previousFocus instanceof HTMLElement && this.previousFocus.isConnected)
      this.previousFocus.focus({ preventScroll: true });
  }

  private position(): void {
    if (!this.host.isConnected || !this.anchor) return;
    const rect = this.anchor.getRect();
    if (!rect) {
      this.actions.close();
      return;
    }
    const viewport = window.visualViewport;
    const width = viewport?.width ?? window.innerWidth;
    const height = viewport?.height ?? window.innerHeight;
    const offsetLeft = viewport?.offsetLeft ?? 0;
    const offsetTop = viewport?.offsetTop ?? 0;
    this.popup.style.width = `${Math.min(380, Math.max(0, width - 24))}px`;
    this.popup.style.maxHeight = `${Math.min(480, height * 0.7)}px`;
    const bounds = this.popup.getBoundingClientRect();
    const point = positionSelectionPopup(
      {
        left: rect.left - offsetLeft,
        right: rect.right - offsetLeft,
        top: rect.top - offsetTop,
        bottom: rect.bottom - offsetTop,
      },
      bounds.width,
      bounds.height,
      width,
      height,
    );
    this.popup.style.left = `${point.left + offsetLeft}px`;
    this.popup.style.top = `${point.top + offsetTop}px`;
  }

  private button(action: string, label: string, callback: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.action = action;
    button.textContent = label;
    button.addEventListener('click', callback, { signal: this.events.signal });
    return button;
  }

  private async copyTranslation(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.translated);
      if (this.host.isConnected) this.status.textContent = '已复制译文';
    } catch {
      if (this.host.isConnected) this.status.textContent = '复制失败，请手动选择复制译文';
    }
  }
}
