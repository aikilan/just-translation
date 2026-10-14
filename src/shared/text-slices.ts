/**
 * Splits free text into independently translatable slices and puts translations back into the
 * original layout. Paragraphs (blank-line separated) stay whole when they fit; longer ones are
 * cut between sentences or lines, and only a single overlong sentence is cut mid-text. All
 * whitespace between slices is kept verbatim, so line breaks survive translation exactly.
 */

export interface TextSlice {
  id: string;
  text: string;
}

export type TextLayoutPart = { slice: number } | { raw: string };

export interface SlicedText {
  slices: TextSlice[];
  parts: TextLayoutPart[];
}

/** Fits one free-channel request and leaves AI batches room to combine short slices. */
export const TEXT_SLICE_MAX_CHARACTERS = 1_000;

const PARAGRAPH_BREAK = /(\n[^\S\n]*\n\s*)/u;
const SENTENCE_END = /[.!?。！？;；…]/u;
const CLOSING = /["'”’)）\]】」』]/u;

export function sliceText(text: string, maxCharacters = TEXT_SLICE_MAX_CHARACTERS): SlicedText {
  const slices: TextSlice[] = [];
  const parts: TextLayoutPart[] = [];
  const raw = (value: string) => {
    if (!value) return;
    const last = parts[parts.length - 1];
    if (last && 'raw' in last) last.raw += value;
    else parts.push({ raw: value });
  };
  const add = (chunk: string) => {
    const leading = chunk.match(/^\s*/u)![0];
    const trailing = chunk.slice(leading.length).match(/\s*$/u)![0];
    const core = chunk.slice(leading.length, chunk.length - trailing.length);
    raw(leading);
    if (core) {
      parts.push({ slice: slices.length });
      slices.push({ id: `s${slices.length}`, text: core });
    }
    raw(trailing);
  };
  for (const [index, segment] of text.split(PARAGRAPH_BREAK).entries()) {
    // split() with a capture group alternates content and separators.
    if (index % 2 === 1) raw(segment);
    else for (const chunk of chunkParagraph(segment, maxCharacters)) add(chunk);
  }
  return { slices, parts };
}

/** Rebuilds the text; a slice without a translation keeps its original wording. */
export function joinSlices(
  sliced: SlicedText,
  translationOf: (slice: TextSlice) => string | undefined,
): string {
  return sliced.parts
    .map((part) => {
      if ('raw' in part) return part.raw;
      const slice = sliced.slices[part.slice];
      return translationOf(slice) ?? slice.text;
    })
    .join('');
}

/** Chunks concatenate back to the paragraph exactly; each fits `maxCharacters` once trimmed. */
function chunkParagraph(paragraph: string, maxCharacters: number): string[] {
  if (paragraph.trim().length <= maxCharacters) return [paragraph];
  const chunks: string[] = [];
  let current = '';
  for (const piece of splitSentences(paragraph)) {
    if (current && (current + piece).trim().length > maxCharacters) {
      chunks.push(current);
      current = '';
    }
    if (piece.trim().length <= maxCharacters) {
      current += piece;
      continue;
    }
    for (const cut of cutLongText(piece, maxCharacters)) {
      if (current) chunks.push(current);
      current = cut;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/** Sentences keep their trailing whitespace; a line break also ends a piece. */
function splitSentences(text: string): string[] {
  const pieces: string[] = [];
  let start = 0;
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    let end = -1;
    if (character === '\n') end = index + 1;
    else if (SENTENCE_END.test(character)) {
      end = index + 1;
      while (end < text.length && (SENTENCE_END.test(text[end]) || CLOSING.test(text[end])))
        end += 1;
      // "3.5" or "e.g.x" are not sentence ends; CJK punctuation needs no following space.
      if (end < text.length && !/\s/u.test(text[end]) && !/[。！？；…]/u.test(character)) end = -1;
    }
    if (end < 0) {
      index += 1;
      continue;
    }
    while (end < text.length && /[^\S\n]/u.test(text[end])) end += 1;
    pieces.push(text.slice(start, end));
    start = end;
    index = end;
  }
  if (start < text.length) pieces.push(text.slice(start));
  return pieces;
}

/** Last resort for one overlong sentence: prefer a space, never split a surrogate pair. */
function cutLongText(text: string, maxCharacters: number): string[] {
  const cuts: string[] = [];
  let remaining = text;
  while (remaining.trim().length > maxCharacters) {
    const leading = remaining.match(/^\s*/u)![0].length;
    let cut = leading + maxCharacters;
    const space = remaining.lastIndexOf(' ', cut);
    if (space > leading + maxCharacters / 2) cut = space + 1;
    const code = remaining.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    cuts.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (remaining) cuts.push(remaining);
  return cuts;
}
