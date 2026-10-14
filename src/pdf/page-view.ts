import { t } from '../shared/i18n';
import type { PdfTextBlock } from './text-layout';

export interface PdfPageSize {
  width: number;
  height: number;
}

export interface PdfPageElements {
  section: HTMLElement;
  visual: HTMLElement;
  canvas: HTMLCanvasElement;
  reading: HTMLElement;
}

/**
 * One page row: the rendered original beside its reading text. The original is excluded from
 * translation discovery; only the reading text is a translation source.
 */
export function createPageSection(
  ownerDocument: Document,
  pageNumber: number,
  size: PdfPageSize,
): PdfPageElements {
  const section = ownerDocument.createElement('section');
  section.className = 'pdf-page';
  section.dataset.pageNumber = String(pageNumber);
  section.style.setProperty('--pdf-page-ratio', String(size.height / size.width));

  const visual = ownerDocument.createElement('div');
  visual.className = 'pdf-page-visual';
  visual.setAttribute('translate', 'no');
  visual.setAttribute('aria-hidden', 'true');
  const canvas = ownerDocument.createElement('canvas');
  visual.append(canvas);

  const reading = ownerDocument.createElement('div');
  reading.className = 'pdf-page-reading';
  reading.dataset.state = 'pending';
  section.append(visual, reading);
  return { section, visual, canvas, reading };
}

/** Replaces a page's reading text; headings keep their relative weight to body text. */
export function renderPageText(
  reading: HTMLElement,
  blocks: readonly PdfTextBlock[],
  bodyFontSize: number | undefined,
): HTMLElement[] {
  const ownerDocument = reading.ownerDocument;
  reading.replaceChildren();
  const elements: HTMLElement[] = [];
  for (const block of blocks) {
    const element = ownerDocument.createElement(
      block.kind === 'heading'
        ? bodyFontSize !== undefined && block.fontSize >= bodyFontSize * 1.6
          ? 'h2'
          : 'h3'
        : 'p',
    );
    element.dir = 'auto';
    element.textContent = block.text;
    reading.append(element);
    elements.push(element);
  }
  if (blocks.length === 0) {
    const notice = ownerDocument.createElement('p');
    notice.className = 'pdf-page-empty';
    notice.setAttribute('translate', 'no');
    notice.textContent = t('此页没有可提取的文字，可能是扫描件或图片。');
    reading.append(notice);
    reading.dataset.state = 'empty';
  } else reading.dataset.state = 'ready';
  return elements;
}
