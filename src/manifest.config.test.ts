import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const manifestSource = readFileSync(
  new URL('../manifest.config.ts', import.meta.url),
  'utf8',
);

describe('extension entry points', () => {
  it('uses distinct file names for the service worker and content script', () => {
    const serviceWorker = readEntry(
      /service_worker:\s*'([^']+)'/u,
      'service worker',
    );
    const contentScript = readEntry(/js:\s*\['([^']+)'\]/u, 'content script');

    expect(path.basename(serviceWorker)).not.toBe(path.basename(contentScript));
  });

  it('requests alarm access for fixed-interval cache maintenance', () => {
    expect(manifestSource).toMatch(/permissions:\s*\[[^\]]*'alarms'/su);
  });
});

function readEntry(pattern: RegExp, label: string): string {
  const entry = manifestSource.match(pattern)?.[1];
  if (!entry) throw new Error(`manifest is missing ${label} entry`);
  return entry;
}
