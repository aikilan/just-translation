// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { parseCaptionResponse } from './captions';
import { buildSentences, findSentenceAt } from './sentences';

const url = (query: string) => `https://www.youtube.com/api/timedtext?v=abcdefghijk&${query}`;

describe('YouTube caption parsing', () => {
  it('reads hand-made json3 lines and ignores line-break events', () => {
    const track = parseCaptionResponse(
      url('lang=en&fmt=json3&pot=token'),
      JSON.stringify({
        events: [
          { tStartMs: 0, dDurationMs: 1_500, segs: [{ utf8: 'Hello there,\nmy friend.' }] },
          { tStartMs: 1_500, dDurationMs: 0, aAppend: 1, segs: [{ utf8: '\n' }] },
          { tStartMs: 2_000, dDurationMs: 2_000, segs: [{ utf8: 'How are you?' }] },
          { tStartMs: 9_000 },
        ],
      }),
    );
    expect(track).toMatchObject({
      videoId: 'abcdefghijk',
      languageCode: 'en',
      automatic: false,
      cues: [
        { startMs: 0, endMs: 1_500, text: 'Hello there, my friend.' },
        { startMs: 2_000, endMs: 4_000, text: 'How are you?' },
      ],
    });
  });

  it('splits recognized speech into words that end where the next word starts', () => {
    const track = parseCaptionResponse(
      url('lang=en&kind=asr&fmt=json3'),
      JSON.stringify({
        events: [
          { tStartMs: 0, dDurationMs: 5_000, wWinId: 1 },
          {
            tStartMs: 100,
            dDurationMs: 4_000,
            segs: [
              { utf8: 'so' },
              { utf8: ' today', tOffsetMs: 300 },
              { utf8: ' we', tOffsetMs: 700 },
            ],
          },
          { tStartMs: 1_500, dDurationMs: 3_000, segs: [{ utf8: ' talk', tOffsetMs: 0 }] },
        ],
      }),
    );
    expect(track?.automatic).toBe(true);
    expect(track?.cues).toEqual([
      { startMs: 100, endMs: 400, text: 'so' },
      { startMs: 400, endMs: 800, text: ' today' },
      { startMs: 800, endMs: 1_500, text: ' we' },
      { startMs: 1_500, endMs: 4_500, text: ' talk' },
    ]);
  });

  it('reads srv3 and legacy XML and keys YouTube translations separately', () => {
    const srv3 = parseCaptionResponse(
      url('lang=en&tlang=zh-Hans&fmt=srv3'),
      '<timedtext format="3"><body><p t="1000" d="2000">Fish &amp; chips</p></body></timedtext>',
    );
    expect(srv3).toMatchObject({
      languageCode: 'zh-Hans',
      cues: [{ startMs: 1_000, endMs: 3_000, text: 'Fish & chips' }],
    });
    expect(srv3?.key).toContain('tlang=zh-Hans');
    const legacy = parseCaptionResponse(
      url('lang=de'),
      '<transcript><text start="1.5" dur="2">Guten Tag</text></transcript>',
    );
    expect(legacy?.cues).toEqual([{ startMs: 1_500, endMs: 3_500, text: 'Guten Tag' }]);
  });

  it("skips XML lines without a time and decodes the legacy format's second escaping", () => {
    const srv3 = parseCaptionResponse(
      url('lang=en&fmt=srv3'),
      '<timedtext format="3"><body><p d="900">No time</p><p t="2000" d="1000">Timed</p></body></timedtext>',
    );
    expect(srv3?.cues).toEqual([{ startMs: 2_000, endMs: 3_000, text: 'Timed' }]);
    const legacy = parseCaptionResponse(
      url('lang=en'),
      '<transcript><text dur="1">No start</text><text start="0.5" dur="1">I&amp;#39;m &amp;quot;here&amp;quot; &amp;amp; ready</text></transcript>',
    );
    expect(legacy?.cues).toEqual([{ startMs: 500, endMs: 1_500, text: 'I\'m "here" & ready' }]);
  });

  it('rejects other hosts, missing video ids and unreadable bodies', () => {
    const body = JSON.stringify({
      events: [{ tStartMs: 0, dDurationMs: 1, segs: [{ utf8: 'x' }] }],
    });
    expect(parseCaptionResponse('https://evil.example/api/timedtext?v=abcdefghijk', body)).toBe(
      undefined,
    );
    expect(parseCaptionResponse('https://www.youtube.com/api/timedtext?lang=en', body)).toBe(
      undefined,
    );
    expect(parseCaptionResponse(url('lang=en'), '{not json')).toBe(undefined);
    expect(parseCaptionResponse(url('lang=en'), JSON.stringify({ events: [] }))).toBe(undefined);
  });
});

describe('subtitle sentences', () => {
  it('joins hand-made lines until a sentence ends and keeps lines visible until the next one', () => {
    const track = parseCaptionResponse(
      url('lang=en'),
      JSON.stringify({
        events: [
          { tStartMs: 0, dDurationMs: 1_000, segs: [{ utf8: 'When we started' }] },
          { tStartMs: 1_000, dDurationMs: 1_000, segs: [{ utf8: 'nobody believed us.' }] },
          { tStartMs: 2_100, dDurationMs: 1_000, segs: [{ utf8: 'Then it worked.' }] },
          { tStartMs: 6_000, dDurationMs: 1_000, segs: [{ utf8: 'A new topic' }] },
        ],
      }),
    )!;
    const sentences = buildSentences(track);
    expect(sentences).toEqual([
      { id: 's0', startMs: 0, endMs: 2_100, text: 'When we started nobody believed us.' },
      { id: 's1', startMs: 2_100, endMs: 3_900, text: 'Then it worked.' },
      { id: 's2', startMs: 6_000, endMs: 7_800, text: 'A new topic' },
    ]);
    expect(findSentenceAt(sentences, 1_999)?.id).toBe('s0');
    expect(findSentenceAt(sentences, 3_000)?.id).toBe('s1');
    expect(findSentenceAt(sentences, 4_500)).toBe(undefined);
    expect(findSentenceAt(sentences, 6_000)?.id).toBe('s2');
  });

  it('cuts unpunctuated speech at pauses and at the length limit', () => {
    const words = (start: number, texts: string[]) =>
      texts.map((utf8, index) => ({ utf8: index ? ` ${utf8}` : utf8, tOffsetMs: index * 250 }));
    const track = parseCaptionResponse(
      url('lang=en&kind=asr'),
      JSON.stringify({
        events: [
          { tStartMs: 0, dDurationMs: 3_000, segs: words(0, ['so', 'today', 'we', 'talk']) },
          // A 1.2 s silence before the next phrase.
          { tStartMs: 1_950, dDurationMs: 3_000, segs: words(0, ['about', 'batteries']) },
          {
            tStartMs: 3_000,
            dDurationMs: 9_000,
            segs: words(
              0,
              Array.from({ length: 30 }, (_, index) => `word${index}`),
            ),
          },
        ],
      }),
    )!;
    const sentences = buildSentences(track);
    expect(sentences[0].text).toBe('so today we talk');
    expect(sentences[1].text.startsWith('about batteries')).toBe(true);
    expect(sentences.every((sentence) => sentence.text.length <= 120)).toBe(true);
    expect(sentences.length).toBeGreaterThan(2);
  });

  it('writes CJK without spaces and limits it by reading length', () => {
    const track = parseCaptionResponse(
      url('lang=ja'),
      JSON.stringify({
        events: [
          { tStartMs: 0, dDurationMs: 1_000, segs: [{ utf8: '今日は' }] },
          { tStartMs: 1_000, dDurationMs: 1_000, segs: [{ utf8: 'いい天気です。' }] },
        ],
      }),
    )!;
    expect(buildSentences(track).map((sentence) => sentence.text)).toEqual([
      '今日はいい天気です。',
    ]);
  });
});
