import type { ApiProtocol } from './providers';
import { JSONParser, TokenType } from '@streamparser/json';
import { createParser } from 'eventsource-parser';

export interface StreamTranslationItem {
  id: string;
  text: string;
}

/** Framing/schema/mapping errors stop this response; the caller owns the shared retry budget. */
export class StreamProtocolError extends Error {}

/** An unfinished transport can retry only the IDs not already accepted by its caller. */
export class StreamInterruptedError extends Error {}
export class StreamOutputLimitError extends StreamInterruptedError {}

export interface TranslationStreamLimits {
  maxStreamBytes: number;
  maxEventCharacters: number;
  maxJsonCharacters: number;
}
const BATCH_STREAM_LIMITS: TranslationStreamLimits = {
  // Counts all SSE bytes, including reasoning content and event metadata, for one attempt.
  maxStreamBytes: 10 * 1_048_576,
  maxEventCharacters: 262_144,
  maxJsonCharacters: 262_144,
};
export const FULL_DOCUMENT_STREAM_LIMITS: TranslationStreamLimits = {
  maxStreamBytes: 16 * 1_048_576,
  maxEventCharacters: 1_048_576,
  maxJsonCharacters: 2 * 1_048_576,
};

/**
 * Decodes one Chat Completions or Messages SSE body. Only complete JSON items reach onItem;
 * the caller owns ID/marker validation and the cross-attempt, write-once result ledger.
 * Network bytes, provider diagnostics and unfinished strings never become progress events.
 */
export async function readTranslationStream(
  response: Response,
  protocol: ApiProtocol,
  onItem: (item: StreamTranslationItem) => void,
  signal?: AbortSignal,
  onContent?: () => void,
  limits: TranslationStreamLimits = BATCH_STREAM_LIMITS,
): Promise<void> {
  if (!response.body) throw new StreamProtocolError('API 未返回流式响应体');
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    signal?.throwIfAborted();
    if (
      response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !==
      'text/event-stream'
    ) {
      throw new StreamProtocolError('API 未返回 SSE 流式响应，请确认接口支持 stream: true');
    }
    const textDecoder = new TextDecoder('utf-8', { fatal: true });
    const payload = new TranslationPayloadDecoder((item) => {
      signal?.throwIfAborted();
      onItem(item);
    }, limits.maxJsonCharacters);
    const anthropic = new AnthropicEventDecoder();
    let done = false;
    let finished = false;
    let bytes = 0;
    const events = createParser({
      maxBufferSize: limits.maxEventCharacters,
      onError(error) {
        throw new StreamProtocolError(
          error.type === 'max-buffer-size-exceeded'
            ? 'API 流式响应超过缓冲上限'
            : 'API 返回了无效 SSE 事件',
        );
      },
      onEvent(event) {
        signal?.throwIfAborted();
        if (event.data.length > limits.maxEventCharacters)
          throw new StreamProtocolError('API 流式事件超过大小上限');
        if (done) return;
        if (protocol === 'openai' && event.data.trim() === '[DONE]') {
          if (!finished) throw new StreamInterruptedError('API 流式响应缺少正常结束标记');
          payload.finish();
          done = true;
          return;
        }
        let chunk: unknown;
        try {
          chunk = JSON.parse(event.data) as unknown;
        } catch {
          throw new StreamProtocolError('API 返回了无效的流式事件 JSON');
        }
        if (!isRecord(chunk)) throw new StreamProtocolError('API 返回了无效流式事件');
        if (isRecord(chunk.error)) {
          const detail =
            typeof chunk.error.message === 'string' ? chunk.error.message : '未知服务商错误';
          // The request boundary redacts credentials before exposing this diagnostic.
          throw new StreamProtocolError(`API 流式返回错误：${detail}`);
        }
        if (protocol === 'anthropic') {
          if (event.event && event.event !== chunk.type)
            throw new StreamProtocolError('Anthropic 事件名称与类型不匹配');
          const decoded = anthropic.consume(chunk);
          if (decoded.text) {
            if (decoded.text.trim()) onContent?.();
            payload.write(decoded.text);
          }
          if (decoded.done) {
            payload.finish();
            done = true;
          }
          return;
        }
        if (!Array.isArray(chunk.choices))
          throw new StreamProtocolError('API 流式返回中缺少 choices');
        if (chunk.choices.length === 0 && isRecord(chunk.usage)) return;
        const choice: unknown = chunk.choices[0];
        if (
          chunk.choices.length !== 1 ||
          !isRecord(choice) ||
          choice.index !== 0 ||
          !isRecord(choice.delta)
        ) {
          throw new StreamProtocolError('API 返回了无效的流式 choice/delta');
        }
        const { content, refusal, tool_calls: toolCalls } = choice.delta;
        if (refusal || toolCalls)
          throw new StreamProtocolError('API 未返回翻译内容：模型拒绝响应或返回了工具调用');
        if (content !== undefined && content !== null && typeof content !== 'string') {
          throw new StreamProtocolError('API 流式译文内容必须是文本');
        }
        if (typeof content === 'string' && content.length > 0) {
          if (finished) throw new StreamProtocolError('API 在结束标记后继续返回译文');
          if (content.trim()) onContent?.();
          payload.write(content);
        }
        const reason: unknown = choice.finish_reason;
        if (reason === 'length')
          throw new StreamOutputLimitError('API 输出被截断，剩余段落尚未完成');
        if (reason !== undefined && reason !== null) {
          if (reason !== 'stop') throw new StreamProtocolError('API 未正常完成翻译');
          finished = true;
        }
      },
    });

    while (!done) {
      const next = await reader.read();
      signal?.throwIfAborted();
      if (next.done) {
        let tail: string;
        try {
          tail = textDecoder.decode();
        } catch {
          throw new StreamProtocolError('API 流式响应包含无效 UTF-8');
        }
        events.feed(tail);
        if (!done) throw new StreamInterruptedError('API 流式连接提前结束，剩余段落尚未完成');
        break;
      }
      bytes += next.value.byteLength;
      if (bytes > limits.maxStreamBytes) throw new StreamProtocolError('API 流式响应超过大小上限');
      let text: string;
      try {
        text = textDecoder.decode(next.value, { stream: true });
      } catch {
        throw new StreamProtocolError('API 流式响应包含无效 UTF-8');
      }
      events.feed(text);
    }
  } finally {
    signal?.removeEventListener('abort', cancel);
    // Also releases a fetch body that is still open after the protocol end event, malformed output or timeout.
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Validates Messages lifecycle independently from JSON translation payloads. */
class AnthropicEventDecoder {
  private started = false;
  private finished = false;
  private blocks = new Map<number, { type: string; closed: boolean }>();
  consume(chunk: Record<string, unknown>): { text?: string; done?: boolean } {
    const type = chunk.type;
    if (typeof type !== 'string') throw new StreamProtocolError('Anthropic 事件缺少类型');
    if (type === 'ping') return {};
    if (type === 'message_start') {
      if (
        this.started ||
        !isRecord(chunk.message) ||
        chunk.message.role !== 'assistant' ||
        !Array.isArray(chunk.message.content) ||
        chunk.message.content.length
      )
        throw new StreamProtocolError('Anthropic 消息开始事件无效');
      this.started = true;
      return {};
    }
    if (!this.started) throw new StreamProtocolError('Anthropic 缺少消息开始事件');
    if (type === 'message_stop') {
      if (!this.finished || [...this.blocks.values()].some((b) => !b.closed))
        throw new StreamInterruptedError('Anthropic 消息缺少正常结束标记');
      return { done: true };
    }
    if (type === 'message_delta') {
      if (!isRecord(chunk.delta)) throw new StreamProtocolError('Anthropic 消息增量无效');
      const reason = chunk.delta.stop_reason;
      if (reason === 'max_tokens')
        throw new StreamOutputLimitError('API 输出被截断，剩余段落尚未完成');
      if (reason !== undefined && reason !== null) {
        if (
          this.finished ||
          reason !== 'end_turn' ||
          [...this.blocks.values()].some((b) => !b.closed)
        )
          throw new StreamProtocolError('Anthropic 未正常完成翻译');
        this.finished = true;
      }
      return {};
    }
    if (!['content_block_start', 'content_block_delta', 'content_block_stop'].includes(type))
      return {};
    if (
      this.finished ||
      typeof chunk.index !== 'number' ||
      !Number.isInteger(chunk.index) ||
      chunk.index < 0
    )
      throw new StreamProtocolError('Anthropic 内容块位置无效');
    const block = this.blocks.get(chunk.index);
    if (type === 'content_block_start') {
      if (
        block ||
        [...this.blocks.values()].some((b) => !b.closed) ||
        !isRecord(chunk.content_block)
      )
        throw new StreamProtocolError('Anthropic 内容块开始事件无效');
      const content = chunk.content_block;
      if (
        content.type !== 'text' &&
        content.type !== 'thinking' &&
        content.type !== 'redacted_thinking'
      )
        throw new StreamProtocolError('API 未返回翻译内容：返回了工具或不支持的内容块');
      this.blocks.set(chunk.index, { type: content.type, closed: false });
      if (content.type === 'text') {
        if (typeof content.text !== 'string')
          throw new StreamProtocolError('Anthropic 文本内容无效');
        return { text: content.text };
      }
      return {};
    }
    if (!block || block.closed) throw new StreamProtocolError('Anthropic 内容块尚未开始或已结束');
    if (type === 'content_block_stop') {
      block.closed = true;
      return {};
    }
    if (!isRecord(chunk.delta)) throw new StreamProtocolError('Anthropic 内容增量无效');
    if (block.type === 'text') {
      if (chunk.delta.type !== 'text_delta' || typeof chunk.delta.text !== 'string')
        throw new StreamProtocolError('Anthropic 文本增量无效');
      return { text: chunk.delta.text };
    }
    if (chunk.delta.type !== 'thinking_delta' && chunk.delta.type !== 'signature_delta')
      throw new StreamProtocolError('Anthropic 思考增量无效');
    return {};
  }
}

/** Keeps JSON syntax handling in the maintained parser, including strings and escape sequences. */
class TranslationPayloadDecoder {
  private readonly parser = new JSONParser({
    paths: ['$.translations.*', '$.translations', '$'],
    emitPartialTokens: false,
    emitPartialValues: false,
  });
  private prefix = '';
  private started = false;
  private fenced = false;
  private suffix = '';
  private complete = false;
  private characters = 0;

  constructor(
    onItem: (item: StreamTranslationItem) => void,
    private readonly maxCharacters: number,
  ) {
    let depth = 0;
    let translationsFields = 0;
    this.parser.onToken = ({ token }) => {
      if (token === TokenType.LEFT_BRACE || token === TokenType.LEFT_BRACKET) depth += 1;
      if (token === TokenType.RIGHT_BRACE || token === TokenType.RIGHT_BRACKET) depth -= 1;
      if (depth > 16) throw new StreamProtocolError('AI 返回的 JSON 嵌套超过上限');
    };
    this.parser.onError = (error) => {
      if (error instanceof StreamProtocolError) throw error;
      // Parser errors can contain original payload fragments. Never forward them to a webpage.
      throw new StreamProtocolError('AI 未返回有效 JSON');
    };
    this.parser.onValue = ({ value, key, parent, stack }) => {
      if (
        stack.length === 2 &&
        stack[1].key === 'translations' &&
        typeof key === 'number' &&
        Array.isArray(parent)
      ) {
        if (!isRecord(value) || typeof value.id !== 'string' || typeof value.text !== 'string') {
          throw new StreamProtocolError('AI 返回了无效的译文项');
        }
        onItem({ id: value.id, text: value.text });
      } else if (stack.length === 1 && key === 'translations') {
        // Item callbacks are provisional: a second root array must not overwrite their meaning.
        translationsFields += 1;
        if (translationsFields !== 1 || !Array.isArray(value))
          throw new StreamProtocolError('AI 必须返回唯一的 translations 数组');
      } else if (stack.length === 0) {
        if (!isRecord(value) || !Array.isArray(value.translations))
          throw new StreamProtocolError('AI 返回的 translations 格式无效');
        this.complete = true;
      }
    };
  }

  write(content: string): void {
    this.characters += content.length;
    if (this.characters > this.maxCharacters)
      throw new StreamProtocolError('AI 译文 JSON 超过大小上限');
    if (!this.started) {
      this.prefix += content;
      const opening = /^\s*(?:```(?:json)?\s*)?\{/u.exec(this.prefix);
      if (!opening) {
        if (
          this.prefix.length > 64 ||
          !/^\s*(?:`{1,3}(?:j(?:s(?:o(?:n)?)?)?)?\s*)?$/u.test(this.prefix)
        ) {
          throw new StreamProtocolError('AI 返回的 translations JSON 格式无效');
        }
        return;
      }
      this.started = true;
      this.fenced = opening[0].includes('```');
      content = this.prefix.slice(opening[0].length - 1);
      this.prefix = '';
    }
    const text = this.suffix + content;
    this.suffix = '';
    if (this.complete) {
      this.suffix = text;
      if (this.fenced ? !/^\s*`{0,3}\s*$/u.test(text) : text.trim() !== '') {
        throw new StreamProtocolError('AI 在完整 JSON 后返回了额外内容');
      }
      return;
    }
    // Hold only a possible closing Markdown fence; literal backticks within JSON strings
    // are fed back unchanged when their following characters arrive. No JSON is repaired.
    const fence = this.fenced ? /`{1,3}\s*$/u.exec(text) : null;
    this.suffix = fence?.[0] ?? '';
    this.parser.write(fence ? text.slice(0, fence.index) : text);
  }

  finish(): void {
    if (!this.complete || (this.fenced && this.suffix.trim() !== '```')) {
      throw new StreamInterruptedError('AI 返回的译文 JSON 尚未完整结束');
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
