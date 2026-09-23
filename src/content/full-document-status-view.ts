import { getUiLocale, renderMessage, subscribeUiLanguage, t } from '../shared/i18n';
import type { PageTranslationStatus } from '../shared/messages';

const HOST_ATTRIBUTE = 'data-justranslate-full-status';
interface Actions {
  stop: () => void;
  retry: () => void;
}

/** Own UI insertions/removals do not change the document's reading snapshot. */
export function isFullDocumentStatusMutation(mutation: MutationRecord): boolean {
  const owned = (node: Node) => node instanceof Element && node.hasAttribute(HOST_ATTRIBUTE);
  if (owned(mutation.target)) return true;
  const changed = [...mutation.addedNodes, ...mutation.removedNodes];
  return mutation.type === 'childList' && changed.length > 0 && changed.every(owned);
}

/** Presentation only: requests and source ownership remain in the full-document task. */
export class FullDocumentStatusView {
  private readonly host = document.createElement('div');
  private readonly panel = document.createElement('section');
  private readonly text = document.createElement('p');
  private readonly action = document.createElement('button');
  private readonly close = document.createElement('button');
  private status?: PageTranslationStatus;
  private unsubscribe?: () => void;
  private readonly onLeave = () => this.actions.stop();

  constructor(private readonly actions: Actions) {
    this.host.setAttribute(HOST_ATTRIBUTE, '');
    this.host.setAttribute('translate', 'no');
    this.host.className = 'notranslate';
    const shadow = this.host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial !important; position: fixed !important; right: 16px !important;
        bottom: 16px !important; z-index: 2147483647 !important; pointer-events: none !important;
        width: max-content !important; max-width: calc(100vw - 32px) !important; }
      section { box-sizing: border-box; padding: 12px 16px; border: 1px solid #cbd5e1;
        border-radius: 12px; background: #fff; color: #172033; font: 14px/1.5 system-ui;
        box-shadow: 0 4px 20px #0002; pointer-events: auto; max-width: 360px; }
      p { margin: 0 0 8px; overflow-wrap: anywhere; }
      section[aria-busy="true"] p::before { content: ''; display: inline-block; width: 10px;
        height: 10px; margin-inline-end: 8px; border: 2px solid #94a3b8;
        border-top-color: transparent; border-radius: 50%; animation: spin 1s linear infinite; }
      button { cursor: pointer; font: inherit; margin-inline-end: 12px; }
      button[hidden] { display: none; } @keyframes spin { to { transform: rotate(360deg); } }
      @media (prefers-reduced-motion: reduce) { section[aria-busy="true"] p::before { animation: none; } }
    `;
    this.text.setAttribute('role', 'status');
    this.text.setAttribute('aria-live', 'polite');
    this.action.type = this.close.type = 'button';
    this.action.addEventListener('click', () => {
      if (this.status?.phase === 'error') this.actions.retry();
      else this.actions.stop();
    });
    this.close.addEventListener('click', () => this.destroy());
    this.panel.append(this.text, this.action, this.close);
    shadow.append(style, this.panel);
  }

  update(status: PageTranslationStatus): void {
    this.status = { ...status };
    if (status.phase !== 'translating' && status.phase !== 'error') {
      this.destroy();
      return;
    }
    if (!this.host.isConnected) {
      document.documentElement.append(this.host);
      this.unsubscribe = subscribeUiLanguage(() => this.render());
      window.addEventListener('pagehide', this.onLeave);
    }
    this.render();
  }

  private render(): void {
    const status = this.status!;
    this.panel.lang = getUiLocale();
    this.panel.dir = getUiLocale() === 'ar' ? 'rtl' : 'ltr';
    this.panel.setAttribute('aria-busy', String(status.phase === 'translating'));
    this.text.textContent =
      status.phase === 'error'
        ? `${t('全文翻译失败')}：${renderMessage(status.error)}`
        : status.stage === 'collecting'
          ? t('收集全文')
          : status.stage === 'applying'
            ? t('应用全文译文')
            : t('全文翻译中');
    this.action.textContent = status.phase === 'error' ? t('重新全文翻译') : t('停止翻译');
    this.close.textContent = t('关闭');
    this.close.hidden = status.phase !== 'error';
  }

  destroy(): void {
    this.host.remove();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    window.removeEventListener('pagehide', this.onLeave);
  }
}
