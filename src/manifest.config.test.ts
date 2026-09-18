import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const manifestSource = readFileSync(new URL('../manifest.config.ts', import.meta.url), 'utf8');

describe('extension entry points', () => {
  it('uses distinct file names for the service worker and content script', () => {
    const serviceWorker = readEntry(/service_worker:\s*'([^']+)'/u, 'service worker');
    const contentScript = readEntry(/js:\s*\['([^']+)'\]/u, 'content script');

    expect(path.basename(serviceWorker)).not.toBe(path.basename(contentScript));
  });

  it('requests alarm access for fixed-interval cache maintenance', () => {
    expect(manifestSource).toMatch(/permissions:\s*\[[^\]]*'alarms'/su);
  });

  it('injects only the dedicated selection script into child frames', () => {
    const entries = manifestSource.match(/\{\s*matches:[\s\S]*?run_at:[\s\S]*?\}/gu)!;
    expect(entries).toHaveLength(2);
    const selection = entries.find((entry) => entry.includes('selection-content-script'))!;
    const page = entries.find((entry) => entry.includes("'src/content/content-script.ts'"))!;
    expect(selection).toContain('all_frames: true');
    expect(page).not.toContain('all_frames: true');
  });
});

function readEntry(pattern: RegExp, label: string): string {
  const entry = manifestSource.match(pattern)?.[1];
  if (!entry) throw new Error(`manifest is missing ${label} entry`);
  return entry;
}
