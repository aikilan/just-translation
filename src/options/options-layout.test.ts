import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const OPTIONS_CSS = readFileSync(new URL('./options.css', import.meta.url), 'utf8');

describe('options credential layout', () => {
  it('gives API Key and model the same explicit label and input rows', () => {
    const credentialsRule = OPTIONS_CSS.match(/\.api-credentials-grid\s*\{(?<body>[^}]*)\}/u);
    const fieldRule = OPTIONS_CSS.match(
      /\.api-credentials-grid\s*>\s*\.field\s*\{(?<body>[^}]*)\}/u,
    );

    expect(credentialsRule?.groups?.body).toMatch(/align-items:\s*start/u);
    expect(fieldRule?.groups?.body).toMatch(/grid-template-rows:\s*20px\s+48px\s+auto/u);
    expect(fieldRule?.groups?.body).toMatch(/align-content:\s*start/u);
  });
});
