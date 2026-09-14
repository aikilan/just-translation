// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerRetryInteractions } from './retry-interaction';

describe('translation retry interactions', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('retries only the failed source by click or keyboard without following its link', () => {
    document.body.innerHTML = `
      <a data-justranslate-source href="/leave-page">
        <span data-justranslate-source-content>Failed linked source</span>
        <span
          data-justranslate-translation
          data-justranslate-state="error"
          role="button"
          tabindex="0"
        >翻译失败 · 重试</span>
      </a>
      <p data-justranslate-source>
        <span data-justranslate-source-content>Other source</span>
        <span
          data-justranslate-translation
          data-justranslate-state="error"
          role="button"
          tabindex="0"
        >翻译失败 · 重试</span>
      </p>
    `;
    const retry = vi.fn();
    const dispose = registerRetryInteractions(retry, document);
    const linkedError = document.querySelector<HTMLElement>('a [data-justranslate-state="error"]')!;
    const linkedSource = linkedError.closest<HTMLElement>('[data-justranslate-source]')!;
    const otherError = document.querySelector<HTMLElement>('p [data-justranslate-state="error"]')!;

    const clickAllowed = linkedError.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );
    otherError.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    otherError.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(clickAllowed).toBe(false);
    expect(retry).toHaveBeenNthCalledWith(1, linkedSource);
    expect(retry).toHaveBeenNthCalledWith(
      2,
      otherError.closest<HTMLElement>('[data-justranslate-source]'),
    );
    expect(retry).toHaveBeenCalledTimes(2);
    dispose();
  });
});
