import { describe, expect, it } from 'vitest';

import {
  createTranslationBatches,
  mergeTranslatedSegments,
  type TranslationUnit,
} from './batching';

describe('createTranslationBatches', () => {
  it('keeps protected markers whole at a long-paragraph boundary', () => {
    const text = `${'a'.repeat(15)}[[JT_KEEP_0]] remaining text.`;
    const { segments } = createTranslationBatches([{ id: 'protected', text }], {
      maxCharacters: 20,
      maxItems: 4,
    });
    expect(segments.map((segment) => segment.text).join('')).toBe(text);
    expect(segments.filter((segment) => segment.text.includes('[[JT_KEEP_0]]'))).toHaveLength(1);
    expect(segments.every((segment) => segment.text.length <= 20)).toBe(true);
  });
  it('splits long units, preserves order, and respects batch limits', () => {
    const units: TranslationUnit[] = [
      { id: 'a', text: 'First sentence. Second sentence. Third sentence.' },
      { id: 'b', text: 'Short text.' },
    ];

    const result = createTranslationBatches(units, {
      maxCharacters: 24,
      maxItems: 2,
    });

    expect(result.segments.map((segment) => segment.unitId)).toEqual(['a', 'a', 'a', 'b']);
    expect(result.batches.every((batch) => batch.length <= 2)).toBe(true);
    expect(
      result.batches.every(
        (batch) => batch.reduce((total, item) => total + item.text.length, 0) <= 24,
      ),
    ).toBe(true);
    expect(result.segments.map((segment) => segment.text).join('')).toBe(
      `${units[0].text}${units[1].text}`,
    );
  });

  it('rejects duplicate unit identifiers', () => {
    expect(() =>
      createTranslationBatches(
        [
          { id: 'same', text: 'A' },
          { id: 'same', text: 'B' },
        ],
        { maxCharacters: 100, maxItems: 10 },
      ),
    ).toThrow(/duplicate/i);
  });

  it('never cuts a Unicode surrogate pair between request segments', () => {
    const text = `${'a'.repeat(199)}😀z`;
    const result = createTranslationBatches([{ id: 'unicode', text }], {
      maxCharacters: 200,
      maxItems: 20,
    });

    expect(result.segments.map((segment) => segment.text).join('')).toBe(text);
    for (const segment of result.segments) {
      const firstCodeUnit = segment.text.charCodeAt(0);
      const lastCodeUnit = segment.text.charCodeAt(segment.text.length - 1);
      expect(firstCodeUnit >= 0xdc00 && firstCodeUnit <= 0xdfff).toBe(false);
      expect(lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff).toBe(false);
    }
  });
});

describe('mergeTranslatedSegments', () => {
  it('reassembles translated chunks into their original units', () => {
    const units: TranslationUnit[] = [
      { id: 'a', text: 'One. Two.' },
      { id: 'b', text: 'Three.' },
    ];
    const prepared = createTranslationBatches(units, {
      maxCharacters: 5,
      maxItems: 2,
    });
    const translations = Object.fromEntries(
      prepared.segments.map((segment) => [segment.requestId, `[${segment.text}]`]),
    );

    expect(mergeTranslatedSegments(prepared.segments, translations)).toEqual(
      new Map([
        ['a', '[One.][ Two.]'],
        ['b', '[Three][.]'],
      ]),
    );
  });

  it('fails when the provider omits a segment', () => {
    const prepared = createTranslationBatches([{ id: 'a', text: 'Translate me.' }], {
      maxCharacters: 100,
      maxItems: 10,
    });

    expect(() => mergeTranslatedSegments(prepared.segments, {})).toThrow(/missing/i);
  });
});
