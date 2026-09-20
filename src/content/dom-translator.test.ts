// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  collectTranslatableElements,
  collectOriginalReadingUnits,
  discoverTranslatableElements,
  getElementSourceText,
  renderTranslationError,
  renderTranslationPending,
  renderTranslation,
  restoreDocument,
  setDocumentDisplayMode,
} from './dom-translator';

describe('DOM translation rendering', () => {
  it('discovers viewport candidates without pruning offscreen parents or claiming their text', async () => {
    document.body.innerHTML =
      '<main><section><p id="offscreen">Deferred paragraph.</p><p id="visible">Visible paragraph.</p><p id="horizontal">Horizontally clipped paragraph.</p></section></main>';
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      return {
        top: this.id === 'visible' || this.id === 'horizontal' ? 10 : -100,
        bottom: this.id === 'visible' || this.id === 'horizontal' ? 40 : -50,
        left: this.id === 'horizontal' ? 2000 : 0,
        right: this.id === 'horizontal' ? 2200 : 300,
      } as DOMRect;
    });
    try {
      const elements: HTMLElement[] = [];
      for await (const slice of discoverTranslatableElements(document.body, {
        isVisible: () => true,
        viewportOnly: true,
      }))
        elements.push(...slice);
      expect(elements.map((e) => e.id)).toEqual(['visible']);
      expect(
        collectTranslatableElements(document.body, { isVisible: () => true }).map((e) => e.id),
      ).toEqual(['offscreen', 'visible', 'horizontal']);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('rechecks original reading units while ignoring extension feedback', () => {
    document.body.innerHTML =
      '<main><p>First original paragraph.</p><p>Second original paragraph.</p></main>';
    const options = { isVisible: () => true };
    const sources = collectTranslatableElements(document.body, options);
    renderTranslationPending(sources[0], 'first');
    renderTranslation(sources[1], '第二段译文。');
    expect(collectOriginalReadingUnits(document.body, options)).toEqual(sources);
    expect(collectTranslatableElements(document.body, { isVisible: () => true })).toEqual([]);
    expect(sources.map(getElementSourceText)).toEqual([
      'First original paragraph.',
      'Second original paragraph.',
    ]);
  });

  it('inspects unanchored prose without inserting wrappers or dropping excluded metadata', () => {
    document.body.innerHTML =
      '<main>Opening raw prose.<p>A paragraph.</p>Closing raw prose.<aside>Excluded text.</aside><div>KYODO</div></main>';
    const html = document.body.innerHTML;
    const observer = new MutationObserver(() => {});
    observer.observe(document.body, { subtree: true, childList: true, attributes: true });
    const units = collectOriginalReadingUnits(document.body, { isVisible: () => true });
    expect(units).toHaveLength(3);
    expect(document.body.innerHTML).toBe(html);
    expect(observer.takeRecords()).toHaveLength(0);
    observer.disconnect();
  });

  it('re-evaluates child paragraphs inside a marked source and keeps inline wrappers transparent', () => {
    document.body.innerHTML = '<main><div>First paragraph. Second paragraph.</div></main>';
    const options = { isVisible: () => true };
    const [source] = collectTranslatableElements(document.body, options);
    renderTranslationPending(source, 'p');
    source.querySelector('[data-justranslate-source-content]')!.innerHTML =
      '<p>First paragraph. </p><p>Second paragraph.</p>';
    const html = document.body.innerHTML;
    expect(collectOriginalReadingUnits(document.body, options)).toEqual([
      ...source.querySelectorAll('p'),
    ]);
    expect(document.body.innerHTML).toBe(html);
  });

  it('does not reuse old fragment eligibility after a host data attribute changes CSS', () => {
    document.body.innerHTML =
      '<style>[data-state="hidden"] span {display:none}</style><main><p><span>Previously visible reading words.</span></p></main>';
    const options = { isVisible: () => true };
    expect(collectTranslatableElements(document.body, options)).toHaveLength(1);
    document.querySelector('p')!.dataset.state = 'hidden';
    expect(collectOriginalReadingUnits(document.body, options)).toHaveLength(0);
  });

  it('keeps surrounding prose and inline links in one reading block without duplicate descendants', () => {
    document.body.innerHTML =
      '<main><div id="sentence">Before you start, <em><a href="/docs">read the documentation</a></em> to understand all required steps.</div><div><p>A separate paragraph.</p></div></main>';
    const link = document.querySelector('a');
    const elements = collectTranslatableElements(document.body, { isVisible: () => true });
    expect(elements.map(getElementSourceText)).toEqual([
      'Before you start, read the documentation to understand all required steps.',
      'A separate paragraph.',
    ]);
    renderTranslation(elements[0], '开始之前，请阅读文档，了解所有必要步骤。');
    restoreDocument();
    expect(document.querySelector('a')).toBe(link);
    expect(collectTranslatableElements(document.body, { isVisible: () => true })).toEqual(elements);
  });

  it('does not hide standalone links beside separate block paragraphs', () => {
    document.body.innerHTML =
      '<main><div><a>Standalone article title</a><p>A different reading paragraph.</p></div></main>';
    expect(
      collectTranslatableElements(document.body, { isVisible: () => true }).map(
        getElementSourceText,
      ),
    ).toEqual(['Standalone article title', 'A different reading paragraph.']);
  });

  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('keeps prose on both sides of nested blocks without overlapping translation units', () => {
    document.body.innerHTML =
      '<main><div>Opening readable prose with <a href="/guide">a guide</a>.<p>Nested independent paragraph.</p>Closing readable prose after the block.</div></main>';
    const original = document.body.innerHTML;
    const link = document.querySelector('a');
    const elements = collectTranslatableElements(document.body, { isVisible: () => true });
    expect(elements.map(getElementSourceText)).toEqual([
      'Opening readable prose with a guide.',
      'Nested independent paragraph.',
      'Closing readable prose after the block.',
    ]);
    expect(elements.some((a) => elements.some((b) => a !== b && a.contains(b)))).toBe(false);
    for (const element of elements) renderTranslation(element, '译文');
    restoreDocument();
    expect(document.body.innerHTML).toBe(original);
    expect(document.querySelector('a')).toBe(link);
  });

  it('never chooses hidden or protected fragments as the dominant visible typography', () => {
    document.body.innerHTML =
      '<p style="font-size:16px;color:black">Visible title<span hidden style="font-size:50px;color:red">Long hidden accessible duplicate text that should not define visual appearance.</span><code style="font-size:40px">A long code snippet stays original</code></p>';
    const result = renderTranslation(document.querySelector('p')!, `可见标题 [[JT_KEEP_0]]`);
    expect(result.style.fontSize).toBe('16px');
    expect(result.style.color).toBe('rgb(0, 0, 0)');
  });

  it('invalidates source snapshots for synchronous text, style and protected-fragment changes', () => {
    document.body.innerHTML = '<p><span>First visible sentence.</span><code>secret-one</code></p>';
    const source = document.querySelector('p')!;
    expect(getElementSourceText(source)).toBe('First visible sentence.[[JT_KEEP_0]]');
    const span = source.querySelector('span')!;
    span.textContent = 'Updated visible sentence.';
    span.style.fontSize = '23px';
    source.querySelector('code')!.textContent = 'secret-two';
    expect(getElementSourceText(source)).toBe('Updated visible sentence.[[JT_KEEP_0]]');
    const translated = renderTranslation(source, '译文 [[JT_KEEP_0]]');
    expect(translated.textContent).toBe('译文 secret-two');
    expect(translated.style.fontSize).toBe('23px');
    restoreDocument();
  });

  it.each(['paragraph', 'mixed'])(
    'yields while analysing one large %s and can stop before it is submitted',
    async (kind) => {
      const inline = Array.from({ length: 1000 }, () => '<span>readable words </span>').join('');
      document.body.innerHTML =
        kind === 'mixed'
          ? `<main><div>${inline}<p>Nested independent paragraph.</p></div></main>`
          : `<main><p>${inline}</p></main>`;
      let analysisYielded = false;
      let scans = 0;
      const original = window.getComputedStyle.bind(window);
      vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
        if (element.tagName === 'SPAN') scans += 1;
        return original(element, pseudo);
      });
      const abort = new AbortController();
      const yielded: HTMLElement[] = [];
      for await (const slice of discoverTranslatableElements(document.body, {
        isVisible: () => true,
        signal: abort.signal,
        yieldTask: () => {
          // All inline traversal has finished; this yield belongs to the fragment analysis itself.
          if (scans > 200 && scans < 1000) {
            analysisYielded = true;
            abort.abort();
          }
          return Promise.resolve();
        },
      }))
        yielded.push(...slice);
      expect(analysisYielded).toBe(true);
      expect(yielded).toHaveLength(0);
      vi.restoreAllMocks();
    },
  );

  it('keeps article headers and readable flex text without selecting a flex layout wrapper', () => {
    document.body.innerHTML = `<header><a>Website navigation</a></header><main><article>
      <header><h1>A real article title</h1></header>
      <div style="display:flex"><span>A readable flex paragraph.</span><span>Another readable text.</span></div>
    </article></main>`;
    expect(
      collectTranslatableElements(document.body, { isVisible: () => true }).map(
        getElementSourceText,
      ),
    ).toEqual(['A real article title', 'A readable flex paragraph.', 'Another readable text.']);
  });

  it('protects inline code and no-translate fragments without losing original DOM on restore', () => {
    document.body.innerHTML =
      '<main><p>Run <code>npm install private-package</code> with <span translate="no">PRIVATE_TOKEN</span>.</p></main>';
    const source = document.querySelector('p')!;
    const original = source.innerHTML;
    const code = source.querySelector('code')!;
    const text = getElementSourceText(source);
    expect(text).not.toContain('private-package');
    expect(text).not.toContain('PRIVATE_TOKEN');
    expect(text.match(/\[\[JT_KEEP_\d+\]\]/gu)).toHaveLength(2);
    renderTranslation(source, text.replace('Run', '运行').replace('with', '使用'));
    expect(source.querySelector('[data-justranslate-translation]')?.textContent).toBe(
      '运行 npm install private-package 使用 PRIVATE_TOKEN.',
    );
    restoreDocument();
    expect(source.innerHTML).toBe(original);
    expect(source.querySelector('code')).toBe(code);
  });

  it('yields a first chunk before reading the rest of the page and never emits overlapping parents', async () => {
    document.body.innerHTML = `<main><div>${Array.from({ length: 50 }, (_, i) => `<p>Article paragraph number ${i}.</p>`).join('')}</div></main>`;
    const visited: HTMLElement[] = [];
    const pause = vi.fn().mockResolvedValue(undefined);
    const stream = discoverTranslatableElements(document.body, {
      isVisible: (element) => {
        visited.push(element);
        return true;
      },
      yieldTask: pause,
    });
    const first = await stream.next();
    if (first.done) throw new Error('Expected an initial discovery slice');
    expect(first.value.length).toBeGreaterThan(0);
    expect(first.value.length).toBeLessThanOrEqual(4);
    expect(visited).not.toContain(document.querySelectorAll('p')[49]);
    const elements = [...first.value];
    for await (const chunk of stream) elements.push(...chunk);
    expect(elements).toHaveLength(50);
    expect(elements.every((element) => element.tagName === 'P')).toBe(true);
    expect(pause).toHaveBeenCalled();
  });

  it('cancels discovery before visiting subsequent chunks', async () => {
    document.body.innerHTML = `<main>${'<p>A long enough paragraph.</p>'.repeat(20)}</main>`;
    const signal = new AbortController();
    const stream = discoverTranslatableElements(document.body, {
      isVisible: () => true,
      signal: signal.signal,
    });
    await stream.next();
    signal.abort();
    expect((await stream.next()).done).toBe(true);
  });

  it('does not reintroduce hidden or protected-only content through a parent or incremental root', () => {
    document.body.innerHTML = `<main><p>Visible paragraph <span style="display:none">HIDDEN_SECRET</span>text.</p>
      <p><code>protectedOnly()</code></p><form><p id="form-help">A readable form help paragraph.</p></form></main>`;
    expect(
      collectTranslatableElements(document.body, {
        isVisible: (element) => element.style.display !== 'none',
      }).map(getElementSourceText),
    ).toEqual(['Visible paragraph text.', 'A readable form help paragraph.']);
    expect(
      collectTranslatableElements(document.querySelector('#form-help')!, {
        isVisible: () => true,
      }).map(getElementSourceText),
    ).toEqual(['A readable form help paragraph.']);
  });

  it('collects leaf reading blocks while skipping code and nested duplicates while including form help', () => {
    document.body.innerHTML = `
      <main>
        <article>
          <h1>Readable title</h1>
          <div><p>First readable paragraph with <strong>inline text</strong>.</p></div>
          <div>A standalone readable block long enough to translate.</div>
          <pre><code>const secret = 'do not translate';</code></pre>
          <form><div>This form help text is readable.</div></form>
        </article>
      </main>
    `;

    const elements = collectTranslatableElements(document.body, {
      isVisible: () => true,
    });

    expect(elements.map(getElementSourceText)).toEqual([
      'Readable title',
      'First readable paragraph with inline text.',
      'A standalone readable block long enough to translate.',
      'This form help text is readable.',
    ]);
  });

  it('does not promote a translated leaf ancestor into a new candidate on later scans', () => {
    document.body.innerHTML = `
      <main>
        <article>
          <div id="article-heading">
            <div id="category">Technology &amp; Products</div>
            <h1 id="title">SolarWindow launches 0.85 mm-thick, self-adhesive solar film</h1>
          </div>
        </article>
      </main>
    `;
    const firstPass = collectTranslatableElements(document.body, { isVisible: () => true });
    expect(firstPass.map(getElementSourceText)).toEqual([
      'Technology & Products',
      'SolarWindow launches 0.85 mm-thick, self-adhesive solar film',
    ]);

    renderTranslation(firstPass[0], '技术与产品');
    renderTranslation(firstPass[1], 'SolarWindow 推出 0.85 毫米厚自粘式太阳能薄膜');

    const laterPass = collectTranslatableElements(document.body, { isVisible: () => true });

    expect(laterPass).toEqual([]);
    expect(
      document.querySelector('#article-heading')?.hasAttribute('data-justranslate-source'),
    ).toBe(false);
  });

  it('supports standalone reading links but keeps layout items and ARIA control labels separate', () => {
    document.body.innerHTML = `
      <main>
        <a id="article-link" href="/article">A standalone article title</a>
        <div style="display:flex"><span>Flexible layout content</span><span>Meta content</span></div>
        <div role="button">A long interactive control label is readable.</div>
        <p>Paragraph text with an <a href="/inline">inline link</a>.</p>
      </main>
    `;

    const elements = collectTranslatableElements(document.body, {
      isVisible: () => true,
    });

    expect(elements.map(getElementSourceText)).toEqual([
      'A standalone article title',
      'Flexible layout content',
      'Meta content',
      'A long interactive control label is readable.',
      'Paragraph text with an inline link.',
    ]);
  });

  it('uses the authoritative Hacker News rule and excludes ranks, metadata, and domains', () => {
    document.body.innerHTML = `
      <center>
        <table id="hnmain">
          <tbody>
            <tr>
              <td>
                <table>
                  <tbody>
                    <tr class="athing">
                      <td class="title"><span class="rank">1.</span></td>
                      <td class="title">
                        <span class="titleline">
                          <a href="/item">A sufficiently long Hacker News title</a>
                          <span class="sitebit"> (example.com)</span>
                        </span>
                      </td>
                    </tr>
                    <tr>
                      <td></td>
                      <td class="subtext">100 points by author | 20 comments</td>
                    </tr>
                    <tr><td colspan="2"><span class="comment">A useful HN comment.</span></td></tr>
                  </tbody>
                </table>
              </td>
            </tr>
          </tbody>
        </table>
      </center>
    `;

    const elements = collectTranslatableElements(document.body, {
      isVisible: () => true,
      url: 'https://news.ycombinator.com/news',
    });

    expect(elements.map(getElementSourceText)).toEqual([
      'A sufficiently long Hacker News title',
      'A useful HN comment.',
    ]);
    expect(
      elements.some((element) =>
        elements.some((other) => element !== other && element.contains(other)),
      ),
    ).toBe(false);
  });

  it('collects a matching site-rule root during incremental mutation scans', () => {
    document.body.innerHTML = `
      <span class="titleline">
        <a id="dynamic-title" href="/item">A newly inserted Hacker News title</a>
      </span>
    `;
    const root = document.querySelector<HTMLElement>('#dynamic-title')!;

    const elements = collectTranslatableElements(root, {
      isVisible: () => true,
      url: 'https://news.ycombinator.com/news',
    });

    expect(elements).toEqual([root]);
  });

  it('prefers article content and rejects leaked ad scripts, metadata, brands, and sidebars', () => {
    document.body.innerHTML = `
      <header><a href="/home">Site navigation should not be translated</a></header>
      <main>
        <div id="div-gpt-ad-top">
          googletag.cmd.push(function() { var divId = 'div-gpt-ad-top'; googletag.display(divId); });
        </div>
        <article lang="ja">
          <h1>前衛芸術家の草間彌生さんが死去\u3000カラフルな水玉模様</h1>
          <div class="published-at">2026/08/27</div>
          <div class="publisher">KYODO</div>
          <figure>
            <img src="yayoi.jpg" alt="" />
            <figcaption>アトリエで絵筆を握る草間彌生さん</figcaption>
          </figure>
          <p>世界的に高く評価された前衛芸術家の草間彌生さんが亡くなりました。</p>
        </article>
        <aside>関連記事のサイドバーは翻訳対象ではありません。</aside>
      </main>
      <footer>Footer copyright and navigation text</footer>
    `;

    const elements = collectTranslatableElements(document.body, {
      isVisible: () => true,
    });

    expect(elements.map(getElementSourceText)).toEqual([
      '前衛芸術家の草間彌生さんが死去 カラフルな水玉模様',
      'アトリエで絵筆を握る草間彌生さん',
      '世界的に高く評価された前衛芸術家の草間彌生さんが亡くなりました。',
    ]);
  });

  it('renders pending and retryable error states in the translation lane', () => {
    document.body.innerHTML =
      '<table><tbody><tr><td id="source">A pending table-cell translation.</td></tr></tbody></table>';
    const source = document.querySelector<HTMLElement>('#source')!;
    const originalText = getElementSourceText(source);

    renderTranslationPending(source, 'unit-1');

    const pending = source.querySelector<HTMLElement>('[data-justranslate-translation]')!;
    expect(pending.dataset.justranslateState).toBe('pending');
    expect(pending.dataset.justranslateUnitId).toBe('unit-1');
    expect(pending.getAttribute('aria-label')).toBe('正在翻译');
    expect(pending.textContent).toBe('');
    expect(getElementSourceText(source)).toBe(originalText);
    expect(source.nextElementSibling).toBeNull();

    renderTranslationError(source, 'unit-1');

    const error = source.querySelector<HTMLElement>('[data-justranslate-translation]')!;
    expect(error.dataset.justranslateState).toBe('error');
    expect(error.textContent).toContain('翻译失败 · 重试');
    expect(error.getAttribute('role')).toBe('button');
    expect(error.tabIndex).toBe(0);
    expect(error.getAttribute('title')).toBeNull();
  });

  it('keeps retry feedback readable using the original website color', () => {
    document.body.innerHTML =
      '<p style="color: rgb(210, 215, 220)">Readable dark website text.</p>';
    const source = document.querySelector('p')!;
    const error = renderTranslationError(source, 'unit-dark');
    expect(error.style.color).toBe('rgb(210, 215, 220)');
    renderTranslation(source, '译文');
    expect(error.getAttribute('role')).toBeNull();
    expect(error.getAttribute('tabindex')).toBeNull();
  });

  it('copies the dominant original text typography before wrapping Hacker News cells', () => {
    document.body.innerHTML = `
      <table>
        <tbody>
          <tr>
            <td id="title" style="color: rgb(130, 130, 130); font: 13px Arial;">
              <span class="titleline">
                <a
                  href="/item"
                  style="color: rgb(17, 34, 51); font-family: Georgia; font-size: 18px;
                    font-weight: 700; line-height: 24px; letter-spacing: 0.5px;
                    text-decoration-line: underline; text-align: left;"
                >A sufficiently long Hacker News title</a>
                <span style="color: rgb(130, 130, 130); font-size: 11px;"> (example.com)</span>
              </span>
            </td>
          </tr>
          <tr>
            <td
              id="subtext"
              style="color: rgb(130, 130, 130); font-family: Verdana; font-size: 9px;
                font-weight: 400; line-height: 12px;"
            >100 points by author | 20 comments</td>
          </tr>
        </tbody>
      </table>
    `;
    const title = document.querySelector<HTMLElement>('#title')!;
    const subtext = document.querySelector<HTMLElement>('#subtext')!;

    renderTranslationPending(title, 'unit-title');
    renderTranslation(title, '足够长的 Hacker News 标题');
    renderTranslation(subtext, '100 分，作者 author，20 条评论');

    const titleTranslation = title.querySelector<HTMLElement>('[data-justranslate-translation]')!;
    const subtextTranslation = subtext.querySelector<HTMLElement>(
      '[data-justranslate-translation]',
    )!;
    expect(titleTranslation.style.getPropertyValue('color')).toBe('rgb(17, 34, 51)');
    expect(titleTranslation.style.getPropertyValue('font-family')).toBe('Georgia');
    expect(titleTranslation.style.getPropertyValue('font-size')).toBe('18px');
    expect(titleTranslation.style.getPropertyValue('font-weight')).toBe('700');
    expect(titleTranslation.style.getPropertyValue('line-height')).toBe('24px');
    expect(titleTranslation.style.getPropertyValue('letter-spacing')).toBe('0.5px');
    expect(titleTranslation.style.getPropertyPriority('color')).toBe('important');
    expect(subtextTranslation.style.getPropertyValue('color')).toBe('rgb(130, 130, 130)');
    expect(subtextTranslation.style.getPropertyValue('font-family')).toBe('Verdana');
    expect(subtextTranslation.style.getPropertyValue('font-size')).toBe('9px');
    expect(subtextTranslation.style.getPropertyValue('line-height')).toBe('12px');
  });

  it('renders bilingual text, switches to translation-only, and restores untouched source DOM', () => {
    document.body.innerHTML = '<main><p id="source">Hello <strong>world</strong>.</p></main>';
    const source = document.querySelector<HTMLElement>('#source');
    expect(source).not.toBeNull();

    const originalHtml = source!.outerHTML;
    renderTranslation(source!, '你好，世界。');

    const translation = source!.querySelector('[data-justranslate-translation]');
    expect(translation?.textContent).toBe('你好，世界。');
    expect(source!.hidden).toBe(false);

    setDocumentDisplayMode('translation');
    expect(source!.querySelector<HTMLElement>('[data-justranslate-source-content]')?.hidden).toBe(
      true,
    );
    expect(translation?.hasAttribute('hidden')).toBe(false);

    setDocumentDisplayMode('bilingual');
    expect(source!.querySelector<HTMLElement>('[data-justranslate-source-content]')?.hidden).toBe(
      false,
    );

    restoreDocument();
    expect(document.querySelector('#source')?.outerHTML).toBe(originalHtml);
    expect(document.querySelector('[data-justranslate-translation]')).toBeNull();
  });

  it('renders table-cell translations inside the cell to keep valid table structure', () => {
    document.body.innerHTML =
      '<table><tbody><tr><td id="cell">Tuition fee</td></tr></tbody></table>';
    const cell = document.querySelector<HTMLElement>('#cell')!;

    renderTranslation(cell, '学费');

    expect(cell.querySelector('[data-justranslate-translation]')?.textContent).toBe('学费');
    expect(cell.nextElementSibling).toBeNull();
    restoreDocument();
    expect(cell.textContent).toBe('Tuition fee');
  });

  it('keeps list and definition-list content structurally valid', () => {
    document.body.innerHTML = `
      <ul><li id="item">First item</li><li>Second item</li></ul>
      <dl><dt id="term">Term</dt><dd>Definition</dd></dl>
    `;
    const item = document.querySelector<HTMLElement>('#item')!;
    const term = document.querySelector<HTMLElement>('#term')!;
    const originalBodyHtml = document.body.innerHTML;

    renderTranslation(item, '第一项');
    renderTranslation(term, '术语');

    expect(
      Array.from(document.querySelector('ul')!.children).map((child) => child.tagName),
    ).toEqual(['LI', 'LI']);
    expect(
      Array.from(document.querySelector('dl')!.children).map((child) => child.tagName),
    ).toEqual(['DT', 'DD']);
    expect(item.querySelector('[data-justranslate-translation]')?.textContent).toBe('第一项');
    expect(term.querySelector('[data-justranslate-translation]')?.textContent).toBe('术语');

    restoreDocument();
    expect(document.body.innerHTML).toBe(originalBodyHtml);
  });

  it('does not add a new flex or grid item beside the source block', () => {
    document.body.innerHTML =
      '<div id="layout" style="display:flex"><p id="source">A flexible paragraph.</p><aside>Side</aside></div>';
    const layout = document.querySelector<HTMLElement>('#layout')!;
    const source = document.querySelector<HTMLElement>('#source')!;

    renderTranslation(source, '弹性布局中的段落。');

    expect(Array.from(layout.children).map((child) => child.tagName)).toEqual(['P', 'ASIDE']);
    expect(source.querySelector('[data-justranslate-translation]')).not.toBeNull();
  });
});
