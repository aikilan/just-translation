import { LocalizedError, message } from './i18n';

/** A single bounded image crosses Chrome's JSON message boundary; filenames are never sent. */
export interface ImageInput {
  mediaType: 'image/png' | 'image/jpeg';
  data: string;
  width: number;
  height: number;
}
export const MAX_IMAGE_BYTES = 4 * 1_048_576;
export const MAX_IMAGE_DIMENSION = 4096;
const MAX_IMAGE_PIXELS = 16_000_000;
const MAX_BASE64_LENGTH = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;

export function imageDataUrl(image: ImageInput): string {
  return `data:${image.mediaType};base64,${image.data}`;
}

/** Decode locally before preview. WebP is normalized to PNG for all configured protocols. */
export async function prepareImageInput(file: Blob): Promise<ImageInput> {
  assertSize(file.size);
  let bytes = new Uint8Array(await file.arrayBuffer());
  let mediaType = detectType(bytes);
  if (!mediaType) throw invalidImage();
  const bitmap = await decode(new Blob([bytes], { type: mediaType }));
  try {
    assertDimensions(bitmap.width, bitmap.height);
    if (mediaType === 'image/webp') {
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d');
      if (!context) throw invalidImage();
      context.drawImage(bitmap, 0, 0);
      const normalized = await canvas.convertToBlob({ type: 'image/png' });
      assertSize(normalized.size);
      bytes = new Uint8Array(await normalized.arrayBuffer());
      mediaType = 'image/png';
    }
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 32_768)
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
    return { mediaType, data: btoa(binary), width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close();
  }
}

/** Revalidate untrusted content-script bytes in the worker; never trust supplied dimensions/MIME. */
export async function validateImageInput(value: unknown): Promise<ImageInput> {
  if (
    !value ||
    typeof value !== 'object' ||
    !('mediaType' in value) ||
    !['image/png', 'image/jpeg'].includes(String(value.mediaType)) ||
    !('data' in value) ||
    typeof value.data !== 'string' ||
    !('width' in value) ||
    typeof value.width !== 'number' ||
    !('height' in value) ||
    typeof value.height !== 'number'
  )
    throw invalidImage();
  if (value.data.length > MAX_BASE64_LENGTH) throw oversizedImage();
  if (!value.data || value.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value.data))
    throw invalidImage();
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = Uint8Array.from(atob(value.data), (character) => character.charCodeAt(0));
  } catch {
    throw invalidImage();
  }
  assertSize(bytes.length);
  const mediaType = detectType(bytes);
  if (mediaType !== value.mediaType || mediaType === 'image/webp' || !mediaType)
    throw invalidImage();
  assertDimensions(value.width, value.height);
  const bitmap = await decode(new Blob([bytes], { type: mediaType }));
  try {
    assertDimensions(bitmap.width, bitmap.height);
    if (bitmap.width !== value.width || bitmap.height !== value.height) throw invalidImage();
    return { mediaType, data: value.data, width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close();
  }
}

function detectType(bytes: Uint8Array): ImageInput['mediaType'] | 'image/webp' | undefined {
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte))
    return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP'
  )
    return 'image/webp';
  return undefined;
}
function assertSize(size: number): void {
  if (size > MAX_IMAGE_BYTES) throw oversizedImage();
  if (!size) throw invalidImage();
}
function assertDimensions(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1)
    throw invalidImage();
  if (
    width > MAX_IMAGE_DIMENSION ||
    height > MAX_IMAGE_DIMENSION ||
    width * height > MAX_IMAGE_PIXELS
  )
    throw new LocalizedError(
      message('图片尺寸过大，请使用边长不超过 4096 像素、总像素不超过 1600 万的图片'),
    );
}
async function decode(blob: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(blob);
  } catch {
    throw invalidImage();
  }
}
function invalidImage(): LocalizedError {
  return new LocalizedError(message('图片无法读取，请选择有效的 PNG、JPEG 或 WebP 图片'));
}
function oversizedImage(): LocalizedError {
  return new LocalizedError(message('图片大小不能超过 4 MiB（WebP 转换后的大小也计入）'));
}
