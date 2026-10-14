// The legacy build supports every Chrome the extension does (120+); the modern build relies on
// JavaScript features that only very recent browsers ship.
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import type { PdfDocumentLoader, PdfLoadingTaskLike } from './pdf-reader';

GlobalWorkerOptions.workerSrc = workerUrl;

/** pdf.js resources ship inside the extension package; nothing is loaded from a CDN. */
export const loadPdfDocument: PdfDocumentLoader = (source) => {
  const assets = chrome.runtime.getURL('pdfjs/');
  return getDocument({
    ...(source.kind === 'url'
      ? // Cookies match what the browser's own viewer sends when opening the same address.
        { url: source.url, withCredentials: source.url.startsWith('http') }
      : { data: source.data }),
    cMapUrl: `${assets}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${assets}standard_fonts/`,
    wasmUrl: `${assets}wasm/`,
    iccUrl: `${assets}iccs/`,
    enableXfa: false,
  }) as unknown as PdfLoadingTaskLike;
};
