import { TEST_PROFILE } from '../test-utils/provider';
import { describe, expect, it, vi } from 'vitest';
import { completionResponse } from '../test-utils/sse';
import { translateBatch, translateFullDocument } from './translation-client';
import { DEFAULT_SETTINGS, mergeSettings } from './settings';

describe('profile thinking preference', () => {
  it.each([undefined, null, 'false', 0])('defaults unset or invalid %s to disabled', (value) => {
    expect(DEFAULT_SETTINGS.profiles[0].thinkingEnabled).toBe(false);
    expect(
      mergeSettings({ profiles: [{ ...TEST_PROFILE, thinkingEnabled: value }] }).profiles[0]
        .thinkingEnabled,
    ).toBe(false);
  });

  it('keeps disabled thinking independent between profiles', () => {
    expect(
      mergeSettings({
        profiles: [
          { ...TEST_PROFILE, thinkingEnabled: false },
          { ...TEST_PROFILE, id: 'other', thinkingEnabled: true },
        ],
      }).profiles.map((profile) => profile.thinkingEnabled),
    ).toEqual([false, true]);
  });

  it.each([true, false])(
    'sends MiMo thinking=%s for segmented, retry and full-document requests',
    async (thinkingEnabled) => {
      const settings = {
        ...TEST_PROFILE,
        provider: 'mimo' as const,
        apiUrl: 'https://api.xiaomimimo.com/v1',
        model: 'mimo-v2.5',
        targetLanguage: 'Chinese',
        thinkingEnabled,
      };
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response('', { status: 503 }))
        .mockImplementation(() => Promise.resolve(completionResponse([{ id: 'a', text: '你好' }])));
      await translateBatch(
        settings,
        [{ requestId: 'a', unitId: 'a', partIndex: 0, text: 'Hello' }],
        fetcher,
        undefined,
        { maxRetries: 1, baseRetryDelayMs: 0 },
      );
      await translateFullDocument(settings, [{ id: 'a', text: 'Hello' }], fetcher);
      expect(fetcher).toHaveBeenCalledTimes(3);
      for (const [, init] of fetcher.mock.calls) {
        expect(JSON.parse(init?.body as string)).toMatchObject({
          thinking: { type: thinkingEnabled ? 'enabled' : 'disabled' },
          stream: true,
        });
      }
    },
  );

  it.each(['https://api.openai.com/v1', 'https://api.xiaomimimo.com.example.org/v1'])(
    'does not send MiMo parameters to %s',
    async (apiUrl) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(completionResponse([{ id: 'a', text: '你好' }]));
      await translateBatch(
        {
          ...TEST_PROFILE,
          apiUrl,
          model: 'test',
          targetLanguage: 'Chinese',
          thinkingEnabled: false,
        },
        [{ requestId: 'a', unitId: 'a', partIndex: 0, text: 'Hello' }],
        fetcher,
      );
      expect(JSON.parse(fetcher.mock.calls[0][1]?.body as string)).not.toHaveProperty('thinking');
    },
  );
});
