import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const stylesheet = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

describe('content translation styles', () => {
  it('renders pending feedback as a compact spinner without visible loading text', () => {
    expect(stylesheet).toContain('@keyframes justtranslate-pending-spinner');
    expect(stylesheet).toContain('border-radius: 50%');
    expect(stylesheet).toContain('border-inline-end-color: transparent');
    expect(stylesheet).not.toContain("content: '•••'");
    expect(stylesheet).not.toContain('justranslate-pending-dots');
  });

  it('defines every non-default preset and keeps interface labels out of them', () => {
    for (const style of ['faded', 'dashed', 'highlight', 'quote', 'blur'])
      expect(stylesheet).toContain(`:root[data-justranslate-style='${style}']`);
    const presetRules = stylesheet.match(/:root\[data-justranslate-style='[a-z]+'\]\n[^{]+\{/gu);
    expect(presetRules?.length).toBeGreaterThan(4);
    for (const rule of presetRules ?? []) {
      if (rule.includes(':hover') || rule.includes(':focus-within')) continue;
      expect(rule).toContain(':not([data-justranslate-label])');
    }
  });
});
