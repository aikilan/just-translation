import { PROTECTED_MARKER_PATTERN } from './protected-markers';

export interface TranslationUnit {
  id: string;
  text: string;
}

export interface TranslationSegment {
  requestId: string;
  unitId: string;
  partIndex: number;
  text: string;
}

export interface BatchLimits {
  maxCharacters: number;
  maxItems: number;
}

export interface PreparedTranslation {
  segments: TranslationSegment[];
  batches: TranslationSegment[][];
}

/** Splits paragraphs before batching so a single large DOM block cannot overflow the request. */
export function createTranslationBatches(
  units: TranslationUnit[],
  limits: BatchLimits,
): PreparedTranslation {
  assertLimits(limits);
  const seenIds = new Set<string>();
  const segments: TranslationSegment[] = [];

  for (const unit of units) {
    if (seenIds.has(unit.id)) {
      throw new Error(`Duplicate translation unit id: ${unit.id}`);
    }
    seenIds.add(unit.id);

    splitText(unit.text, limits.maxCharacters).forEach((text, partIndex) => {
      segments.push({
        requestId: `${unit.id}:${partIndex}`,
        unitId: unit.id,
        partIndex,
        text,
      });
    });
  }

  const batches: TranslationSegment[][] = [];
  let currentBatch: TranslationSegment[] = [];
  let currentCharacters = 0;

  for (const segment of segments) {
    const wouldOverflow =
      currentBatch.length >= limits.maxItems ||
      currentCharacters + segment.text.length > limits.maxCharacters;
    if (wouldOverflow && currentBatch.length > 0) {
      batches.push(currentBatch);
      currentBatch = [];
      currentCharacters = 0;
    }
    currentBatch.push(segment);
    currentCharacters += segment.text.length;
  }
  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return { segments, batches };
}

export function mergeTranslatedSegments(
  segments: TranslationSegment[],
  translations: Record<string, string>,
): Map<string, string> {
  const result = new Map<string, string>();
  for (const segment of segments) {
    const translatedText = translations[segment.requestId];
    if (typeof translatedText !== 'string') {
      throw new Error(`Missing translated segment: ${segment.requestId}`);
    }
    result.set(segment.unitId, `${result.get(segment.unitId) ?? ''}${translatedText}`);
  }
  return result;
}

function splitText(text: string, maxCharacters: number): string[] {
  if (text.length <= maxCharacters) return [text];

  const sentences = text.match(/[^.!?。！？]+[.!?。！？]+|[^.!?。！？]+$/gu) ?? [text];
  const chunks: string[] = [];
  let cursor = 0;

  for (const sentence of sentences) {
    const sentenceStart = text.indexOf(sentence, cursor);
    const prefix = text.slice(cursor, sentenceStart);
    const completeSentence = `${prefix}${sentence}`;
    appendWithinLimit(chunks, completeSentence, maxCharacters);
    cursor = sentenceStart + sentence.length;
  }
  if (cursor < text.length) {
    appendWithinLimit(chunks, text.slice(cursor), maxCharacters);
  }
  return chunks;
}

function appendWithinLimit(chunks: string[], value: string, maxCharacters: number): void {
  let remaining = value;
  const lastIndex = chunks.length - 1;
  if (lastIndex >= 0 && chunks[lastIndex].length + remaining.length <= maxCharacters) {
    chunks[lastIndex] += remaining;
    return;
  }

  while (remaining.length > maxCharacters) {
    const cutIndex = getUnicodeSafeCutIndex(remaining, maxCharacters);
    chunks.push(remaining.slice(0, cutIndex));
    remaining = remaining.slice(cutIndex);
  }
  if (remaining) chunks.push(remaining);
}

/** Keeps a UTF-16 surrogate pair in one request segment. */
function getUnicodeSafeCutIndex(value: string, maximumCodeUnits: number): number {
  let cutIndex = Math.min(maximumCodeUnits, value.length);
  for (const marker of value.matchAll(PROTECTED_MARKER_PATTERN)) {
    if (marker.index < cutIndex && marker.index + marker[0].length > cutIndex) {
      if (marker.index === 0) throw new Error('批次长度不足以容纳原样保留标记');
      cutIndex = marker.index;
      break;
    }
  }
  const previousCodeUnit = value.charCodeAt(cutIndex - 1);
  const nextCodeUnit = value.charCodeAt(cutIndex);
  const splitsSurrogatePair =
    previousCodeUnit >= 0xd800 &&
    previousCodeUnit <= 0xdbff &&
    nextCodeUnit >= 0xdc00 &&
    nextCodeUnit <= 0xdfff;
  if (splitsSurrogatePair) cutIndex -= 1;
  return Math.max(1, cutIndex);
}

function assertLimits(limits: BatchLimits): void {
  if (!Number.isInteger(limits.maxCharacters) || limits.maxCharacters < 1) {
    throw new Error('maxCharacters must be a positive integer');
  }
  if (!Number.isInteger(limits.maxItems) || limits.maxItems < 1) {
    throw new Error('maxItems must be a positive integer');
  }
}
