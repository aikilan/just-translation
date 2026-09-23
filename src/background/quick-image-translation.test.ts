import { afterEach, describe, expect, it, vi } from 'vitest';
import { TranslationTaskService } from './translation-task';
import { DEFAULT_SETTINGS } from '../shared/settings';
import { TEST_PROFILE } from '../test-utils/provider';
import { translateImage } from '../shared/image-translation-client';
import { validateImageInput } from '../shared/image-input';

vi.mock('../shared/image-translation-client', () => ({ translateImage: vi.fn() }));
vi.mock('../shared/image-input', () => ({ validateImageInput: vi.fn() }));
const image = { mediaType: 'image/png' as const, data: 'iVBORw0KGgo=', width: 10, height: 10 };
const sender = {
  tab: { id: 7 },
  frameId: 2,
  documentId: 'doc',
  url: 'https://site.test/frame',
} as chrome.runtime.MessageSender;
const settings = {
  ...DEFAULT_SETTINGS,
  profiles: [
    { ...TEST_PROFILE, model: 'vision', imageInputEnabled: true, apiKey: 'image-test-secret' },
  ],
};
function setup(read = () => Promise.resolve(settings)) {
  vi.mocked(validateImageInput).mockResolvedValue(image);
  vi.mocked(translateImage).mockResolvedValue({ status: 'translated', text: '译文' });
  return new TranslationTaskService(read, () => Promise.resolve({ documentId: 'doc' }));
}
afterEach(() => vi.clearAllMocks());

describe('trusted quick image tasks', () => {
  it('uses the locally selected profile even when the global engine is text-only', async () => {
    const service = setup();
    const before = structuredClone(settings);
    expect(
      await service.translateQuickImage(
        sender,
        '1',
        '',
        image,
        { kind: 'ai', profileId: TEST_PROFILE.id },
        'Japanese',
      ),
    ).toEqual({
      status: 'translated',
      text: '译文',
      targetLanguage: 'Japanese',
      translatorName: TEST_PROFILE.name,
    });
    expect(translateImage).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'image-test-secret', targetLanguage: 'Japanese' }),
      '',
      image,
      expect.any(Function),
      expect.any(AbortSignal),
      expect.objectContaining({ scheduleAttempt: expect.any(Function) as unknown }),
    );
    expect(settings).toEqual(before);
  });
  it('rejects unsupported stored capabilities before decoding or issuing HTTP', async () => {
    const service = setup(() =>
      Promise.resolve({
        ...settings,
        profiles: [{ ...settings.profiles[0], imageInputEnabled: false }],
      }),
    );
    await expect(
      service.translateQuickImage(
        sender,
        '1',
        '',
        image,
        { kind: 'ai', profileId: TEST_PROFILE.id },
        'Chinese',
      ),
    ).rejects.toThrow('图片');
    await expect(
      service.translateQuickImage(
        sender,
        '2',
        '',
        image,
        { kind: 'builtin', engine: 'google-free' },
        'Chinese',
      ),
    ).rejects.toThrow('图片');
    expect(validateImageInput).not.toHaveBeenCalled();
    expect(translateImage).not.toHaveBeenCalled();
  });
  it('cancels preflight and prevents a closed or navigated document from sending images', async () => {
    let finish!: (value: typeof settings) => void;
    const service = setup(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = service.translateQuickImage(
      sender,
      '1',
      '',
      image,
      { kind: 'ai', profileId: TEST_PROFILE.id },
      'Chinese',
    );
    const rejected = expect(pending).rejects.toThrow();
    service.cancel(sender, '1', 'quick');
    finish(settings);
    await rejected;
    expect(translateImage).not.toHaveBeenCalled();
  });
  it('passes through an empty recognition result without treating it as a successful translation', async () => {
    const service = setup();
    vi.mocked(translateImage).mockResolvedValue({ status: 'no-text', text: '' });
    expect(
      await service.translateQuickImage(
        sender,
        '1',
        '',
        image,
        { kind: 'ai', profileId: TEST_PROFILE.id },
        'Chinese',
      ),
    ).toMatchObject({ status: 'no-text', text: '' });
  });
  it('prevents an image decoded after navigation from reaching the provider', async () => {
    const service = setup();
    let decoded!: (value: typeof image) => void;
    vi.mocked(validateImageInput).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          decoded = resolve;
        }),
    );
    const pending = service.translateQuickImage(
      sender,
      'navigation',
      '',
      image,
      { kind: 'ai', profileId: TEST_PROFILE.id },
      'Japanese',
    );
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(decoded).toBeDefined());
    service.navigate(7, 0, 'new-document');
    decoded(image);
    await rejected;
    expect(translateImage).not.toHaveBeenCalled();
  });
});
