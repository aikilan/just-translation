// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CAPTION_EVENT, CAPTION_REPLAY_EVENT } from './caption-protocol';

const CAPTION_URL = 'https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=en&fmt=json3&pot=x';

/** Stands in for the browser's XHR: open() records its arguments, load is dispatched by tests. */
class FakeXhr extends EventTarget {
  static opened: unknown[][] = [];
  status = 200;
  responseType: XMLHttpRequestResponseType = '';
  responseText = '';
  response: unknown = '';
  open(...args: unknown[]) {
    FakeXhr.opened.push(args);
  }
}

describe('YouTube caption hook', () => {
  let published: { url: string; body: string }[];
  let pageFetch: ReturnType<typeof vi.fn<(input: RequestInfo | URL) => Promise<Response>>>;
  let lifetime: AbortController;

  beforeEach(async () => {
    vi.resetModules();
    delete (window as unknown as Record<symbol, unknown>)[
      Symbol.for('justtranslate.youtubeCaptionHook')
    ];
    published = [];
    lifetime = new AbortController();
    FakeXhr.opened = [];
    pageFetch = vi.fn((input: RequestInfo | URL) => {
      const missing = (input instanceof Request ? input.url : input.toString()).includes('missing');
      return Promise.resolve(
        new Response(missing ? 'denied' : '{"events":[]}', { status: missing ? 403 : 200 }),
      );
    });
    vi.stubGlobal('fetch', pageFetch);
    // A fresh class per test: each hook wraps the prototype it finds.
    vi.stubGlobal('XMLHttpRequest', class extends FakeXhr {});
    document.addEventListener(
      CAPTION_EVENT,
      (event) => {
        const { detail } = event as CustomEvent<string>;
        published.push(JSON.parse(detail) as { url: string; body: string });
      },
      { signal: lifetime.signal },
    );
    await import('./caption-hook.iife');
  });

  afterEach(() => {
    lifetime.abort();
    vi.unstubAllGlobals();
  });

  it('shares caption responses the page fetches and returns them untouched', async () => {
    const response = await window.fetch(CAPTION_URL);
    expect(pageFetch).toHaveBeenCalledWith(CAPTION_URL);
    expect(await response.text()).toBe('{"events":[]}');
    await vi.waitFor(() =>
      expect(published).toEqual([{ url: CAPTION_URL, body: '{"events":[]}' }]),
    );
  });

  it('ignores other requests and failed caption responses', async () => {
    await window.fetch('https://www.youtube.com/youtubei/v1/player');
    await window.fetch(new Request('https://evil.example/api/timedtext?v=abcdefghijk'));
    await window.fetch(`${CAPTION_URL}&missing=1`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(published).toEqual([]);
  });

  it('reads caption responses loaded through XMLHttpRequest', () => {
    const request = new XMLHttpRequest() as unknown as FakeXhr;
    request.open('GET', CAPTION_URL, true);
    expect(FakeXhr.opened).toEqual([['GET', CAPTION_URL, true]]);
    request.responseText = '<transcript/>';
    request.dispatchEvent(new Event('load'));
    expect(published).toEqual([{ url: CAPTION_URL, body: '<transcript/>' }]);
    // A reused request object for something else is no longer read.
    request.open('GET', 'https://www.youtube.com/generate_204');
    request.dispatchEvent(new Event('load'));
    expect(published).toHaveLength(1);
  });

  it('replays recent responses for a content script that started late', async () => {
    const url = `${CAPTION_URL}&case=replay`;
    await window.fetch(url);
    await vi.waitFor(() => expect(published).toHaveLength(1));
    document.dispatchEvent(new CustomEvent(CAPTION_REPLAY_EVENT));
    // Hooks of earlier tests share this document; only this one has seen the URL.
    expect(published.filter((entry) => entry.url === url)).toEqual([
      { url, body: '{"events":[]}' },
      { url, body: '{"events":[]}' },
    ]);
  });

  it('installs once per page', async () => {
    vi.resetModules();
    await import('./caption-hook.iife');
    await window.fetch(CAPTION_URL);
    await vi.waitFor(() => expect(published).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(published).toHaveLength(1);
    expect(pageFetch).toHaveBeenCalledTimes(1);
  });
});
