/**
 * Rebuilds reading blocks from pdf.js text runs. PDF text has no paragraph structure, so the
 * reading view relies on geometry: lines share a baseline, paragraphs share a column and leading.
 * Everything here is pure so layout heuristics can be tested without a PDF engine.
 */

/** One horizontal text run in top-left page coordinates at scale 1 (CSS pixels = PDF points). */
export interface PdfTextRun {
  text: string;
  x: number;
  baseline: number;
  width: number;
  fontSize: number;
  hasEOL: boolean;
}

export type PdfTextBlockKind = 'heading' | 'paragraph';

export interface PdfTextBlock {
  kind: PdfTextBlockKind;
  text: string;
  fontSize: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Minimal structural view of a pdf.js TextItem; marked-content entries have no `str`. */
export interface PdfTextItemLike {
  str?: unknown;
  transform?: unknown;
  width?: unknown;
  hasEOL?: unknown;
}

interface PdfLine {
  text: string;
  left: number;
  right: number;
  baseline: number;
  fontSize: number;
  /** Characters per font size; the dominant size decides line/paragraph typography. */
  sizes: Map<number, number>;
  /** First baseline of each size, so superscripts never move the line's baseline. */
  baselines: Map<number, { baseline: number; fontSize: number }>;
  pendingSpace: boolean;
}

interface PdfParagraph {
  lines: PdfLine[];
  fontSize: number;
  left: number;
  right: number;
}

type Matrix = readonly [number, number, number, number, number, number];

const CJK_PATTERN = /[぀-ヿ㄀-ㄯ㐀-䶿一-鿿가-힯豈-﫿＀-￯]/u;
const CJK_IDEOGRAPH = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;
const TERMINAL_PUNCTUATION = /[.!?。！？:：;；]["'”’)）\]]*$/u;
const LIST_MARKER = /^(?:[•◦▪▫●○■□‣⁃∙·*]|[-–—](?=\s)|\(?\d{1,3}[.)](?=\s)|\[\d{1,4}\])/u;
const ROTATION_TOLERANCE = 0.02;

/** Converts pdf.js items through the page viewport; rotated and vertical text are left out. */
export function toPdfTextRuns(
  items: readonly PdfTextItemLike[],
  viewportTransform: readonly number[],
): PdfTextRun[] {
  const viewport = toMatrix(viewportTransform);
  if (!viewport) return [];
  const runs: PdfTextRun[] = [];
  for (const item of items) {
    if (typeof item.str !== 'string') continue;
    const transform = toMatrix(item.transform);
    if (!transform) continue;
    const [a, b, c, d, x, baseline] = multiply(viewport, transform);
    const fontSize = Math.hypot(c, d);
    const scaleX = Math.hypot(a, b);
    if (!(fontSize > 0) || !(scaleX > 0)) continue;
    // Margin stamps (for example arXiv identifiers) are rotated; they never belong to body text.
    if (Math.abs(b) / scaleX > ROTATION_TOLERANCE || Math.abs(c) / fontSize > ROTATION_TOLERANCE)
      continue;
    if (a < 0 || d > 0) continue;
    const width = typeof item.width === 'number' && item.width > 0 ? item.width : 0;
    runs.push({
      text: item.str,
      x,
      baseline,
      // TextItem width is measured in the page's user space; the viewport scale converts it.
      width: width * Math.hypot(viewport[0], viewport[1]),
      fontSize,
      hasEOL: item.hasEOL === true,
    });
  }
  return runs;
}

/** Most frequent run size weighted by characters, used to tell headings from body text. */
export function dominantFontSize(runs: readonly PdfTextRun[]): number | undefined {
  const sizes = new Map<number, number>();
  for (const run of runs) {
    const characters = run.text.trim().length;
    if (characters === 0) continue;
    const size = roundSize(run.fontSize);
    sizes.set(size, (sizes.get(size) ?? 0) + characters);
  }
  return pickDominant(sizes);
}

/**
 * Groups runs into lines and lines into paragraphs. Content-stream order is kept: it is the
 * author's reading order in almost every generated PDF, including multi-column layouts.
 */
export function buildPdfTextBlocks(
  runs: readonly PdfTextRun[],
  bodyFontSize = dominantFontSize(runs),
): PdfTextBlock[] {
  const lines = buildLines(runs);
  const metrics = measureLines(lines);
  const paragraphs: PdfParagraph[] = [];
  let current: PdfParagraph | undefined;
  for (const line of lines) {
    if (current && continuesParagraph(current, line, metrics)) {
      current.lines.push(line);
      current.left = Math.min(current.left, line.left);
      current.right = Math.max(current.right, line.right);
      continue;
    }
    current = { lines: [line], fontSize: line.fontSize, left: line.left, right: line.right };
    paragraphs.push(current);
  }
  return paragraphs.flatMap((paragraph) => {
    const text = joinLines(paragraph.lines);
    if (!text) return [];
    const first = paragraph.lines[0];
    const last = paragraph.lines[paragraph.lines.length - 1];
    const heading =
      bodyFontSize !== undefined &&
      paragraph.fontSize >= bodyFontSize * 1.18 &&
      paragraph.lines.length <= 3 &&
      text.length <= 200;
    return [
      {
        kind: heading ? 'heading' : 'paragraph',
        text,
        fontSize: paragraph.fontSize,
        left: paragraph.left,
        top: first.baseline - first.fontSize,
        right: paragraph.right,
        bottom: last.baseline + last.fontSize * 0.25,
      },
    ];
  });
}

function buildLines(runs: readonly PdfTextRun[]): PdfLine[] {
  const lines: PdfLine[] = [];
  let line: PdfLine | undefined;
  const finish = () => {
    if (line && line.text.trim()) lines.push(line);
    line = undefined;
  };
  for (const run of runs) {
    const text = run.text.replace(/\s+/gu, ' ');
    if (!text.trim()) {
      // pdf.js emits explicit spaces as their own items; they only separate words.
      if (line && text) line.pendingSpace = true;
      if (run.hasEOL) finish();
      continue;
    }
    if (line && !continuesLine(line, run)) finish();
    if (!line) {
      line = {
        text: '',
        left: run.x,
        right: run.x + run.width,
        baseline: run.baseline,
        fontSize: run.fontSize,
        sizes: new Map(),
        baselines: new Map(),
        pendingSpace: false,
      };
    } else {
      const gap = run.x - line.right;
      const needsSpace = line.pendingSpace || gap > Math.min(line.fontSize, run.fontSize) * 0.15;
      if (needsSpace && !/\s$/u.test(line.text) && !/^\s/u.test(text)) {
        if (!(CJK_PATTERN.test(line.text.slice(-1)) && CJK_PATTERN.test(text.charAt(0))))
          line.text += ' ';
      }
    }
    line.text += text;
    line.pendingSpace = false;
    line.left = Math.min(line.left, run.x);
    line.right = Math.max(line.right, run.x + run.width);
    const size = roundSize(run.fontSize);
    line.sizes.set(size, (line.sizes.get(size) ?? 0) + text.trim().length);
    if (!line.baselines.has(size))
      line.baselines.set(size, { baseline: run.baseline, fontSize: run.fontSize });
    const dominant = line.baselines.get(pickDominant(line.sizes) ?? size);
    if (dominant) {
      line.fontSize = dominant.fontSize;
      line.baseline = dominant.baseline;
    }
    if (run.hasEOL) finish();
  }
  finish();
  return lines.map((value) => ({ ...value, text: value.text.trim() }));
}

function continuesLine(line: PdfLine, run: PdfTextRun): boolean {
  const size = Math.max(line.fontSize, run.fontSize);
  // Compare glyph boxes so superscripts and subscripts stay on their line.
  const lineTop = line.baseline - line.fontSize;
  const runTop = run.baseline - run.fontSize;
  const overlap =
    Math.min(line.baseline + line.fontSize * 0.2, run.baseline + run.fontSize * 0.2) -
    Math.max(lineTop, runTop);
  if (overlap < Math.min(line.fontSize, run.fontSize) * 0.5) return false;
  const gap = run.x - line.right;
  // Backward jumps and wide gaps separate table cells and side-by-side columns.
  return gap > -size * 0.5 && gap < size * 1.5;
}

interface LineMetrics {
  /** Median baseline distance between neighbouring lines of one size within a column. */
  spacing: Map<number, number>;
  /** Upper-quartile line width per size: the column measure that full lines reach. */
  width: Map<number, number>;
}

function measureLines(lines: readonly PdfLine[]): LineMetrics {
  const distances = new Map<number, number[]>();
  const widths = new Map<number, number[]>();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const size = roundSize(line.fontSize);
    push(widths, size, line.right - line.left);
    const previous = lines[index - 1];
    if (!previous || size !== roundSize(previous.fontSize) || !overlapsHorizontally(previous, line))
      continue;
    const distance = line.baseline - previous.baseline;
    if (distance <= line.fontSize * 0.8 || distance > line.fontSize * 3) continue;
    push(distances, size, distance);
  }
  // Short lines (headings, list items, paragraph ends) never define the measure.
  return { spacing: quantiles(distances, 0.5), width: quantiles(widths, 0.75) };
}

function continuesParagraph(paragraph: PdfParagraph, line: PdfLine, metrics: LineMetrics): boolean {
  const previous = paragraph.lines[paragraph.lines.length - 1];
  const size = paragraph.fontSize;
  if (Math.abs(line.fontSize - size) > Math.max(size * 0.12, 0.6)) return false;
  const distance = line.baseline - previous.baseline;
  // Moving up starts another column or region; only an unfinished sentence continues there.
  if (distance <= size * 0.5)
    return (
      line.left >= paragraph.right - size &&
      !TERMINAL_PUNCTUATION.test(previous.text) &&
      startsContinuation(previous.text, line.text)
    );
  const leading = metrics.spacing.get(roundSize(size)) ?? size * 1.25;
  if (distance > leading * 1.3 + size * 0.1) return false;
  if (!overlapsHorizontally({ left: paragraph.left, right: paragraph.right }, line)) return false;
  if (LIST_MARKER.test(line.text)) return false;
  const first = paragraph.lines[0];
  // Wrapped list items and references hang under their marker, whatever the line length.
  if (LIST_MARKER.test(first.text) && line.left > first.left + size * 0.5) return true;
  const measure = metrics.width.get(roundSize(size)) ?? 0;
  const right = Math.max(paragraph.right, line.right, previous.left + measure);
  const previousShort = previous.right < right - size * 2.5;
  const indented = line.left > previous.left + size * 0.8;
  // First-line indents follow a short closing line; hanging indents follow a full line.
  if (indented && previousShort) return false;
  if (previousShort && TERMINAL_PUNCTUATION.test(previous.text)) return false;
  return true;
}

/** A lowercase word, or ideographs after an unpunctuated ideograph, continues a sentence. */
function startsContinuation(previous: string, next: string): boolean {
  if (/^\p{Ll}/u.test(next)) return true;
  return CJK_IDEOGRAPH.test(previous.slice(-1)) && CJK_IDEOGRAPH.test(next.charAt(0));
}

/**
 * Page breaks split paragraphs too. The reader moves such a continuation onto the previous
 * page's last paragraph so the translator receives whole sentences.
 */
export function continuesAcrossPages(previous: PdfTextBlock, next: PdfTextBlock): boolean {
  return (
    previous.kind === 'paragraph' &&
    next.kind === 'paragraph' &&
    Math.abs(previous.fontSize - next.fontSize) <= Math.max(previous.fontSize * 0.12, 0.6) &&
    !TERMINAL_PUNCTUATION.test(previous.text) &&
    startsContinuation(previous.text, next.text)
  );
}

/** Page numbers and running headers/footers sit between a paragraph and its continuation. */
export function isPageFurniture(
  block: PdfTextBlock,
  pageHeight: number,
  bodyFontSize: number | undefined,
): boolean {
  if (/^[\s\d\-–—.|/()]+$/u.test(block.text) || /^[ivxlcdm]{1,6}$/iu.test(block.text)) return true;
  const margin = pageHeight * 0.07;
  const inMargin = block.bottom <= margin || block.top >= pageHeight - margin;
  return (
    inMargin &&
    block.bottom - block.top < block.fontSize * 2 &&
    (bodyFontSize === undefined || block.fontSize < bodyFontSize * 0.98)
  );
}

/**
 * Index of the block on a new page that continues `previous`, or -1. Furniture is skipped, and a
 * page is never emptied: its only body block stays where the reader expects it.
 */
export function findPageContinuation(
  previous: PdfTextBlock | undefined,
  blocks: readonly PdfTextBlock[],
  pageHeight: number,
  bodyFontSize: number | undefined,
): number {
  if (!previous) return -1;
  const body = blocks
    .map((block, index) => ({ block, index }))
    .filter(({ block }) => !isPageFurniture(block, pageHeight, bodyFontSize));
  if (body.length < 2 || !continuesAcrossPages(previous, body[0].block)) return -1;
  return body[0].index;
}

export function joinPdfText(first: string, second: string): string {
  return joinLines([{ text: first }, { text: second }]);
}

function push(map: Map<number, number[]>, key: number, value: number): void {
  const values = map.get(key) ?? [];
  values.push(value);
  map.set(key, values);
}

function quantiles(samples: ReadonlyMap<number, number[]>, ratio: number): Map<number, number> {
  const result = new Map<number, number>();
  for (const [size, values] of samples) {
    values.sort((left, right) => left - right);
    result.set(size, values[Math.floor((values.length - 1) * ratio)]);
  }
  return result;
}

function overlapsHorizontally(
  first: { left: number; right: number },
  second: { left: number; right: number },
): boolean {
  const overlap = Math.min(first.right, second.right) - Math.max(first.left, second.left);
  return overlap > Math.min(first.right - first.left, second.right - second.left) * 0.3;
}

function joinLines(lines: readonly Pick<PdfLine, 'text'>[]): string {
  let text = '';
  for (const line of lines) {
    if (!text) {
      text = line.text;
      continue;
    }
    const last = text.slice(-1);
    const first = line.text.charAt(0);
    if (/[\p{L}]-$/u.test(text) && /^\p{Ll}/u.test(line.text)) {
      // Soft hyphenation splits a word at the line end; rejoin it.
      text = text.slice(0, -1) + line.text;
    } else if (/[\p{L}]-$/u.test(text) && /^\p{L}/u.test(line.text)) {
      // A compound such as "Trace-Monkey" keeps its hyphen but never gains a space.
      text += line.text;
    } else if (CJK_PATTERN.test(last) && CJK_PATTERN.test(first)) {
      text += line.text;
    } else {
      text += ` ${line.text}`;
    }
  }
  return text.replace(/\s+/gu, ' ').trim();
}

function pickDominant(sizes: ReadonlyMap<number, number>): number | undefined {
  let best: number | undefined;
  let count = -1;
  for (const [size, characters] of sizes) {
    if (characters > count || (characters === count && best !== undefined && size < best)) {
      best = size;
      count = characters;
    }
  }
  return best;
}

function roundSize(size: number): number {
  return Math.round(size * 2) / 2;
}

function toMatrix(value: unknown): Matrix | undefined {
  if (!Array.isArray(value) || value.length < 6) return undefined;
  const numbers = value.slice(0, 6) as unknown[];
  if (!numbers.every((entry) => typeof entry === 'number' && Number.isFinite(entry)))
    return undefined;
  return numbers as unknown as Matrix;
}

/** Same composition as pdf.js Util.transform: apply `second`, then `first`. */
function multiply(first: Matrix, second: Matrix): Matrix {
  return [
    first[0] * second[0] + first[2] * second[1],
    first[1] * second[0] + first[3] * second[1],
    first[0] * second[2] + first[2] * second[3],
    first[1] * second[2] + first[3] * second[3],
    first[0] * second[4] + first[2] * second[5] + first[4],
    first[1] * second[4] + first[3] * second[5] + first[5],
  ];
}
