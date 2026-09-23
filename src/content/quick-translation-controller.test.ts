import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QuickTranslationController } from './quick-translation-controller';
import type { PublicTranslatorSettings, Result, RuntimeRequest } from '../shared/messages';
import { DEFAULT_SETTINGS } from '../shared/settings';

const settings: PublicTranslatorSettings = {
  ...DEFAULT_SETTINGS,
  uiLanguage: 'zh-CN',
  profiles: [{ id: 'ai', name: 'My AI', configured: true }],
  ready: true,
  supportsFullDocument: false,
};
const result = {
  text: 'translated',
  targetLanguage: 'Simplified Chinese',
  translatorName: 'Google',
};
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
        : { ok: true, data: result },
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
      .find((request) => request.text === 'first');
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
    pending.resolve({ ok: true, data: { ...result, text: 'stale result' } });
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
        text: '  First\nSecond  ',
        translator: settings.activeTranslator,
        targetLanguage: settings.targetLanguage,
      }),
    );
    expect(model.getSnapshot()).toMatchObject({ phase: 'success', result });
  });

  it('locks before awaiting, cancels on close, and ignores a late result after reopen', async () => {
    await model.open();
    const first = deferred<Result<unknown>>();
    const second = deferred<Result<unknown>>();
    send.mockImplementation((request) =>
      request.type === 'GET_PUBLIC_SETTINGS'
        ? Promise.resolve({ ok: true, data: settings })
        : request.type === 'TRANSLATE_QUICK_TEXT'
          ? request.text === 'first'
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
    second.resolve({ ok: true, data: { ...result, text: 'new result' } });
    await current;
    first.resolve({ ok: true, data: { ...result, text: 'stale result' } });
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
});
