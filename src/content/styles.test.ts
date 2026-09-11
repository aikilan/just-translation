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
});
