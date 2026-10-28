// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  detectPageLanguage,
  samplePageText,
  waitForDomQuiet,
  type LanguageDetector,
} from './page-language';

const LONG_TEXT =
  'Reading opens a window to ideas beyond our everyday world. A few quiet moments can change how we see things. '.repeat(
    3,
  );

function detector(language: string, percentage = 96, isReliable = true): LanguageDetector {
  return vi.fn<LanguageDetector>().mockResolvedValue({
    isReliable,
    languages: [{ language, percentage }],
  });
}

describe('page language detection', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('lang');
    document.body.innerHTML = '';
  });

  it('samples main text and skips code, scripts and hidden content', () => {
    document.body.innerHTML = `<nav>Menu</nav><main><p>${LONG_TEXT}</p><pre>const code = 1;</pre><script>var x</script><p hidden>Hidden words</p></main>`;
    const text = samplePageText();
    expect(text).toContain('Reading opens a window');
    for (const excluded of ['Menu', 'const code', 'var x', 'Hidden words'])
      expect(text).not.toContain(excluded);
  });

  it('detects a reliable majority language and normalizes legacy tags', async () => {
    document.body.innerHTML = `<main><p>${LONG_TEXT}</p></main>`;
    await expect(detectPageLanguage(document, detector('en'))).resolves.toEqual({
      status: 'detected',
      language: 'en',
      tag: 'en',
    });
    await expect(detectPageLanguage(document, detector('iw'))).resolves.toEqual({
      status: 'detected',
      language: 'he',
      tag: 'he',
    });
  });

  it('keeps the Chinese script so Traditional pages differ from Simplified ones', async () => {
    document.body.innerHTML = `<main><p>${'這是一段足夠長的繁體中文段落，用來測試頁面語言識別。'.repeat(6)}</p></main>`;
    await expect(detectPageLanguage(document, detector('zh-Hant'))).resolves.toMatchObject({
      language: 'zh',
      tag: 'zh-Hant',
    });
    await expect(detectPageLanguage(document, detector('zh'))).resolves.toMatchObject({
      tag: 'zh-Hans',
    });
    document.documentElement.lang = 'zh-TW';
    await expect(detectPageLanguage(document, detector('zh'))).resolves.toMatchObject({
      tag: 'zh-Hant',
    });
  });

  it('reports too little text without running the detector', async () => {
    document.body.innerHTML = '<main><p>Short.</p></main>';
    const detect = detector('en');
    await expect(detectPageLanguage(document, detect)).resolves.toEqual({
      status: 'insufficient',
    });
    expect(detect).not.toHaveBeenCalled();
  });

  it('stays unknown for unreliable, minority or contradicted results', async () => {
    document.body.innerHTML = `<main><p>${LONG_TEXT}</p></main>`;
    for (const detect of [detector('en', 96, false), detector('en', 55), detector('und')])
      await expect(detectPageLanguage(document, detect)).resolves.toEqual({ status: 'unknown' });
    document.documentElement.lang = 'fr';
    await expect(detectPageLanguage(document, detector('en'))).resolves.toEqual({
      status: 'unknown',
    });
    document.documentElement.lang = 'en-GB';
    await expect(detectPageLanguage(document, detector('en'))).resolves.toEqual({
      status: 'detected',
      language: 'en',
      tag: 'en',
    });
  });

  it('ignores a teaser article and falls back to the body when main is thin', () => {
    document.body.innerHTML = `<article>Promo</article><main><p>${LONG_TEXT}</p></main>`;
    expect(samplePageText()).not.toContain('Promo');
    document.body.innerHTML = `<header>Site</header><main><p>Loading</p></main><section><p>${LONG_TEXT}</p></section>`;
    expect(samplePageText()).toContain('Reading opens a window');
  });

  it('waits for a rendering route to stop changing', async () => {
    vi.useFakeTimers();
    try {
      let settled = false;
      void waitForDomQuiet(document, 100, 1_000).then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(60);
      document.body.append(document.createElement('p'));
      await vi.advanceTimersByTimeAsync(60);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(60);
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats a detector failure as unknown', async () => {
    document.body.innerHTML = `<main><p>${LONG_TEXT}</p></main>`;
    const failing = vi.fn<LanguageDetector>().mockRejectedValue(new Error('unavailable'));
    await expect(detectPageLanguage(document, failing)).resolves.toEqual({ status: 'unknown' });
  });
});
