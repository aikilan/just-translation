import { message, type UiMessage } from '../shared/i18n';
import {
  createPageSection,
  renderPageText,
  type PdfPageElements,
  type PdfPageSize,
} from './page-view';
import {
  buildPdfTextBlocks,
  findPageContinuation,
  isPageFurniture,
  joinPdfText,
  toPdfTextRuns,
  type PdfTextBlock,
  type PdfTextItemLike,
  type PdfTextRun,
} from './text-layout';

/** The few pdf.js document/page members the reader uses; tests supply light fakes. */
export interface PdfViewportLike {
  width: number;
  height: number;
  transform: number[];
}
export interface PdfPageLike {
  getViewport(parameters: { scale: number }): PdfViewportLike;
  getTextContent(): Promise<{ items: PdfTextItemLike[]; lang?: string | null }>;
  render(parameters: { canvas: HTMLCanvasElement; viewport: PdfViewportLike }): {
    promise: Promise<void>;
    cancel(): void;
  };
}
export interface PdfDocumentLike {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPageLike>;
  destroy(): Promise<void>;
}
export interface PdfLoadingTaskLike {
  promise: Promise<PdfDocumentLike>;
  onProgress?: ((progress: { loaded: number; total: number }) => void) | null;
  onPassword?: ((update: (password: string) => void, reason: number) => void) | null;
  destroy(): Promise<void>;
}

export type PdfSource =
  { kind: 'url'; url: string } | { kind: 'data'; name: string; data: Uint8Array<ArrayBuffer> };

export type PdfLoadError = 'file-access' | 'network' | 'invalid' | 'other';

export type PdfReaderState =
  | { phase: 'empty' }
  | { phase: 'loading'; percent?: number }
  | { phase: 'password'; incorrect: boolean }
  | { phase: 'extracting'; pageCount: number; extractedPages: number }
  | { phase: 'ready'; pageCount: number; textPages: number }
  | { phase: 'error'; kind: PdfLoadError; error: UiMessage };

export type PdfDocumentLoader = (source: PdfSource) => PdfLoadingTaskLike;

interface PageRecord {
  number: number;
  size: PdfPageSize;
  elements: PdfPageElements;
  page: PdfPageLike;
  near: boolean;
  renderedWidth?: number;
  render?: { cancel(): void };
}

const INCORRECT_PASSWORD = 2;
const MAX_RENDERED_PAGES = 16;
const MAX_CANVAS_PIXELS = 16_777_216;

/**
 * Loads one PDF into the viewer: every page gets a lazily rendered original and reading text
 * rebuilt from its text layer. Reading text is plain DOM, so the page translator works on it.
 */
export class PdfReader {
  private state: PdfReaderState = { phase: 'empty' };
  private generation = 0;
  private task: PdfLoadingTaskLike | undefined;
  private pages: PageRecord[] = [];
  private updatePassword: ((password: string) => void) | undefined;
  private readonly rendered = new Set<PageRecord>();
  private readonly visibility: IntersectionObserver | undefined;
  private readonly resize: ResizeObserver | undefined;
  private resizeTimer: number | undefined;
  private currentPage = 0;

  constructor(
    private readonly container: HTMLElement,
    private readonly load: PdfDocumentLoader,
    private readonly listeners: {
      onState: (state: PdfReaderState) => void;
      onPage?: (pageNumber: number) => void;
    },
  ) {
    const view = container.ownerDocument.defaultView;
    if (view && 'IntersectionObserver' in view)
      this.visibility = new view.IntersectionObserver((entries) => this.updateNearPages(entries), {
        rootMargin: '150% 0px',
      });
    if (view && 'ResizeObserver' in view)
      this.resize = new view.ResizeObserver(() => {
        view.clearTimeout(this.resizeTimer);
        this.resizeTimer = view.setTimeout(() => this.renderNearPages(), 150);
      });
    this.resize?.observe(container);
    view?.addEventListener('scroll', () => this.trackCurrentPage(), { passive: true });
  }

  getState(): PdfReaderState {
    return this.state;
  }

  async open(source: PdfSource): Promise<void> {
    const generation = ++this.generation;
    // Report loading synchronously so a translation request made right after open() is kept.
    this.setState({ phase: 'loading' });
    await this.close();
    if (generation !== this.generation) return;
    const task = this.load(source);
    this.task = task;
    task.onProgress = ({ loaded, total }) => {
      if (generation !== this.generation || this.state.phase !== 'loading') return;
      this.setState({
        phase: 'loading',
        percent: total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : undefined,
      });
    };
    task.onPassword = (update, reason) => {
      if (generation !== this.generation) return;
      this.updatePassword = update;
      this.setState({ phase: 'password', incorrect: reason === INCORRECT_PASSWORD });
    };
    let document: PdfDocumentLike;
    try {
      document = await task.promise;
    } catch (error) {
      if (generation === this.generation) this.setState(describeLoadError(error, source));
      return;
    }
    if (generation !== this.generation) return;
    await this.extract(document, generation);
  }

  submitPassword(password: string): void {
    if (this.state.phase !== 'password' || !this.updatePassword) return;
    const update = this.updatePassword;
    this.updatePassword = undefined;
    this.setState({ phase: 'loading' });
    update(password);
  }

  /** Re-renders originals after the layout changed their available width. */
  relayout(): void {
    this.renderNearPages();
  }

  async close(): Promise<void> {
    this.visibility?.disconnect();
    for (const record of this.pages) record.render?.cancel();
    this.pages = [];
    this.rendered.clear();
    this.updatePassword = undefined;
    this.currentPage = 0;
    this.container.replaceChildren();
    const task = this.task;
    this.task = undefined;
    await task?.destroy().catch(() => undefined);
  }

  private async extract(document: PdfDocumentLike, generation: number): Promise<void> {
    const pageCount = document.numPages;
    const sizes = new Map<number, number>();
    let textPages = 0;
    // The last body paragraph so far; a sentence broken by the page break is joined to it.
    let tail: { element: HTMLElement; block: PdfTextBlock } | undefined;
    this.setState({ phase: 'extracting', pageCount, extractedPages: 0 });
    try {
      for (let number = 1; number <= pageCount; number += 1) {
        const page = await document.getPage(number);
        if (generation !== this.generation) return;
        const viewport = page.getViewport({ scale: 1 });
        const size = { width: viewport.width, height: viewport.height };
        const elements = createPageSection(this.container.ownerDocument, number, size);
        const record: PageRecord = { number, size, elements, page, near: false };
        this.pages.push(record);
        this.container.append(elements.section);
        this.visibility?.observe(elements.section);
        if (number === 1) this.trackCurrentPage();

        const content = await page.getTextContent();
        if (generation !== this.generation) return;
        if (number === 1) applyDocumentLanguage(this.container, content.lang);
        const runs = toPdfTextRuns(content.items, viewport.transform);
        countFontSizes(runs, sizes);
        const body = dominantSize(sizes);
        let blocks = buildPdfTextBlocks(runs, body);
        const continuation = findPageContinuation(tail?.block, blocks, size.height, body);
        if (tail && continuation >= 0) {
          const text = joinPdfText(tail.block.text, blocks[continuation].text);
          tail.element.textContent = text;
          tail.block = { ...tail.block, text };
          blocks = blocks.filter((_, index) => index !== continuation);
        }
        const rendered = renderPageText(elements.reading, blocks, body);
        tail = undefined;
        for (let index = blocks.length - 1; index >= 0; index -= 1) {
          if (isPageFurniture(blocks[index], size.height, body)) continue;
          tail = { element: rendered[index], block: blocks[index] };
          break;
        }
        if (blocks.length > 0) textPages += 1;
        this.setState({ phase: 'extracting', pageCount, extractedPages: number });
      }
    } catch (error) {
      if (generation === this.generation)
        this.setState({ phase: 'error', kind: 'invalid', error: toLoadMessage(error) });
      return;
    }
    if (generation === this.generation) this.setState({ phase: 'ready', pageCount, textPages });
  }

  private updateNearPages(entries: IntersectionObserverEntry[]): void {
    for (const entry of entries) {
      const record = this.pages.find((page) => page.elements.section === entry.target);
      if (record) record.near = entry.isIntersecting;
    }
    this.renderNearPages();
  }

  private renderNearPages(): void {
    for (const record of this.pages) {
      if (!record.near) continue;
      const width = record.elements.visual.clientWidth;
      if (width > 0 && record.renderedWidth !== width) this.renderPage(record, width);
    }
    this.releaseFarPages();
  }

  private renderPage(record: PageRecord, cssWidth: number): void {
    record.render?.cancel();
    const view = this.container.ownerDocument.defaultView;
    const scale = cssWidth / record.size.width;
    const cssHeight = record.size.height * scale;
    const pixelRatio = Math.min(
      view?.devicePixelRatio || 1,
      Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, cssWidth * cssHeight)),
    );
    const viewport = record.page.getViewport({ scale: scale * pixelRatio });
    // Render offscreen first so a resize never blanks the page that is being read.
    const canvas = this.container.ownerDocument.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const task = record.page.render({ canvas, viewport });
    record.render = task;
    record.renderedWidth = cssWidth;
    this.rendered.add(record);
    task.promise.then(
      () => {
        if (record.render !== task) return;
        record.render = undefined;
        record.elements.canvas.replaceWith(canvas);
        record.elements.canvas = canvas;
      },
      () => {
        // Cancelled renders are replaced by a newer one; failed pages keep their placeholder.
        if (record.render !== task) return;
        record.render = undefined;
        record.renderedWidth = undefined;
      },
    );
  }

  /** Large documents keep only pages near the reading position as bitmaps. */
  private releaseFarPages(): void {
    if (this.rendered.size <= MAX_RENDERED_PAGES) return;
    const current = this.currentPage || 1;
    const far = [...this.rendered]
      .filter((record) => !record.near)
      .sort((left, right) => Math.abs(right.number - current) - Math.abs(left.number - current));
    for (const record of far) {
      if (this.rendered.size <= MAX_RENDERED_PAGES) break;
      record.render?.cancel();
      record.render = undefined;
      record.renderedWidth = undefined;
      const placeholder = this.container.ownerDocument.createElement('canvas');
      record.elements.canvas.replaceWith(placeholder);
      record.elements.canvas = placeholder;
      this.rendered.delete(record);
    }
  }

  private trackCurrentPage(): void {
    if (this.pages.length === 0) return;
    const view = this.container.ownerDocument.defaultView;
    const line = (view?.innerHeight ?? 0) * 0.35;
    // Sections are in document order; find the last one whose top passed the reading line.
    let low = 0;
    let high = this.pages.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (this.pages[middle].elements.section.getBoundingClientRect().top <= line) low = middle;
      else high = middle - 1;
    }
    const pageNumber = low + 1;
    if (pageNumber === this.currentPage) return;
    this.currentPage = pageNumber;
    this.listeners.onPage?.(pageNumber);
  }

  private setState(state: PdfReaderState): void {
    this.state = state;
    this.listeners.onState(state);
  }
}

function countFontSizes(runs: readonly PdfTextRun[], sizes: Map<number, number>): void {
  for (const run of runs) {
    const characters = run.text.trim().length;
    if (characters === 0) continue;
    const size = Math.round(run.fontSize * 2) / 2;
    sizes.set(size, (sizes.get(size) ?? 0) + characters);
  }
}

function dominantSize(sizes: ReadonlyMap<number, number>): number | undefined {
  let best: number | undefined;
  let count = 0;
  for (const [size, characters] of sizes) {
    if (characters > count) {
      best = size;
      count = characters;
    }
  }
  return best;
}

/** A valid document /Lang lets the translator skip text already in the target language. */
function applyDocumentLanguage(container: HTMLElement, language: string | null | undefined): void {
  if (!language) return;
  try {
    const [canonical] = Intl.getCanonicalLocales(language);
    if (canonical) container.lang = canonical;
  } catch {
    // Invalid language tags are common in generated PDFs; they are simply ignored.
  }
}

function describeLoadError(error: unknown, source: PdfSource): PdfReaderState {
  const name = error instanceof Error ? error.name : '';
  const status =
    typeof error === 'object' && error !== null && 'status' in error
      ? Number(error.status)
      : undefined;
  if (source.kind === 'url' && source.url.startsWith('file:'))
    return {
      phase: 'error',
      kind: 'file-access',
      error: message('无法读取本地 PDF。请在扩展详情页开启「允许访问文件网址」，或直接选择文件。'),
    };
  if (name === 'InvalidPDFException')
    return { phase: 'error', kind: 'invalid', error: message('无法识别此 PDF 文件') };
  if (name === 'ResponseException' || name === 'UnexpectedResponseException')
    return {
      phase: 'error',
      kind: 'network',
      error:
        status && Number.isFinite(status)
          ? message('PDF 下载失败（HTTP {{p0}}）', { p0: status })
          : message('PDF 下载失败，请检查网络后重试'),
    };
  return { phase: 'error', kind: 'other', error: toLoadMessage(error) };
}

function toLoadMessage(error: unknown): UiMessage {
  const detail = error instanceof Error ? error.message : String(error);
  return message('PDF 加载失败：{{p0}}', { p0: { text: detail.slice(0, 300) } });
}
