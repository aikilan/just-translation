import { TEST_PROFILE } from '../test-utils/provider';
import { spawn, type ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { translateBatch } from './translation-client';

describe('local browser SSE acceptance fixture', () => {
  let server: ChildProcess;
  let origin: string;
  beforeAll(async () => {
    origin = await new Promise<string>((resolve, reject) => {
      server = spawn(process.execPath, ['scripts/browser-fixture-server.mjs'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      server.on('error', reject);
      server.stdout?.on('data', (chunk: Buffer) => {
        const url = /http:\/\/127\.0\.0\.1:\d+/u.exec(chunk.toString())?.[0];
        if (url) resolve(url);
      });
    });
  });
  afterAll(() => {
    server?.kill();
  });

  it('automatically recovers a failed HTTP response with exactly one SSE retry', async () => {
    await fetch(`${origin}/scenario?mode=fail-once`);
    const result = await translateBatch(
      {
        ...TEST_PROFILE,
        apiUrl: origin,
        model: 'fixture',
        targetLanguage: 'Chinese',
      },
      [{ requestId: 'a:0', unitId: 'a', partIndex: 0, text: 'First' }],
    );
    expect(result).toEqual({ translations: { 'a:0': '译文：First' }, failures: {} });
    const stats = (await fetch(`${origin}/stats`).then((response) => response.json())) as {
      calls: number;
      requests: { ids: string[]; streaming: boolean }[];
    };
    expect(stats.calls).toBe(2);
    expect(stats.requests.every(({ streaming }) => streaming)).toBe(true);
  });

  it('sends validated progress while the HTTP request is still active', async () => {
    await fetch(`${origin}/scenario?mode=stream`);
    let resolveFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const work = translateBatch(
      {
        ...TEST_PROFILE,
        apiUrl: origin,
        model: 'fixture',
        targetLanguage: 'Chinese',
      },
      [
        { requestId: 'a:0', unitId: 'a', partIndex: 0, text: 'First' },
        { requestId: 'b:0', unitId: 'b', partIndex: 0, text: 'Second' },
      ],
      fetch,
      undefined,
      { onTranslations: resolveFirst, maxRetries: 0 },
    );
    // Observe both promises so a failed transport does not leave the test waiting forever.
    await Promise.race([first, work]);
    const stats = (await fetch(`${origin}/stats`).then((response) => response.json())) as {
      active: number;
    };
    expect(stats.active).toBe(1);
    expect((await work).failures).toEqual({});
  });
});
