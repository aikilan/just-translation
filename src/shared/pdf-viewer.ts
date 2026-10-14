import type { TranslationMode } from './messages';

/** Built extension page that renders PDFs with pdf.js and hosts the regular page translator. */
export const PDF_VIEWER_PATH = 'src/pdf/index.html';

const SOURCE_PARAMETER = 'file';
const TRANSLATE_PARAMETER = 'translate';

export interface PdfViewerParameters {
  source?: string;
  translate?: TranslationMode;
}

/** All PDF viewer documents share one cache partition, separate from every website origin. */
export function extensionOrigin(): string {
  // URL#origin is "null" for chrome-extension: outside Chrome, so derive it from the base URL.
  return chrome.runtime.getURL('').replace(/\/$/u, '');
}

export function getPdfViewerUrl(source?: string, translate?: TranslationMode): string {
  const url = new URL(chrome.runtime.getURL(PDF_VIEWER_PATH));
  if (source) url.searchParams.set(SOURCE_PARAMETER, source);
  if (translate) url.searchParams.set(TRANSLATE_PARAMETER, translate);
  return url.href;
}

export function isPdfViewerUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}` === chrome.runtime.getURL(PDF_VIEWER_PATH);
  } catch {
    return false;
  }
}

/** Only network and local file documents can be opened; anything else is ignored. */
export function readPdfViewerParameters(value: string): PdfViewerParameters {
  const url = new URL(value);
  const source = url.searchParams.get(SOURCE_PARAMETER) ?? undefined;
  const translate = url.searchParams.get(TRANSLATE_PARAMETER);
  return {
    source: source && isSupportedPdfSource(source) ? source : undefined,
    translate: translate === 'segmented' || translate === 'full-document' ? translate : undefined,
  };
}

export function isSupportedPdfSource(value: string): boolean {
  try {
    return ['http:', 'https:', 'file:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

/** Content scripts cannot run on file:// without extra access, so local PDFs are recognised by name. */
export function isLocalPdfUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'file:' && /\.pdf$/iu.test(url.pathname);
  } catch {
    return false;
  }
}

/** Short display name for a PDF address, falling back to its host. */
export function getPdfFileName(value: string): string {
  try {
    const url = new URL(value);
    const name = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() ?? '');
    return name || url.hostname || value;
  } catch {
    return value;
  }
}
