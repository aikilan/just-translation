/** Wire-format fixtures shared by request tests and trusted settings-page tests. */
export function sseEvent(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

export function contentEvent(content: string): string {
  return sseEvent({ choices: [{ index: 0, delta: { content }, finish_reason: null }] });
}

export const STREAM_END =
  sseEvent({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n';

export function completionResponse(translations: Array<{ id: string; text: string }>): Response {
  return new Response(contentEvent(JSON.stringify({ translations })) + STREAM_END, {
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  });
}
