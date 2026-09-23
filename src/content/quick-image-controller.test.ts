import { describe, expect, it, vi } from 'vitest';
import { QuickTranslationController } from './quick-translation-controller';
import { DEFAULT_SETTINGS } from '../shared/settings';
import type { RuntimeRequest, Result } from '../shared/messages';
import type { ImageInput } from '../shared/image-input';

const image: ImageInput = { mediaType: 'image/png', data: 'iVBORw0KGgo=', width: 10, height: 10 };
const settings = {
  ...DEFAULT_SETTINGS,
  ready: true,
  supportsFullDocument: false,
  profiles: [
    { id: 'vision', name: 'Vision', configured: true, supportsImageInput: true },
    { id: 'text', name: 'Text', configured: true, supportsImageInput: false },
  ],
};
function setup(prepare = vi.fn().mockResolvedValue(image)) {
  const send = vi
    .fn<(request: RuntimeRequest) => Promise<Result<unknown>>>()
    .mockImplementation((request) =>
      Promise.resolve({
        ok: true,
        data:
          request.type === 'GET_PUBLIC_SETTINGS'
            ? settings
            : {
                status: 'translated',
                text: '译文',
                targetLanguage: 'Chinese',
                translatorName: 'Vision',
              },
      }),
    );
  const model = new QuickTranslationController(
    send,
    { readText: vi.fn(), writeText: vi.fn() },
    prepare,
  );
  return { model, send, prepare };
}
describe('quick translation image state', () => {
  it('rejects an image-only empty-result envelope for a text task', async () => {
    const { model, send } = setup();
    await model.open();
    model.setTranslator({ kind: 'ai', profileId: 'text' });
    model.setSource('Hello');
    send.mockResolvedValueOnce({
      ok: true,
      data: { status: 'no-text', text: '', targetLanguage: 'Chinese', translatorName: 'Text' },
    });
    await model.translate();
    expect(model.getSnapshot().phase).toBe('error');
  });
  it('uses the local selection for upload gating, previews locally, and sends image-only input on submit', async () => {
    const { model, send } = setup();
    await model.open();
    expect(model.supportsImageInput).toBe(false);
    model.setTranslator({ kind: 'ai', profileId: 'vision' });
    expect(model.supportsImageInput).toBe(true);
    await model.setImage(new Blob());
    expect(send).toHaveBeenCalledTimes(1);
    expect(model.canTranslate).toBe(true);
    await model.translate();
    expect(send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'TRANSLATE_QUICK_IMAGE',
        text: '',
        image,
        translator: { kind: 'ai', profileId: 'vision' },
      }),
    );
  });
  it('retains the attachment and blocks submission after switching to a text-only model', async () => {
    const { model, send } = setup();
    await model.open();
    model.setTranslator({ kind: 'ai', profileId: 'vision' });
    model.setSource('source');
    await model.setImage(new Blob());
    model.setTranslator({ kind: 'ai', profileId: 'text' });
    expect(model.supportsImageInput).toBe(false);
    expect(model.getSnapshot().image).toEqual(image);
    expect(model.canTranslate).toBe(false);
    await model.translate();
    expect(send).toHaveBeenCalledTimes(1);
    model.removeImage();
    expect(model.canTranslate).toBe(true);
  });
  it('discards a late decode after closing, removing, or replacing an image', async () => {
    let finish!: (image: ImageInput) => void;
    const prepare = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue({ ...image, width: 20 });
    const { model } = setup(prepare);
    await model.open();
    model.setTranslator({ kind: 'ai', profileId: 'vision' });
    const old = model.setImage(new Blob());
    expect(model.getSnapshot().imageLoading).toBe(true);
    model.close();
    await model.open();
    await model.setImage(new Blob());
    finish(image);
    await old;
    expect(model.getSnapshot().image?.width).toBe(20);
    model.removeImage();
    expect(model.getSnapshot().image).toBeUndefined();
  });
  it('keeps no-text recognition as an explicit empty state', async () => {
    const { model, send } = setup();
    await model.open();
    model.setTranslator({ kind: 'ai', profileId: 'vision' });
    await model.setImage(new Blob());
    send.mockResolvedValueOnce({
      ok: true,
      data: { status: 'no-text', text: '', targetLanguage: 'Chinese', translatorName: 'Vision' },
    });
    await model.translate();
    expect(model.getSnapshot()).toMatchObject({
      phase: 'success',
      result: { status: 'no-text', text: '' },
    });
  });
});
