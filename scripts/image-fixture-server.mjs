import { createServer } from 'node:http';
import { stdout } from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { URL, fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import react from '@vitejs/plugin-react';

// Local acceptance only: real image decoding and HTTP/SSE, deterministic translations, no secrets.
const vite = await createViteServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  configFile: false,
  plugins: [react()],
  server: { middlewareMode: true },
  appType: 'mpa',
  logLevel: 'error',
});
const stats = { calls: 0, openai: 0, anthropic: 0, aborted: 0, imageTypes: [], bytes: [] };
const event = (type, data) => `${type ? `event: ${type}\n` : ''}data: ${JSON.stringify(data)}\n\n`;
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  if (url.pathname === '/image-stats') {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(stats));
    return;
  }
  if (!url.pathname.startsWith('/image-api/')) {
    vite.middlewares(request, response);
    return;
  }
  try {
    let body = '';
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    const anthropic = url.pathname.endsWith('/messages');
    const content = input.messages.at(-1).content;
    const image = content.find((part) => part.type === (anthropic ? 'image' : 'image_url'));
    const data = anthropic ? image?.source?.data : image?.image_url?.url?.split(',')[1];
    const mediaType = anthropic
      ? image?.source?.media_type
      : image?.image_url?.url?.slice(5).split(';')[0];
    if (!data || !['image/png', 'image/jpeg'].includes(mediaType) || !input.stream) {
      response.writeHead(400);
      response.end('Image content required');
      return;
    }
    stats.calls += 1;
    stats[anthropic ? 'anthropic' : 'openai'] += 1;
    stats.imageTypes.push(mediaType);
    stats.bytes.push(data.length);
    const stopped = new globalThis.AbortController();
    response.once('close', () => {
      if (!response.writableFinished) stats.aborted += 1;
      stopped.abort();
    });
    try {
      await delay(input.model === 'fixture-slow' ? 10_000 : 150, undefined, {
        signal: stopped.signal,
      });
    } catch {
      return;
    }
    if (input.model === 'fixture-error') {
      response.writeHead(400);
      response.end('Synthetic provider rejection');
      return;
    }
    response.setHeader('Content-Type', 'text/event-stream');
    const translated = JSON.stringify({
      translations: [
        {
          id: 'image',
          text: input.model === 'fixture-empty' ? '' : '欢迎光临\n营业时间：9:00–18:00',
        },
      ],
    });
    if (anthropic) {
      response.end(
        event('message_start', {
          type: 'message_start',
          message: { role: 'assistant', content: [], stop_reason: null },
        }) +
          event('content_block_start', {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          }) +
          event('content_block_delta', {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: translated },
          }) +
          event('content_block_stop', { type: 'content_block_stop', index: 0 }) +
          event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' } }) +
          event('message_stop', { type: 'message_stop' }),
      );
    } else
      response.end(
        event('', {
          choices: [{ index: 0, delta: { content: translated }, finish_reason: null }],
        }) +
          event('', { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) +
          'data: [DONE]\n\n',
      );
  } catch {
    response.writeHead(500);
    response.end('Invalid fixture request');
  }
});
server.listen(0, '127.0.0.1', () =>
  stdout.write(`Image fixture: http://127.0.0.1:${server.address().port}\n`),
);
