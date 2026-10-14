import { describe, expect, it } from 'vitest';
import {
  buildPdfTextBlocks,
  continuesAcrossPages,
  dominantFontSize,
  findPageContinuation,
  isPageFurniture,
  joinPdfText,
  toPdfTextRuns,
  type PdfTextBlock,
  type PdfTextRun,
} from './text-layout';

function run(
  text: string,
  x: number,
  baseline: number,
  options: Partial<Pick<PdfTextRun, 'fontSize' | 'width' | 'hasEOL'>> = {},
): PdfTextRun {
  const fontSize = options.fontSize ?? 10;
  return {
    text,
    x,
    baseline,
    fontSize,
    width: options.width ?? text.length * fontSize * 0.5,
    hasEOL: options.hasEOL ?? true,
  };
}

/** Lines of a column at a fixed leading; every line ends with hasEOL like pdf.js output. */
function column(lines: string[], x: number, firstBaseline: number, leading = 12): PdfTextRun[] {
  return lines.map((text, index) => run(text, x, firstBaseline + index * leading));
}

const texts = (runs: PdfTextRun[]) => buildPdfTextBlocks(runs).map((block) => block.text);

describe('PDF reading blocks', () => {
  it('joins wrapped lines, rejoins hyphenated words and splits on paragraph spacing', () => {
    const runs = [
      ...column(
        [
          'Translation keeps the reading flow of a long para-',
          'graph intact while its lines wrap at the column edge',
          'of the printed page here.',
        ],
        72,
        100,
      ),
      ...column(['A second paragraph follows after a visible gap.'], 72, 148),
    ];
    expect(texts(runs)).toEqual([
      'Translation keeps the reading flow of a long paragraph intact while its lines wrap at the column edge of the printed page here.',
      'A second paragraph follows after a visible gap.',
    ]);
  });

  it('detects larger short lines as headings', () => {
    const runs = [
      run('1 Introduction', 72, 80, { fontSize: 14 }),
      ...column(
        ['Body text explains the problem in a few', 'sentences that wrap onto a second line.'],
        72,
        104,
      ),
    ];
    const blocks = buildPdfTextBlocks(runs);
    expect(blocks.map((block) => block.kind)).toEqual(['heading', 'paragraph']);
    expect(blocks[0]).toMatchObject({ text: '1 Introduction', fontSize: 14 });
  });

  it('keeps content-stream column order and never merges across columns', () => {
    const left = column(
      ['Left column first line of text that is', 'continued on the next line of the column.'],
      50,
      100,
    );
    const right = column(
      ['Right column starts at the top again', 'and continues to the bottom edge.'],
      320,
      100,
    );
    expect(texts([...left, ...right])).toEqual([
      'Left column first line of text that is continued on the next line of the column.',
      'Right column starts at the top again and continues to the bottom edge.',
    ]);
  });

  it('separates side-by-side cells that share a baseline', () => {
    const runs = [
      run('Model', 50, 100, { hasEOL: false, width: 30 }),
      run('Accuracy', 200, 100, { width: 40 }),
    ];
    expect(texts(runs)).toEqual(['Model', 'Accuracy']);
  });

  it('keeps superscripts and explicit spaces on the same line', () => {
    const runs = [
      run('Energy equals mass', 72, 100, { hasEOL: false, width: 90 }),
      run(' ', 162, 100, { hasEOL: false, width: 3 }),
      run('c', 165, 100, { hasEOL: false, width: 5 }),
      run('2', 170, 96, { fontSize: 6, hasEOL: false, width: 3 }),
      run(' in physics.', 173, 100, { width: 55 }),
    ];
    const blocks = buildPdfTextBlocks(runs);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      text: 'Energy equals mass c2 in physics.',
      fontSize: 10,
    });
  });

  it('starts a paragraph at a first-line indent after a short closing line', () => {
    const runs = [
      run('The first paragraph is long enough to fill the', 72, 100, { width: 240 }),
      run('line and then ends early.', 72, 112, { width: 120 }),
      run('An indented line starts the next paragraph and', 92, 124, { width: 220 }),
      run('continues at the left margin of the text block.', 72, 136, { width: 240 }),
    ];
    expect(texts(runs)).toEqual([
      'The first paragraph is long enough to fill the line and then ends early.',
      'An indented line starts the next paragraph and continues at the left margin of the text block.',
    ]);
  });

  it('keeps hanging-indent references together and splits list items', () => {
    const runs = [
      run('[1] A. Author and B. Writer. A study of bilingual', 72, 100, { width: 240 }),
      run('reading interfaces. Journal, 2024.', 90, 112, { width: 160 }),
      run('[2] C. Reader. Another reference entry.', 72, 124, { width: 190 }),
      run('• First bullet item', 72, 136, { width: 100 }),
      run('• Second bullet item', 72, 148, { width: 100 }),
    ];
    expect(texts(runs)).toEqual([
      '[1] A. Author and B. Writer. A study of bilingual reading interfaces. Journal, 2024.',
      '[2] C. Reader. Another reference entry.',
      '• First bullet item',
      '• Second bullet item',
    ]);
  });

  it('joins CJK lines without inserting spaces', () => {
    const runs = column(
      ['这是一个很长的中文段落，它在页面', '边缘换行后仍然属于同一段。'],
      72,
      100,
    );
    expect(texts(runs)).toEqual(['这是一个很长的中文段落，它在页面边缘换行后仍然属于同一段。']);
  });

  it('adapts paragraph breaks to double-spaced documents', () => {
    const runs = [
      ...column(
        ['Double spaced manuscripts use a', 'wide leading between their lines'],
        72,
        100,
        24,
      ),
      ...column(['Another paragraph starts after', 'extra space between blocks.'], 72, 172, 24),
    ];
    expect(texts(runs)).toEqual([
      'Double spaced manuscripts use a wide leading between their lines',
      'Another paragraph starts after extra space between blocks.',
    ]);
  });

  it('continues an unfinished sentence at the top of the next column', () => {
    const left = column(
      ['A paragraph fills the bottom of the left', 'column and its sentence continues in'],
      50,
      700,
    );
    const right = column(
      ['the right column at the top.', 'A new paragraph starts here.'],
      320,
      100,
    );
    right[1] = { ...right[1], baseline: 130 };
    expect(texts([...left, ...right])).toEqual([
      'A paragraph fills the bottom of the left column and its sentence continues in the right column at the top.',
      'A new paragraph starts here.',
    ]);
  });

  it('splits short sentences of an unmarked list against the column measure', () => {
    const full = 'A full width line of body text reaching the right edge of the column.';
    const runs = [
      ...column([full.replace('.', ','), full.replace('.', ','), full], 72, 100),
      run('We list three goals:', 72, 148),
      run('Keep the original page visible.', 90, 160),
      run('Never overlap translated text.', 90, 172),
    ];
    expect(texts(runs)).toEqual([
      `${full.replace('.', ',')} ${full.replace('.', ',')} ${full}`,
      'We list three goals:',
      'Keep the original page visible.',
      'Never overlap translated text.',
    ]);
  });

  it('weights the body font size by characters', () => {
    expect(
      dominantFontSize([
        run('Title', 0, 0, { fontSize: 18 }),
        run('Much longer body text line', 0, 20),
        run('Another body text line', 0, 32),
      ]),
    ).toBe(10);
    expect(dominantFontSize([])).toBeUndefined();
  });
});

describe('pdf.js text item conversion', () => {
  // Scale 1 viewport for a 600pt high page: y axis flips to a top-left origin.
  const viewport = [1, 0, 0, -1, 0, 600];

  it('maps baselines to top-left coordinates and skips rotated or marked-content entries', () => {
    const runs = toPdfTextRuns(
      [
        { str: 'Upright', transform: [12, 0, 0, 12, 72, 500], width: 40, hasEOL: true },
        { type: 'beginMarkedContent' } as never,
        { str: 'arXiv:2401.00001', transform: [0, 10, -10, 0, 20, 300], width: 90 },
        { str: 'Bad', transform: [1, 2, 3], width: 10 },
      ],
      viewport,
    );
    expect(runs).toEqual([
      { text: 'Upright', x: 72, baseline: 100, width: 40, fontSize: 12, hasEOL: true },
    ]);
  });

  it('applies the viewport scale to positions, sizes and widths', () => {
    const [scaled] = toPdfTextRuns(
      [{ str: 'Scaled', transform: [10, 0, 0, 10, 50, 500], width: 30, hasEOL: false }],
      [2, 0, 0, -2, 0, 1200],
    );
    expect(scaled).toEqual({
      text: 'Scaled',
      x: 100,
      baseline: 200,
      width: 60,
      fontSize: 20,
      hasEOL: false,
    });
  });
});

describe('page breaks', () => {
  const block = (text: string, patch: Partial<PdfTextBlock> = {}): PdfTextBlock => ({
    kind: 'paragraph',
    text,
    fontSize: 10,
    left: 72,
    top: 100,
    right: 500,
    bottom: 140,
    ...patch,
  });

  it('recognizes an unfinished sentence continued on the next page', () => {
    expect(continuesAcrossPages(block('The method is'), block('described below.'))).toBe(true);
    expect(continuesAcrossPages(block('The method ends.'), block('described below.'))).toBe(false);
    expect(continuesAcrossPages(block('The method is'), block('Results follow.'))).toBe(false);
    expect(continuesAcrossPages(block('排版会把这句话'), block('拆到下一页。'))).toBe(true);
    expect(
      continuesAcrossPages(block('The method is'), block('described', { kind: 'heading' })),
    ).toBe(false);
  });

  it('skips page numbers and running headers but never empties the next page', () => {
    const header = block('Journal of Examples', { top: 20, bottom: 30, fontSize: 8 });
    const next = [header, block('continued text.'), block('Another paragraph.')];
    expect(isPageFurniture(block('12'), 800, 10)).toBe(true);
    expect(isPageFurniture(header, 800, 10)).toBe(true);
    expect(isPageFurniture(block('Body text', { top: 20, bottom: 30 }), 800, 10)).toBe(false);
    expect(findPageContinuation(block('The text'), next, 800, 10)).toBe(1);
    expect(findPageContinuation(block('The text'), next.slice(0, 2), 800, 10)).toBe(-1);
    expect(findPageContinuation(undefined, next, 800, 10)).toBe(-1);
  });

  it('joins continued text with the same rules as wrapped lines', () => {
    expect(joinPdfText('a hyphen-', 'ated word')).toBe('a hyphenated word');
    expect(joinPdfText('第一页', '第二页')).toBe('第一页第二页');
    expect(joinPdfText('first', 'second')).toBe('first second');
    expect(joinPdfText('called Trace-', 'Monkey')).toBe('called Trace-Monkey');
  });
});
