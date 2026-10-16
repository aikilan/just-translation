import type { CaptionTrack } from './captions';

/** The unit that is translated and shown: one sentence (or a bounded run of speech). */
export interface SubtitleSentence {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
}

interface Limits {
  /** A pause at least this long starts a new sentence. */
  pauseMs: number;
  maxDurationMs: number;
  maxCharacters: number;
}

// Hand-made captions are already lines of speech; recognized speech arrives word by word.
const MANUAL_LIMITS: Limits = { pauseMs: 1_500, maxDurationMs: 10_000, maxCharacters: 220 };
const AUTOMATIC_LIMITS: Limits = { pauseMs: 1_000, maxDurationMs: 6_000, maxCharacters: 120 };
/** Keep a finished line readable briefly, without overlapping the next one. */
const LINGER_MS = 800;
const MIN_DISPLAY_MS = 600;

const SENTENCE_END = /[.!?。！？…؟]["'”’)）\]】」』]*$/u;
const CJK = /[぀-ヿ㐀-鿿가-힯豈-﫿]/u;

/** Merges caption pieces into sentences by punctuation, pauses and length. */
export function buildSentences(track: CaptionTrack): SubtitleSentence[] {
  const limits = track.automatic ? AUTOMATIC_LIMITS : MANUAL_LIMITS;
  const groups: { startMs: number; endMs: number; text: string; lastStartMs: number }[] = [];
  let current: (typeof groups)[number] | undefined;
  for (const cue of track.cues) {
    const piece = cue.text.trim();
    if (!piece) continue;
    if (current) {
      const paused = cue.startMs - (track.automatic ? current.lastStartMs : current.endMs);
      const text = joinText(current.text, piece);
      if (
        SENTENCE_END.test(current.text) ||
        paused >= limits.pauseMs ||
        cue.endMs - current.startMs > limits.maxDurationMs ||
        countCharacters(text) > limits.maxCharacters
      ) {
        groups.push(current);
        current = undefined;
      } else {
        current.text = text;
        current.endMs = Math.max(current.endMs, cue.endMs);
        current.lastStartMs = cue.startMs;
        continue;
      }
    }
    current = { startMs: cue.startMs, endMs: cue.endMs, text: piece, lastStartMs: cue.startMs };
  }
  if (current) groups.push(current);
  return groups.map((group, index) => {
    const next = groups[index + 1]?.startMs ?? Number.POSITIVE_INFINITY;
    const end = Math.min(Math.max(group.endMs + LINGER_MS, group.startMs + MIN_DISPLAY_MS), next);
    return {
      id: `s${index}`,
      startMs: group.startMs,
      endMs: Math.max(end, group.startMs + 1),
      text: group.text,
    };
  });
}

/** The sentence on screen at a playback position, by binary search; undefined between lines. */
export function findSentenceAt(
  sentences: readonly SubtitleSentence[],
  positionMs: number,
): SubtitleSentence | undefined {
  let low = 0;
  let high = sentences.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const sentence = sentences[middle];
    if (positionMs < sentence.startMs) high = middle - 1;
    else if (positionMs >= sentence.endMs) low = middle + 1;
    else return sentence;
  }
  return undefined;
}

function joinText(left: string, right: string): string {
  // CJK scripts are written without spaces between words.
  if (CJK.test(left.at(-1) ?? '') && CJK.test(right[0] ?? '')) return left + right;
  return `${left} ${right}`;
}

/** CJK characters carry about two Latin characters of reading load. */
function countCharacters(text: string): number {
  let count = 0;
  for (const character of text) count += CJK.test(character) ? 2 : 1;
  return count;
}
