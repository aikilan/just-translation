import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { stdout } from 'node:process';
import { URL } from 'node:url';

// Local-only browser acceptance fixture: no user credentials or external API calls.
let mode = 'normal';
let calls = 0;
let active = 0;
let maximumActive = 0;
let omittedId;
const sizes = [];
let protectedTextLeaked = false;
let aborted = 0;
const requests = [];
const event = (value) => `data: ${JSON.stringify(value)}\n\n`;
const contentEvent = (content) =>
  event({ choices: [{ index: 0, delta: { content }, finish_reason: null }] });
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  response.setHeader('Content-Type', 'application/json');
  if (url.pathname === '/scenario') {
    mode = url.searchParams.get('mode') ?? 'normal';
    calls = 0;
    maximumActive = 0;
    omittedId = undefined;
    sizes.length = 0;
    protectedTextLeaked = false;
    aborted = 0;
    requests.length = 0;
    response.end('{}');
    return;
  }
  if (url.pathname === '/stats') {
    response.end(
      JSON.stringify({
        mode,
        calls,
        active,
        maximumActive,
        sizes,
        protectedTextLeaked,
        aborted,
        requests,
      }),
    );
    return;
  }
  if (url.pathname === '/v1/chat/completions') {
    let body = '';
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    const { segments } = JSON.parse(input.messages[1].content);
    calls += 1;
    const requestNumber = calls;
    const scenario = mode;
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    sizes.push(segments.length);
    protectedTextLeaked ||= /PRIVATE_TOKEN|private-package/.test(body);
    requests.push({
      ids: segments.map(({ id }) => id),
      texts: segments.map(({ text }) => text),
      streaming: input.stream === true,
    });
    const stopped = new globalThis.AbortController();
    response.once('close', () => {
      active -= 1;
      if (!response.writableFinished) aborted += 1;
      stopped.abort();
    });
    const compensate = mode === 'partial' && segments.some(({ id }) => id === omittedId);
    let chosen = segments;
    if (mode === 'partial' && !omittedId && segments.length > 1) {
      omittedId = segments[1].id;
      chosen = segments.filter(({ id }) => id !== omittedId);
    }
    try {
      if (
        scenario === 'fail' ||
        (scenario === 'fail-once' && requestNumber === 1) ||
        input.stream !== true
      ) {
        response.writeHead(400);
        response.end('{"error":"local fixture rejection: SSE required"}');
        return;
      }
      if (scenario === 'json') {
        response.end(
          JSON.stringify({ choices: [{ message: { content: '{"translations":[]}' } }] }),
        );
        return;
      }
      response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      response.setHeader('Cache-Control', 'no-cache');
      response.flushHeaders();
      await delay(scenario === 'slow' ? 3_000 : compensate ? 2_000 : 150, undefined, {
        signal: stopped.signal,
      });
      response.write(contentEvent('{"translations":['));
      for (const [index, { id, text }] of chosen.entries()) {
        if (index > 0 && scenario === 'stream')
          await delay(600, undefined, { signal: stopped.signal });
        if (index === 1 && scenario === 'disconnect' && requestNumber === 1) {
          response.write(contentEvent(`,{"id":${JSON.stringify(id)},"text":"unfinished`));
          await delay(300, undefined, { signal: stopped.signal });
          response.destroy();
          return;
        }
        response.write(
          contentEvent(`${index ? ',' : ''}${JSON.stringify({ id, text: `译文：${text}` })}`),
        );
      }
      if (scenario === 'stream') await delay(800, undefined, { signal: stopped.signal });
      response.write(contentEvent(']}'));
      response.end(
        event({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n',
      );
    } catch (error) {
      if (!stopped.signal.aborted) {
        response.destroy(error);
      }
    }
    return;
  }
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (url.pathname === '/news') {
    response.end(
      `<!doctype html><html lang="en"><style>body{font:16px Arial}a{color:#111}td{padding:6px}</style><table>${Array.from(
        { length: 60 },
        (_, i) =>
          `<tr><td>${i + 1}.</td><td><span class="titleline"><a href="/item?id=${i}">Article ${i + 1}: a readable Hacker News technology headline</a><span> (example.com)</span></span></td></tr><tr><td></td><td class="subtext">100 points | 2 hours ago | 20 comments</td></tr>`,
      ).join('')}</table></html>`,
    );
  } else {
    response.end(`<!doctype html><html lang="en"><style>body{font:18px Arial;max-width:800px;margin:30px auto}h1{font:700 30px Georgia}.flex{display:flex;gap:20px}</style>
      <header>Website navigation links</header><main><article><header><h1>A real solar energy article title</h1></header>
      <p>First article paragraph about solar panels and new energy technologies.</p>
      <p>Run <code>npm install private-package</code> with <span translate="no">PRIVATE_TOKEN</span>.</p>
      <div class="flex"><span>A readable flex paragraph.</span><span>Another readable flex paragraph.</span></div>
      <p>Final article paragraph about applications and future opportunities.</p>
      <div>2026/09/10</div><div>KYODO</div><aside>Unrelated sidebar recommendations</aside>
      </article></main></html>`);
  }
});
server.listen(0, '127.0.0.1', () =>
  stdout.write(`Fixture server: http://127.0.0.1:${server.address().port}\n`),
);
