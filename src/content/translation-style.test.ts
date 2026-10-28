// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import {
  renderTranslation,
  renderTranslationError,
  restoreDocument,
  setDocumentDisplayMode,
  setDocumentTranslationStyle,
} from './dom-translator';

describe('translation style presets', () => {
  afterEach(() => {
    restoreDocument();
    setDocumentTranslationStyle('inherit');
    setDocumentDisplayMode('bilingual');
    document.body.innerHTML = '';
  });

  it('wraps completed text in an inline element without changing the visible text', () => {
    document.body.innerHTML = '<main><p id="source">Original paragraph.</p></main>';
    const translation = renderTranslation(document.querySelector('#source')!, '译文段落。');
    const content = translation.querySelector('[data-justranslate-translation-text]');
    expect(content?.tagName).toBe('SPAN');
    expect(translation.textContent).toBe('译文段落。');
    // Failure feedback replaces the wrapper, so presets never decorate retry controls.
    renderTranslationError(document.querySelector('#source')!, 'unit');
    expect(translation.querySelector('[data-justranslate-translation-text]')).toBeNull();
  });

  it('switches the document preset in place and clears it for the host style', () => {
    setDocumentTranslationStyle('dashed');
    expect(document.documentElement.dataset.justranslateStyle).toBe('dashed');
    setDocumentTranslationStyle('inherit');
    expect(document.documentElement.hasAttribute('data-justranslate-style')).toBe(false);
  });

  it('never blurs translations while the source text is hidden', () => {
    setDocumentTranslationStyle('blur');
    expect(document.documentElement.dataset.justranslateStyle).toBe('blur');
    setDocumentDisplayMode('translation');
    expect(document.documentElement.hasAttribute('data-justranslate-style')).toBe(false);
    setDocumentDisplayMode('bilingual');
    expect(document.documentElement.dataset.justranslateStyle).toBe('blur');
  });

  it('makes blurred prose focusable so keyboard and touch users can reveal it', () => {
    document.body.innerHTML = '<main><p id="source">Original paragraph.</p></main>';
    const translation = renderTranslation(document.querySelector('#source')!, '译文段落。');
    expect(translation.hasAttribute('tabindex')).toBe(false);
    setDocumentTranslationStyle('blur');
    expect(translation.tabIndex).toBe(0);
    setDocumentDisplayMode('translation');
    expect(translation.hasAttribute('tabindex')).toBe(false);
    setDocumentDisplayMode('bilingual');
    expect(translation.tabIndex).toBe(0);
    setDocumentTranslationStyle('highlight');
    expect(translation.hasAttribute('tabindex')).toBe(false);
  });

  it('renders new translations focusable while learning mode is active', () => {
    setDocumentTranslationStyle('blur');
    document.body.innerHTML = '<main><p id="source">Original paragraph.</p></main>';
    expect(renderTranslation(document.querySelector('#source')!, '译文。').tabIndex).toBe(0);
  });
});
