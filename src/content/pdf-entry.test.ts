// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isBrowserPdfDocument, mountPdfEntry } from './pdf-entry';

afterEach(() => {
  document.body.replaceChildren();
});

describe('browser PDF entry', () => {
  it('detects the plugin document Chrome uses for PDFs', () => {
    expect(isBrowserPdfDocument(document)).toBe(false);
    document.body.innerHTML = '<embed type="application/pdf" src="about:blank">';
    expect(isBrowserPdfDocument(document)).toBe(true);
    document.body.innerHTML = '<p>Article</p><embed type="application/pdf">';
    expect(isBrowserPdfDocument(document)).toBe(false);
  });

  it('mounts an isolated entry that the reader can hide', () => {
    const onTranslate = vi.fn();
    const attach = vi.spyOn(HTMLElement.prototype, 'attachShadow');
    const remove = mountPdfEntry(onTranslate);
    const host = document.querySelector('just-translate-pdf-entry');
    expect(host).not.toBeNull();
    // A closed root keeps the page from scripting the control.
    expect(attach).toHaveBeenCalledWith({ mode: 'closed' });
    expect(host!.shadowRoot).toBeNull();
    const root = attach.mock.results[0].value as ShadowRoot;
    const [translate, close] = root.querySelectorAll('button');
    expect(translate.textContent).toBe('翻译此 PDF');
    translate.click();
    expect(onTranslate).toHaveBeenCalledOnce();
    expect(close.getAttribute('aria-label')).toBe('隐藏此按钮');
    close.click();
    expect(document.querySelector('just-translate-pdf-entry')).toBeNull();
    remove();
    attach.mockRestore();
  });
});
