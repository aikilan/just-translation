import { describe, expect, it, vi } from 'vitest';

import { shouldSkipTargetLanguage, type LanguageScore } from './content-language';

describe('shouldSkipTargetLanguage', () => {
  it.each(['A complete English paragraph.', '中文 mixed English', '日本語の文章', '한국어 문장'])(
    'does not trust a Chinese UI declaration for %s',
    (text) => {
      expect(shouldSkipTargetLanguage(text, 'zh-CN', 'Simplified Chinese')).toBe(false);
    },
  );
  it('does not skip short foreign text solely because its declaration matches', () => {
    expect(shouldSkipTargetLanguage('Bonjour', 'en', 'English')).toBe(false);
  });
  it('preserves Chinese script variants instead of skipping simplified/traditional conversion', () => {
    const detector = vi.fn(() => [{ lang: 'zh', accuracy: 0.99 }]);
    expect(
      shouldSkipTargetLanguage('這是一段繁體中文內容。', 'zh-TW', 'Simplified Chinese', detector),
    ).toBe(false);
    expect(
      shouldSkipTargetLanguage('这是一段简体中文内容。', 'zh-CN', 'Traditional Chinese', detector),
    ).toBe(false);
    expect(
      shouldSkipTargetLanguage(
        '這是一段长度足夠但沒有可靠文字變體声明的中文文章內容，應當交由翻譯模型處理。',
        'zh',
        'Simplified Chinese',
        detector,
      ),
    ).toBe(false);
    expect(
      shouldSkipTargetLanguage('這是繁體中文。', 'zh-Hant', 'Traditional Chinese', detector),
    ).toBe(true);
  });

  it('avoids statistical detection when the target script is absent', () => {
    const detector = vi.fn<() => LanguageScore[]>(() => []);
    for (const target of [
      'Simplified Chinese',
      'Japanese',
      'Korean',
      'Russian',
      'Arabic',
      'Hindi',
    ]) {
      expect(
        shouldSkipTargetLanguage(
          'A long Hacker News headline about open source software and databases.',
          'en',
          target,
          detector,
        ),
      ).toBe(false);
    }
    expect(detector).not.toHaveBeenCalled();
    shouldSkipTargetLanguage(
      '这是中文 mixed with enough English text for statistical detection.',
      undefined,
      'Chinese',
      detector,
    );
    expect(detector).toHaveBeenCalledOnce();
  });
  it('skips content when the nearest declared language matches the target language', () => {
    const detector = vi.fn<() => LanguageScore[]>(() => []);

    expect(shouldSkipTargetLanguage('中文短句', 'zh-CN', 'Simplified Chinese', detector)).toBe(
      true,
    );
    expect(detector).not.toHaveBeenCalled();
  });

  it('skips only long, high-confidence target-language content with a clear lead', () => {
    const chineseText = '这是一段长度足够且语言特征明确的中文新闻正文内容，用于验证高置信度过滤。';
    const detector = vi.fn<() => LanguageScore[]>(() => [
      { lang: 'zh', accuracy: 0.96 },
      { lang: 'ja', accuracy: 0.12 },
    ]);

    expect(shouldSkipTargetLanguage(chineseText, undefined, 'Chinese', detector)).toBe(true);
  });

  it('keeps low-confidence, close-score, short, and mixed content for AI translation', () => {
    const detector = vi.fn<() => LanguageScore[]>(() => [
      { lang: 'zh', accuracy: 0.89 },
      { lang: 'ja', accuracy: 0.75 },
    ]);

    expect(
      shouldSkipTargetLanguage(
        '这是 mixed language content that should still be sent to AI for translation.',
        undefined,
        'Simplified Chinese',
        detector,
      ),
    ).toBe(false);
    expect(shouldSkipTargetLanguage('中文 short', undefined, 'Simplified Chinese', detector)).toBe(
      false,
    );
  });

  it('keeps source-language Japanese when translating to Chinese', () => {
    const detector = vi.fn<() => LanguageScore[]>(() => [
      { lang: 'ja', accuracy: 0.99 },
      { lang: 'zh', accuracy: 0.01 },
    ]);

    expect(
      shouldSkipTargetLanguage(
        'これは十分に長い日本語のニュース本文で、翻訳対象として保持されるべき内容です。',
        'ja',
        'Simplified Chinese',
        detector,
      ),
    ).toBe(false);
  });

  it('does not guess language semantics for an unsupported custom target name', () => {
    const detector = vi.fn<() => LanguageScore[]>(() => [
      { lang: 'zh', accuracy: 0.99 },
      { lang: 'en', accuracy: 0.01 },
    ]);

    expect(
      shouldSkipTargetLanguage(
        '这是一段足够长的文本，但自定义目标语言无法安全映射，所以仍然应该发送给模型。',
        undefined,
        'My Custom Language',
        detector,
      ),
    ).toBe(false);
    expect(detector).not.toHaveBeenCalled();
  });
});
