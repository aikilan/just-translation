import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const POPUP_CSS = readFileSync(new URL('./popup.css', import.meta.url), 'utf8');

describe('popup layout contract', () => {
  it('uses a 520px fixed-shell layout with a dedicated scrollable content region', () => {
    const bodyRule = POPUP_CSS.match(/body\s*\{(?<body>[^}]*)\}/u);
    const shellRule = POPUP_CSS.match(/\.popup-shell\s*\{(?<body>[^}]*)\}/u);
    const contentRule = POPUP_CSS.match(/\.popup-content\s*\{(?<body>[^}]*)\}/u);

    expect(bodyRule?.groups?.body).toMatch(/width:\s*520px/u);
    expect(shellRule?.groups?.body).toMatch(/max-height:\s*600px/u);
    expect(shellRule?.groups?.body).toMatch(
      /grid-template-rows:\s*auto\s+minmax\(0,\s*1fr\)\s+auto/u,
    );
    expect(contentRule?.groups?.body).toMatch(/overflow-y:\s*auto/u);
  });

  it('keeps dark-theme and reduced-motion branches', () => {
    expect(POPUP_CSS).toContain('@media (prefers-color-scheme: dark)');
    expect(POPUP_CSS).toContain('@media (prefers-reduced-motion: reduce)');
  });
});
