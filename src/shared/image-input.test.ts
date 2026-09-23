import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_IMAGE_BYTES,
  MAX_IMAGE_DIMENSION,
  prepareImageInput,
  validateImageInput,
} from './image-input';

const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
let close: ReturnType<typeof vi.fn>;
let decode: ReturnType<typeof vi.fn>;
beforeEach(() => {
  close = vi.fn();
  decode = vi.fn().mockResolvedValue({ width: 640, height: 480, close });
  vi.stubGlobal('createImageBitmap', decode);
});
afterEach(() => vi.unstubAllGlobals());

describe('bounded browser image input', () => {
  it('decodes actual bytes and produces a JSON-safe payload without uploading anything', async () => {
    const image = await prepareImageInput(new Blob([png], { type: 'image/png' }));
    expect(image).toEqual({
      mediaType: 'image/png',
      data: btoa(String.fromCharCode(...png)),
      width: 640,
      height: 480,
    });
    expect(close).toHaveBeenCalledOnce();
    await expect(validateImageInput(JSON.parse(JSON.stringify(image)))).resolves.toEqual(image);
  });
  it('rejects oversized or unsupported files before decoding', async () => {
    await expect(
      prepareImageInput(new Blob(['not an image'], { type: 'image/png' })),
    ).rejects.toThrow('图片');
    await expect(
      prepareImageInput(new Blob([new Uint8Array(MAX_IMAGE_BYTES + 1)])),
    ).rejects.toThrow('4 MiB');
    expect(decode).not.toHaveBeenCalled();
  });
  it('rejects oversized runtime message bytes before allocating or decoding the image', async () => {
    await expect(
      validateImageInput({
        mediaType: 'image/png',
        data: 'A'.repeat(Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4),
        width: 1,
        height: 1,
      }),
    ).rejects.toThrow('4 MiB');
    expect(decode).not.toHaveBeenCalled();
  });
  it('rejects a failed decode, excessive dimensions, and forged background metadata', async () => {
    decode.mockRejectedValueOnce(new Error('decode failed'));
    await expect(prepareImageInput(new Blob([png]))).rejects.toThrow('图片');
    decode.mockResolvedValueOnce({ width: MAX_IMAGE_DIMENSION + 1, height: 1, close });
    await expect(prepareImageInput(new Blob([png]))).rejects.toThrow('尺寸');
    expect(close).toHaveBeenCalledOnce();
    const image = await prepareImageInput(new Blob([png]));
    await expect(validateImageInput({ ...image, width: 1 })).rejects.toThrow('图片');
    await expect(validateImageInput({ ...image, mediaType: 'image/jpeg' })).rejects.toThrow('图片');
    await expect(validateImageInput({ ...image, data: 'not base64' })).rejects.toThrow('图片');
  });
  it('normalizes WebP to PNG for protocols that only accept JPEG and PNG', async () => {
    const webp = Uint8Array.from([82, 73, 70, 70, 4, 0, 0, 0, 87, 69, 66, 80]);
    const drawImage = vi.fn();
    const convertToBlob = vi.fn().mockResolvedValue(new Blob([png], { type: 'image/png' }));
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        getContext() {
          return { drawImage };
        }
        convertToBlob = convertToBlob;
      },
    );
    const result = await prepareImageInput(new Blob([webp], { type: 'image/webp' }));
    expect(result.mediaType).toBe('image/png');
    expect(drawImage).toHaveBeenCalledOnce();
    expect(convertToBlob).toHaveBeenCalledWith({ type: 'image/png' });
    expect(close).toHaveBeenCalledOnce();
  });
});
