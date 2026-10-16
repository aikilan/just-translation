import { isTimedTextUrl } from './caption-protocol';

/** One timed piece of caption text. Automatic tracks are split into single words. */
export interface CaptionCue {
  startMs: number;
  endMs: number;
  text: string;
}

export interface CaptionTrack {
  videoId: string;
  /** Identifies this exact track, including YouTube's own translation target, if any. */
  key: string;
  languageCode?: string;
  /** Speech recognition captions: word timings, usually no punctuation. */
  automatic: boolean;
  cues: CaptionCue[];
}

const MAX_CUES = 50_000;
const MAX_CUE_TEXT = 2_000;

/** Parses a timedtext response in the json3, srv3 or legacy XML format; undefined if unusable. */
export function parseCaptionResponse(url: string, body: string): CaptionTrack | undefined {
  if (!isTimedTextUrl(url)) return undefined;
  const parameters = new URL(url).searchParams;
  const videoId = parameters.get('v');
  if (!videoId || !/^[\w-]{6,20}$/u.test(videoId)) return undefined;
  const automatic = parameters.get('kind') === 'asr';
  const languageCode = parameters.get('tlang') || parameters.get('lang') || undefined;
  const trimmed = body.trimStart();
  let cues: CaptionCue[] | undefined;
  try {
    cues = trimmed.startsWith('{')
      ? parseJson3(JSON.parse(trimmed) as unknown, automatic)
      : trimmed.startsWith('<')
        ? parseXml(trimmed, automatic)
        : undefined;
  } catch {
    return undefined;
  }
  if (!cues?.length) return undefined;
  const key = ['v', 'lang', 'kind', 'name', 'tlang']
    .map((name) => `${name}=${parameters.get(name) ?? ''}`)
    .join('&');
  return { videoId, key, languageCode, automatic, cues: finishCues(cues, automatic) };
}

interface Json3Segment {
  utf8?: unknown;
  tOffsetMs?: unknown;
}
interface Json3Event {
  tStartMs?: unknown;
  dDurationMs?: unknown;
  segs?: unknown;
}

function parseJson3(value: unknown, automatic: boolean): CaptionCue[] {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { events?: unknown }).events))
    return [];
  const cues: CaptionCue[] = [];
  for (const event of (value as { events: Json3Event[] }).events) {
    if (!event || typeof event !== 'object' || !Array.isArray(event.segs)) continue;
    const start = readMs(event.tStartMs);
    if (start === undefined) continue;
    const end = start + (readMs(event.dDurationMs) ?? 0);
    const segments = (event.segs as Json3Segment[]).filter(
      (segment): segment is { utf8: string; tOffsetMs?: unknown } =>
        !!segment && typeof segment.utf8 === 'string',
    );
    if (automatic) {
      for (const segment of segments) {
        if (!segment.utf8.trim()) continue;
        cues.push({
          startMs: start + (readMs(segment.tOffsetMs) ?? 0),
          endMs: end,
          text: segment.utf8,
        });
      }
    } else {
      const text = segments.map((segment) => segment.utf8).join('');
      if (text.trim()) cues.push({ startMs: start, endMs: end, text });
    }
  }
  return cues;
}

function parseXml(body: string, automatic: boolean): CaptionCue[] {
  const document = new DOMParser().parseFromString(body, 'text/xml');
  if (document.querySelector('parsererror')) return [];
  const cues: CaptionCue[] = [];
  // srv3: <p t="ms" d="ms">, optionally with word spans <s t="offset ms">.
  for (const paragraph of Array.from(document.getElementsByTagName('p'))) {
    const start = readMs(Number(paragraph.getAttribute('t')));
    if (start === undefined) continue;
    const end = start + (readMs(Number(paragraph.getAttribute('d'))) ?? 0);
    const words = Array.from(paragraph.getElementsByTagName('s'));
    if (automatic && words.length) {
      for (const word of words) {
        const text = word.textContent ?? '';
        if (!text.trim()) continue;
        cues.push({
          startMs: start + (readMs(Number(word.getAttribute('t'))) ?? 0),
          endMs: end,
          text,
        });
      }
    } else {
      const text = paragraph.textContent ?? '';
      if (text.trim()) cues.push({ startMs: start, endMs: end, text });
    }
  }
  if (cues.length) return cues;
  // Legacy format 1: <text start="seconds" dur="seconds">.
  for (const element of Array.from(document.getElementsByTagName('text'))) {
    const start = readMs(Number(element.getAttribute('start')) * 1000);
    if (start === undefined) continue;
    const end = start + (readMs(Number(element.getAttribute('dur')) * 1000) ?? 0);
    const text = element.textContent ?? '';
    if (text.trim()) cues.push({ startMs: start, endMs: end, text });
  }
  return cues;
}

/** Orders cues, bounds their size and gives every word a real end: the next word's start. */
function finishCues(cues: CaptionCue[], automatic: boolean): CaptionCue[] {
  const ordered = cues
    .slice(0, MAX_CUES)
    .map((cue) => ({
      ...cue,
      text: normalizeText(cue.text).slice(0, MAX_CUE_TEXT),
      endMs: Math.max(cue.endMs, cue.startMs),
    }))
    .filter((cue) => cue.text.trim())
    .sort((left, right) => left.startMs - right.startMs);
  if (automatic) {
    for (let index = 0; index < ordered.length - 1; index += 1) {
      const next = ordered[index + 1].startMs;
      if (next > ordered[index].startMs)
        ordered[index].endMs = Math.min(ordered[index].endMs, next);
    }
  }
  return ordered;
}

function normalizeText(text: string): string {
  // Captions wrap lines for the screen; the reading unit is the whole sentence.
  return text.replace(/[\u200b\u200e\u200f]/gu, '').replace(/\s*\n\s*/gu, ' ');
}

function readMs(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}
