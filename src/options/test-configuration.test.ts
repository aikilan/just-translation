import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_SETTINGS } from '../shared/settings';
import { testTranslatorConfiguration } from './test-configuration';
import { completionResponse } from '../test-utils/sse';

describe('testTranslatorConfiguration', () => {
  it('calls the provider directly and returns a genuine translated probe', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(completionResponse([{ id: 'connection:0', text: '早上好。' }]));

    await expect(
      testTranslatorConfiguration(
        {
          ...DEFAULT_SETTINGS.profiles[0],
          apiUrl: 'https://api.deepseek.com/chat/completions',
          apiKey: 'secret',
          model: 'deepseek-v4-flash',
        },
        DEFAULT_SETTINGS.targetLanguage,
        fetcher,
      ),
    ).resolves.toBe('早上好。');
    expect(fetcher).toHaveBeenCalledOnce();
    const body = fetcher.mock.calls[0][1]?.body;
    expect(JSON.parse(typeof body === 'string' ? body : '{}')).toMatchObject({ stream: true });
  });

  it('preserves the provider HTTP error so the UI can show the real failure reason', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() =>
      Promise.resolve(
        new Response('{"error":{"message":"Authentication failed"}}', {
          status: 401,
          statusText: 'Unauthorized',
        }),
      ),
    );

    await expect(
      testTranslatorConfiguration(
        {
          ...DEFAULT_SETTINGS.profiles[0],
          apiUrl: 'https://api.deepseek.com/chat/completions',
          apiKey: 'secret',
          model: 'deepseek-v4-flash',
        },
        DEFAULT_SETTINGS.targetLanguage,
        fetcher,
      ),
    ).rejects.toThrow(/401 Unauthorized.*Authentication failed/u);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
