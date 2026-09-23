import { spawn, type ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { translateImage } from './image-translation-client';
import { TEST_PROFILE } from '../test-utils/provider';

let server: ChildProcess;
let origin: string;
beforeAll(async () => {
  origin = await new Promise<string>((resolve, reject) => {
    server = spawn(process.execPath, ['scripts/image-fixture-server.mjs'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.on('error', reject);
    server.on('exit', (code) => {
      if (code) reject(new Error('Image fixture failed to start'));
    });
    server.stdout?.on('data', (chunk: Buffer) => {
      const url = /http:\/\/127\.0\.0\.1:\d+/u.exec(chunk.toString())?.[0];
      if (url) resolve(url);
    });
  });
});
afterAll(() => {
  server?.kill();
});
it.each(['openai', 'anthropic'] as const)(
  'verifies %s image blocks through a local HTTP fixture',
  async (protocol) => {
    const result = await translateImage(
      {
        ...TEST_PROFILE,
        protocol,
        apiUrl: `${origin}/image-api`,
        model: 'fixture-vision',
        targetLanguage: 'Simplified Chinese',
      },
      '',
      { mediaType: 'image/png', data: 'iVBORw0KGgo=', width: 10, height: 10 },
    );
    expect(result).toEqual({ status: 'translated', text: '欢迎光临\n营业时间：9:00–18:00' });
  },
);
