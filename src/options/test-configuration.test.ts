import { TEST_PROFILE } from '../test-utils/provider';
import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_SETTINGS } from '../shared/settings';
import { testTranslatorConfiguration } from './test-configuration';
import { completionResponse } from '../test-utils/sse';

describe('testTranslatorConfiguration', () => {
  it('uses the unsaved thinking preference for the MiMo connection probe', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(completionResponse([{ id: 'connection:0', text: '早上好。' }]));
    await testTranslatorConfiguration(
      {
        ...TEST_PROFILE,
        provider: 'mimo',
          apiUrl: 'https://api.xiaomimimo.com/v1',
        model: 'mimo-v2.5',
        thinkingEnabled: false,
      },
      DEFAULT_SETTINGS.targetLanguage,
      fetcher,
    );
    expect(JSON.parse(fetcher.mock.calls[0][1]?.body as string)).toMatchObject({
      thinking: { type: 'disabled' },
    });
  });
  it('calls the provider directly and returns a genuine translated probe', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(completionResponse([{ id: 'connection:0', text: '早上好。' }]));

    await expect(
      testTranslatorConfiguration(
        {
          ...TEST_PROFILE,
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
          ...TEST_PROFILE,
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
