// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PdfReader,
  type PdfDocumentLike,
  type PdfLoadingTaskLike,
  type PdfPageLike,
  type PdfReaderState,
} from './pdf-reader';

const HEIGHT = 800;

/** A pdf.js-shaped text item at a top-left position, as the viewport will report it. */
function item(text: string, x: number, top: number, size = 10) {
  return {
    str: text,
    transform: [size, 0, 0, size, x, HEIGHT - top],
    width: text.length * size * 0.5,
    hasEOL: true,
  };
}

function page(items: ReturnType<typeof item>[]): PdfPageLike {
  return {
    getViewport: ({ scale }) => ({
      width: 600 * scale,
      height: HEIGHT * scale,
      transform: [scale, 0, 0, -scale, 0, HEIGHT * scale],
    }),
    getTextContent: () => Promise.resolve({ items, lang: 'en-US' }),
    render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }),
  };
}

function task(result: Promise<PdfDocumentLike>): PdfLoadingTaskLike {
  return { promise: result, destroy: vi.fn().mockResolvedValue(undefined) };
}

function documentOf(pages: PdfPageLike[]): PdfDocumentLike {
  return {
    numPages: pages.length,
    getPage: (number) => Promise.resolve(pages[number - 1]),
    destroy: vi.fn().mockResolvedValue(undefined),
  };
}

describe('PDF reader', () => {
  let container: HTMLElement;
  let states: PdfReaderState[];
  beforeEach(() => {
    document.body.innerHTML = '<main></main>';
    container = document.querySelector('main')!;
    states = [];
  });
  const reader = (load: () => PdfLoadingTaskLike) =>
    new PdfReader(container, load, { onState: (state) => states.push(state) });

  it('builds one reading section per page and reports extraction progress', async () => {
    const pdf = documentOf([
      page([
        item('A Study of Reading', 72, 80, 16),
        item('The first page has body text.', 72, 120),
      ]),
      page([]),
    ]);
    await reader(() => task(Promise.resolve(pdf))).open({
      kind: 'url',
      url: 'https://a.test/x.pdf',
    });

    expect(states.map((state) => state.phase)).toEqual([
      'loading',
      'extracting',
      'extracting',
      'extracting',
      'ready',
    ]);
    expect(states.at(-1)).toEqual({ phase: 'ready', pageCount: 2, textPages: 1 });
    const sections = container.querySelectorAll('.pdf-page');
    expect(sections).toHaveLength(2);
    expect(container.lang).toBe('en-US');
    const first = sections[0].querySelector('.pdf-page-reading')!;
    expect(first.querySelector('h2, h3')?.textContent).toBe('A Study of Reading');
    expect(first.querySelector('p')?.textContent).toBe('The first page has body text.');
    // The rendered original is never a translation source.
    expect(sections[0].querySelector('.pdf-page-visual')?.getAttribute('translate')).toBe('no');
    const empty = sections[1].querySelector('.pdf-page-empty');
    expect(empty?.getAttribute('translate')).toBe('no');
  });

  it('joins a sentence broken by a page break and skips the page number between them', async () => {
    const pdf = documentOf([
      page([
        item('A paragraph begins on the first page and is', 72, 100),
        item('interrupted by the page break before it', 72, 112),
        item('1', 300, 780),
      ]),
      page([
        item('finishes on the following page.', 72, 60),
        item('A new paragraph follows it here.', 72, 100),
      ]),
    ]);
    await reader(() => task(Promise.resolve(pdf))).open({
      kind: 'url',
      url: 'https://a.test/x.pdf',
    });
    const [first, second] = container.querySelectorAll('.pdf-page-reading');
    expect([...first.querySelectorAll('p')].map((p) => p.textContent)).toEqual([
      'A paragraph begins on the first page and is interrupted by the page break before it finishes on the following page.',
      '1',
    ]);
    expect([...second.querySelectorAll('p')].map((p) => p.textContent)).toEqual([
      'A new paragraph follows it here.',
    ]);
  });

  it('asks for a password and passes it to pdf.js', async () => {
    let resolve!: (value: PdfDocumentLike) => void;
    const loading = task(new Promise((done) => (resolve = done)));
    const instance = reader(() => loading);
    const opened = instance.open({ kind: 'data', name: 'secret.pdf', data: new Uint8Array() });
    await vi.waitFor(() => expect(loading.onPassword).toBeTypeOf('function'));
    const update = vi.fn();
    loading.onPassword!(update, 2);
    expect(instance.getState()).toEqual({ phase: 'password', incorrect: true });
    instance.submitPassword('hunter2');
    expect(update).toHaveBeenCalledWith('hunter2');
    expect(instance.getState()).toEqual({ phase: 'loading' });
    resolve(documentOf([]));
    await opened;
    expect(instance.getState()).toEqual({ phase: 'ready', pageCount: 0, textPages: 0 });
  });

  it.each([
    [
      'https://a.test/x.pdf',
      Object.assign(new Error('Missing'), { name: 'ResponseException', status: 404 }),
      { kind: 'network', error: { key: 'PDF 下载失败（HTTP {{p0}}）', params: { p0: 404 } } },
    ],
    [
      'https://a.test/x.pdf',
      Object.assign(new Error('Invalid'), { name: 'InvalidPDFException' }),
      { kind: 'invalid', error: { key: '无法识别此 PDF 文件' } },
    ],
    ['file:///home/a.pdf', new Error('Unexpected server response (0)'), { kind: 'file-access' }],
  ])('explains why %s could not be opened', async (url, error, expected) => {
    await reader(() => task(Promise.reject(error))).open({ kind: 'url', url });
    expect(states.at(-1)).toMatchObject({ phase: 'error', ...expected });
  });

  it('discards an older document when another one is opened', async () => {
    let releaseOld!: (value: PdfDocumentLike) => void;
    const tasks = [
      task(new Promise((done) => (releaseOld = done))),
      task(Promise.resolve(documentOf([page([item('The new document.', 72, 80)])]))),
    ];
    const instance = reader(() => tasks.shift()!);
    const old = instance.open({ kind: 'url', url: 'https://a.test/old.pdf' });
    await vi.waitFor(() => expect(tasks).toHaveLength(1));
    await instance.open({ kind: 'data', name: 'new.pdf', data: new Uint8Array() });
    releaseOld(documentOf([page([item('The old document.', 72, 80)])]));
    await old;
    expect(container.textContent).toContain('The new document.');
    expect(container.textContent).not.toContain('The old document.');
    expect(instance.getState()).toEqual({ phase: 'ready', pageCount: 1, textPages: 1 });
  });
});
