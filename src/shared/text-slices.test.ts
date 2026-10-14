import { describe, expect, it } from 'vitest';
import { joinSlices, sliceText } from './text-slices';

const texts = (value: string, max?: number) => sliceText(value, max).slices.map((s) => s.text);
const identity = (value: string, max?: number) => {
  const sliced = sliceText(value, max);
  return joinSlices(sliced, (slice) => slice.text);
};

describe('text slices', () => {
  it('keeps short paragraphs whole and preserves every separator', () => {
    const source =
      '  First paragraph\nwith a wrapped line.\n\n\tSecond paragraph.  \n \n\nThird.\n';
    expect(texts(source)).toEqual([
      'First paragraph\nwith a wrapped line.',
      'Second paragraph.',
      'Third.',
    ]);
    expect(identity(source)).toBe(source);
    const sliced = sliceText(source);
    expect(
      joinSlices(sliced, (slice) => (slice.id === 's1' ? '第二段。' : `<${slice.text}>`)),
    ).toBe('  <First paragraph\nwith a wrapped line.>\n\n\t第二段。  \n \n\n<Third.>\n');
  });

  it('cuts long paragraphs between sentences within the limit', () => {
    const sentence = (n: number) => `Sentence number ${n} has some words.`;
    const paragraph = Array.from({ length: 10 }, (_, n) => sentence(n)).join(' ');
    const slices = texts(paragraph, 80);
    expect(slices.every((slice) => slice.length <= 80)).toBe(true);
    expect(slices[0]).toBe(`${sentence(0)} ${sentence(1)}`);
    expect(identity(paragraph, 80)).toBe(paragraph);
  });

  it('treats line breaks and CJK punctuation as cut points without inventing spaces', () => {
    const chinese = '第一句话很长。第二句话也很长！第三句话结束？'.repeat(4);
    const slices = texts(chinese, 30);
    expect(slices.every((slice) => slice.length <= 30)).toBe(true);
    expect(slices.join('')).toBe(chinese);
    const lines = 'line one is here\nline two is here\nline three is here';
    expect(texts(lines, 20)).toEqual([
      'line one is here',
      'line two is here',
      'line three is here',
    ]);
    expect(identity(lines, 20)).toBe(lines);
  });

  it('does not end sentences inside numbers or abbreviations', () => {
    expect(texts('Version 3.5 is out. It is fast.', 20)).toEqual([
      'Version 3.5 is out.',
      'It is fast.',
    ]);
  });

  it('cuts an overlong sentence at a space and keeps surrogate pairs intact', () => {
    const words = 'word '.repeat(30).trim();
    const slices = texts(words, 32);
    expect(slices.every((slice) => slice.length <= 32)).toBe(true);
    expect(slices.every((slice) => !slice.startsWith('ord'))).toBe(true);
    expect(identity(words, 32)).toBe(words);
    const emoji = '😀'.repeat(10);
    const pieces = texts(emoji, 5);
    expect(pieces.every((piece) => !/^[\udc00-\udfff]|[\ud800-\udbff]$/u.test(piece))).toBe(true);
    expect(pieces.join('')).toBe(emoji);
  });

  it('returns no slices for blank input and numbers slices in reading order', () => {
    expect(sliceText(' \n\n ').slices).toEqual([]);
    expect(sliceText('A.\n\nB.').slices).toEqual([
      { id: 's0', text: 'A.' },
      { id: 's1', text: 'B.' },
    ]);
  });
});
