/**
 * Runs in YouTube's page world, registered for www.youtube.com only. It observes, and never
 * changes, the caption responses the YouTube player itself requests: those requests carry the
 * player's own tokens, which an extension cannot reproduce. Each response body is handed to the
 * extension's isolated content script as a string event; nothing else crosses the boundary.
 */
import {
  CAPTION_EVENT,
  CAPTION_REPLAY_EVENT,
  MAX_CAPTION_BODY_LENGTH,
  isTimedTextUrl,
} from './caption-protocol';

(() => {
  const installed = Symbol.for('justtranslate.youtubeCaptionHook');
  const scope = window as unknown as Record<symbol, boolean | undefined>;
  if (scope[installed]) return;
  scope[installed] = true;

  // The isolated script starts after the page; keep the last few responses for its replay request.
  const recent: string[] = [];
  const publish = (url: string, body: string) => {
    if (!body || body.length > MAX_CAPTION_BODY_LENGTH) return;
    const detail = JSON.stringify({ url, body });
    recent.push(detail);
    if (recent.length > 4) recent.shift();
    document.dispatchEvent(new CustomEvent(CAPTION_EVENT, { detail }));
  };
  document.addEventListener(CAPTION_REPLAY_EVENT, () => {
    for (const detail of recent) document.dispatchEvent(new CustomEvent(CAPTION_EVENT, { detail }));
  });

  // eslint-disable-next-line @typescript-eslint/unbound-method -- Called with the page's receiver below.
  const originalFetch = window.fetch;
  window.fetch = function fetch(this: unknown, ...args: Parameters<typeof originalFetch>) {
    const response = originalFetch.apply(this, args);
    try {
      const [input] = args;
      const url = new URL(input instanceof Request ? input.url : String(input), location.href).href;
      if (isTimedTextUrl(url))
        void response
          .then((result) => (result.ok ? result.clone().text() : ''))
          .then((body) => publish(url, body))
          .catch(() => undefined);
    } catch {
      // Observation must never change what the page receives.
    }
    return response;
  };

  const requests = new WeakMap<XMLHttpRequest, string>();
  const listening = new WeakSet<XMLHttpRequest>();
  function readLoadedCaption(this: XMLHttpRequest) {
    const url = requests.get(this);
    if (!url || this.status < 200 || this.status >= 300) return;
    try {
      if (this.responseType === '' || this.responseType === 'text') publish(url, this.responseText);
      else if (this.responseType === 'json') publish(url, JSON.stringify(this.response));
      else if (this.responseType === 'arraybuffer' && this.response instanceof ArrayBuffer)
        publish(url, new TextDecoder().decode(this.response));
    } catch {
      // A body we cannot read is simply not shared.
    }
  }
  type Open = (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) => void;
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Called with the request as receiver below.
  const originalOpen: Open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function open(
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    try {
      const href = new URL(String(url), location.href).href;
      if (isTimedTextUrl(href)) {
        requests.set(this, href);
        if (!listening.has(this)) {
          listening.add(this);
          this.addEventListener('load', readLoadedCaption);
        }
      } else requests.delete(this);
    } catch {
      requests.delete(this);
    }
    originalOpen.call(this, method, url, ...rest);
  };
})();
