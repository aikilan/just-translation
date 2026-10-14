import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QuickTranslationController } from './quick-translation-controller';
import type { PublicTranslatorSettings, Result, RuntimeRequest } from '../shared/messages';
import { DEFAULT_SETTINGS } from '../shared/settings';

const settings: PublicTranslatorSettings = {
  ...DEFAULT_SETTINGS,
  uiLanguage: 'zh-CN',
  profiles: [{ id: 'ai', name: 'My AI', configured: true, supportsImageInput: false }],
  ready: true,
  supportsFullDocument: false,
};
const result = {
  text: 'translated',
  targetLanguage: 'Simplified Chinese',
  translatorName: 'Google',
};
type QuickTextRequest = Extract<RuntimeRequest, { type: 'TRANSLATE_QUICK_TEXT' }>;
/** The background answers per slice; a single slice reads like the old one-shot result. */
function sliceResult(
  request: QuickTextRequest,
  text: (source: string) => string = () => 'translated',
) {
  return {
    ok: true as const,
    data: {
      translations: Object.fromEntries(request.slices.map((slice) => [slice.id, text(slice.text)])),
      failures: {},
      targetLanguage: result.targetLanguage,
      translatorName: result.translatorName,
    },
  };
}
const fixed = (request: RuntimeRequest, text: string) =>
  sliceResult(request as QuickTextRequest, () => text);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let model: QuickTranslationController;
let send: ReturnType<typeof vi.fn<(request: RuntimeRequest) => Promise<Result<unknown>>>>;
let clipboard: {
  readText: ReturnType<typeof vi.fn<() => Promise<string>>>;
  writeText: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;
};
beforeEach(() => {
  send = vi.fn((request) =>
    Promise.resolve(
      request.type === 'GET_PUBLIC_SETTINGS'
        ? { ok: true, data: settings }
        : request.type === 'TRANSLATE_QUICK_TEXT'
          ? sliceResult(request)
          : { ok: true, data: undefined },
    ),
  );
  clipboard = {
    readText: vi.fn().mockResolvedValue('pasted\ntext'),
    writeText: vi.fn().mockResolvedValue(undefined),
  };
  model = new QuickTranslationController(send, clipboard);
});
afterEach(() => vi.unstubAllGlobals());

describe('quick translation state and ownership', () => {
  it('submits and cancels distinct requests on HTTP without crypto.randomUUID, including after recreation', async () => {
    vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) });
    await model.open();
    model.setSource('completed');
    await model.translate();
    expect(model.getSnapshot().phase).toBe('success');
    model.setSource('first');
    const pending = deferred<Result<unknown>>();
    send.mockReturnValueOnce(pending.promise);
    const first = model.translate();
    const firstRequest = send.mock.calls
      .map(([request]) => request)
      .filter((request) => request.type === 'TRANSLATE_QUICK_TEXT')
      .find((request) => request.slices[0].text === 'first');
    expect(firstRequest).toBeDefined();
    expect(model.getSnapshot().phase).toBe('loading');
    model.close();
    expect(send).toHaveBeenLastCalledWith({
      type: 'CANCEL_QUICK_TRANSLATION',
      requestId: firstRequest?.requestId,
    });
    const reopened = new QuickTranslationController(send, clipboard);
    await reopened.open();
    reopened.setSource('second');
    await reopened.translate();
    const requests = send.mock.calls
      .map(([request]) => request)
      .filter((request) => request.type === 'TRANSLATE_QUICK_TEXT');
    expect(requests).toHaveLength(3);
    expect(requests.every((request) => Boolean(request.requestId))).toBe(true);
    expect(new Set(requests.map((request) => request.requestId)).size).toBe(3);
    expect(reopened.getSnapshot().phase).toBe('success');
    pending.resolve(fixed(firstRequest!, 'stale result'));
    await first;
    expect(model.getSnapshot().result).toBeUndefined();
    expect(reopened.getSnapshot().result).toEqual(result);
  });

  it('opens empty without translating or reading the clipboard; only explicit submit sends text', async () => {
    await model.open();
    expect(model.getSnapshot()).toMatchObject({
      open: true,
      source: '',
      phase: 'idle',
      targetLanguage: settings.targetLanguage,
    });
    expect(clipboard.readText).not.toHaveBeenCalled();
    await model.translate();
    model.setSource('  First\nSecond  ');
    expect(send.mock.calls).toHaveLength(1);
    await model.translate();
    expect(send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'TRANSLATE_QUICK_TEXT',
        slices: [{ id: 's0', text: 'First\nSecond' }],
        translator: settings.activeTranslator,
        targetLanguage: settings.targetLanguage,
      }),
    );
    // Whitespace around the text never reaches the provider and is restored in the result.
    expect(model.getSnapshot()).toMatchObject({
      phase: 'success',
      result: { ...result, text: '  translated  ' },
    });
  });

  it('locks before awaiting, cancels on close, and ignores a late result after reopen', async () => {
    await model.open();
    const first = deferred<Result<unknown>>();
    const second = deferred<Result<unknown>>();
    send.mockImplementation((request) =>
      request.type === 'GET_PUBLIC_SETTINGS'
        ? Promise.resolve({ ok: true, data: settings })
        : request.type === 'TRANSLATE_QUICK_TEXT'
          ? request.slices[0].text === 'first'
            ? first.promise
            : second.promise
          : Promise.resolve({ ok: true, data: undefined }),
    );
    model.setSource('first');
    const old = model.translate();
    await model.translate();
    expect(send.mock.calls.filter(([r]) => r.type === 'TRANSLATE_QUICK_TEXT')).toHaveLength(1);
    const id = send.mock.calls.find(([r]) => r.type === 'TRANSLATE_QUICK_TEXT')![0];
    model.close();
    expect(send).toHaveBeenLastCalledWith({
      type: 'CANCEL_QUICK_TRANSLATION',
      requestId: 'requestId' in id ? id.requestId : '',
    });
    await model.open();
    expect(model.getSnapshot().source).toBe('first');
    model.setSource('second');
    const current = model.translate();
    const request = (text: string) =>
      send.mock.calls
        .map(([sent]) => sent)
        .find((sent) => sent.type === 'TRANSLATE_QUICK_TEXT' && sent.slices[0].text === text)!;
    second.resolve(fixed(request('second'), 'new result'));
    await current;
    first.resolve(fixed(request('first'), 'stale result'));
    await old;
    expect(model.getSnapshot().result?.text).toBe('new result');
  });

  it('preserves successful drafts across close, but invalidates results on text or local preference edits', async () => {
    await model.open();
    model.setSource('source');
    await model.translate();
    model.close();
    await model.open();
    expect(model.getSnapshot().result?.text).toBe('translated');
    model.setTargetLanguage('Japanese');
    expect(model.getSnapshot()).toMatchObject({ phase: 'idle', targetLanguage: 'Japanese' });
    expect(model.getSnapshot().result).toBeUndefined();
    model.setTranslator({ kind: 'ai', profileId: 'ai' });
    await model.translate();
    expect(send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'TRANSLATE_QUICK_TEXT',
        targetLanguage: 'Japanese',
        translator: { kind: 'ai', profileId: 'ai' },
      }),
    );
    model.setSource('changed');
    expect(model.getSnapshot().result).toBeUndefined();
    expect(
      send.mock.calls.every(
        ([r]) => !['SET_ACTIVE_TRANSLATOR', 'UPDATE_READING_PREFERENCES'].includes(r.type),
      ),
    ).toBe(true);
  });

  it('preserves input on failure, retries with a fresh ID, and rejects malformed results', async () => {
    await model.open();
    model.setSource('source');
    send.mockResolvedValueOnce({ ok: false, error: { text: 'Network failed' } });
    await model.translate();
    expect(model.getSnapshot()).toMatchObject({
      phase: 'error',
      source: 'source',
      error: { text: 'Network failed' },
    });
    await model.translate();
    expect(model.getSnapshot().phase).toBe('success');
    const requests = send.mock.calls
      .map(([r]) => r)
      .filter((r) => r.type === 'TRANSLATE_QUICK_TEXT');
    expect(requests[0].requestId).not.toBe(requests[1].requestId);
    send.mockResolvedValueOnce({ ok: true, data: { text: 'incomplete' } });
    await model.translate();
    expect(model.getSnapshot().phase).toBe('error');
  });

  it('keeps typed edits when an earlier clipboard read completes and ignores reads after closing', async () => {
    await model.open();
    const read = deferred<string>();
    clipboard.readText.mockReturnValue(read.promise);
    const pasted = model.paste();
    model.setSource('typed while waiting');
    read.resolve('stale clipboard');
    await pasted;
    expect(model.getSnapshot().source).toBe('typed while waiting');
    const late = deferred<string>();
    clipboard.readText.mockReturnValue(late.promise);
    const work = model.paste();
    model.close();
    await model.open();
    late.resolve('wrong session');
    await work;
    expect(model.getSnapshot().source).toBe('typed while waiting');
  });

  it('pastes and copies only on request, and preserves result when clipboard writes fail', async () => {
    await model.open();
    await model.paste();
    expect(model.getSnapshot().source).toBe('pasted\ntext');
    await model.translate();
    await model.copy();
    expect(clipboard.writeText).toHaveBeenCalledWith('translated');
    expect(model.getSnapshot().feedback).toEqual({ key: '已复制译文' });
    clipboard.writeText.mockRejectedValueOnce(new Error('denied'));
    await model.copy();
    expect(model.getSnapshot().result?.text).toBe('translated');
    expect(model.getSnapshot().feedback).toEqual({ key: '复制失败，请手动选择复制译文' });
  });

  it('does not let a closed settings read overwrite the next opening or erase typed drafts', async () => {
    const first = deferred<Result<unknown>>();
    send.mockReturnValueOnce(first.promise);
    const opening = model.open();
    model.setSource('draft');
    model.close();
    await model.open();
    first.resolve({ ok: true, data: { ...settings, targetLanguage: 'Arabic' } });
    await opening;
    expect(model.getSnapshot()).toMatchObject({
      source: 'draft',
      targetLanguage: settings.targetLanguage,
    });
  });

  it('serializes clipboard operations so a pending copy cannot leave paste controls locked', async () => {
    await model.open();
    model.setSource('source');
    await model.translate();
    const write = deferred<void>();
    clipboard.writeText.mockReturnValue(write.promise);
    const copying = model.copy();
    await model.paste();
    expect(clipboard.readText).not.toHaveBeenCalled();
    write.resolve();
    await copying;
    expect(model.getSnapshot()).toMatchObject({ pasting: false, copying: false });
    const read = deferred<string>();
    clipboard.readText.mockReturnValue(read.promise);
    const pasting = model.paste();
    await model.copy();
    expect(clipboard.writeText).toHaveBeenCalledTimes(1);
    read.resolve('new text');
    await pasting;
    expect(model.getSnapshot()).toMatchObject({
      pasting: false,
      copying: false,
      source: 'new text',
    });
  });

  describe('slices', () => {
    const paragraphs = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.';
    const requests = () =>
      send.mock.calls
        .map(([request]) => request)
        .filter((request): request is QuickTextRequest => request.type === 'TRANSLATE_QUICK_TEXT');

    it('shows finished slices in reading order while the rest is still translating', async () => {
      await model.open();
      model.setSource(paragraphs);
      const pending = deferred<Result<unknown>>();
      send.mockReturnValueOnce(pending.promise);
      const work = model.translate();
      const [request] = requests();
      expect(request.slices.map((slice) => slice.id)).toEqual(['s0', 's1', 's2']);
      expect(model.getSnapshot().progress).toEqual({ done: 0, total: 3 });

      // A later slice alone is not shown before the earlier one arrives.
      model.receiveProgress({
        type: 'QUICK_TRANSLATION_PROGRESS',
        requestId: request.requestId,
        translations: { s1: '第二段。' },
      });
      expect(model.getSnapshot()).toMatchObject({ partial: undefined, progress: { done: 1 } });
      model.receiveProgress({
        type: 'QUICK_TRANSLATION_PROGRESS',
        requestId: 'another-request',
        translations: { s0: '错误的请求' },
      });
      expect(model.getSnapshot().progress).toEqual({ done: 1, total: 3 });
      model.receiveProgress({
        type: 'QUICK_TRANSLATION_PROGRESS',
        requestId: request.requestId,
        translations: { s0: '第一段。' },
      });
      expect(model.getSnapshot().partial).toBe('第一段。\n\n第二段。\n\n');

      pending.resolve(sliceResult(request, (text) => `译：${text}`));
      await work;
      expect(model.getSnapshot()).toMatchObject({
        phase: 'success',
        partial: undefined,
        progress: undefined,
        incomplete: undefined,
        result: {
          text: '译：First paragraph.\n\n译：Second paragraph.\n\n译：Third paragraph.',
        },
      });
    });

    it('keeps finished slices when others fail and retries only the failed ones', async () => {
      await model.open();
      model.setSource(paragraphs);
      send.mockImplementationOnce(() =>
        Promise.resolve({
          ok: true,
          data: {
            translations: { s0: '第一段。', s2: '第三段。' },
            failures: { s1: { text: 'HTTP 504' } },
            targetLanguage: result.targetLanguage,
            translatorName: result.translatorName,
          },
        }),
      );
      await model.translate();
      expect(model.getSnapshot()).toMatchObject({
        phase: 'success',
        result: { text: '第一段。\n\nSecond paragraph.\n\n第三段。' },
        incomplete: { failed: 1, error: { text: 'HTTP 504' } },
      });

      await model.retryFailed();
      const retry = requests()[1];
      expect(retry.slices).toEqual([{ id: 's1', text: 'Second paragraph.' }]);
      expect(model.getSnapshot()).toMatchObject({
        phase: 'success',
        incomplete: undefined,
        result: { text: '第一段。\n\ntranslated\n\n第三段。' },
      });
      await model.retryFailed();
      expect(requests()).toHaveLength(2);
    });

    it('reports an error only when no slice was translated', async () => {
      await model.open();
      model.setSource(paragraphs);
      send.mockResolvedValueOnce({
        ok: true,
        data: {
          translations: {},
          failures: { s0: { text: 'timeout' }, s1: { text: 'timeout' }, s2: { text: 'timeout' } },
          targetLanguage: result.targetLanguage,
          translatorName: result.translatorName,
        },
      });
      await model.translate();
      expect(model.getSnapshot()).toMatchObject({ phase: 'error', error: { text: 'timeout' } });
    });

    it('keeps slices finished before stopping and offers the rest as a retry', async () => {
      await model.open();
      model.setSource(paragraphs);
      const pending = deferred<Result<unknown>>();
      send.mockReturnValueOnce(pending.promise);
      const work = model.translate();
      const [request] = requests();
      model.receiveProgress({
        type: 'QUICK_TRANSLATION_PROGRESS',
        requestId: request.requestId,
        translations: { s0: '第一段。' },
      });
      model.stop();
      expect(send).toHaveBeenLastCalledWith({
        type: 'CANCEL_QUICK_TRANSLATION',
        requestId: request.requestId,
      });
      expect(model.getSnapshot()).toMatchObject({
        phase: 'success',
        result: { text: '第一段。\n\nSecond paragraph.\n\nThird paragraph.' },
        incomplete: { failed: 2, error: { key: '翻译已停止' } },
      });
      pending.resolve(sliceResult(request));
      await work;
      expect(model.getSnapshot().result?.text).toBe(
        '第一段。\n\nSecond paragraph.\n\nThird paragraph.',
      );
    });
  });
});
