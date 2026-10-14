import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  extensionOrigin,
  getPdfFileName,
  getPdfViewerUrl,
  isLocalPdfUrl,
  isPdfViewerUrl,
  readPdfViewerParameters,
} from './pdf-viewer';

beforeEach(() => {
  vi.stubGlobal('chrome', {
    runtime: { getURL: (path: string) => `chrome-extension://abc/${path}` },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('PDF viewer addresses', () => {
  it('round-trips the source and translation request', () => {
    const url = getPdfViewerUrl('https://example.com/a b.pdf?x=1', 'full-document');
    expect(url).toBe(
      'chrome-extension://abc/src/pdf/index.html?file=https%3A%2F%2Fexample.com%2Fa+b.pdf%3Fx%3D1&translate=full-document',
    );
    expect(isPdfViewerUrl(url)).toBe(true);
    expect(readPdfViewerParameters(url)).toEqual({
      source: 'https://example.com/a b.pdf?x=1',
      translate: 'full-document',
    });
    expect(getPdfViewerUrl()).toBe('chrome-extension://abc/src/pdf/index.html');
  });

  it('ignores unsupported sources, foreign pages and unknown modes', () => {
    expect(
      readPdfViewerParameters(
        'chrome-extension://abc/src/pdf/index.html?file=javascript%3Aalert(1)&translate=all',
      ),
    ).toEqual({ source: undefined, translate: undefined });
    expect(isPdfViewerUrl('chrome-extension://other/src/pdf/index.html')).toBe(false);
    expect(isPdfViewerUrl('chrome-extension://abc/src/popup/index.html')).toBe(false);
    expect(isPdfViewerUrl('not a url')).toBe(false);
    expect(isPdfViewerUrl(undefined)).toBe(false);
  });

  it('derives the extension origin without relying on URL#origin', () => {
    expect(extensionOrigin()).toBe('chrome-extension://abc');
  });

  it('recognizes local PDFs by extension and names files for display', () => {
    expect(isLocalPdfUrl('file:///Users/me/Paper.PDF')).toBe(true);
    expect(isLocalPdfUrl('file:///Users/me/notes.txt')).toBe(false);
    expect(isLocalPdfUrl('https://example.com/a.pdf')).toBe(false);
    expect(getPdfFileName('https://example.com/papers/attention%20is%20all.pdf')).toBe(
      'attention is all.pdf',
    );
    expect(getPdfFileName('https://arxiv.org/')).toBe('arxiv.org');
  });
});
