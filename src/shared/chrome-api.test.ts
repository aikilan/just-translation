import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendRuntimeMessage } from './chrome-api';

afterEach(() => vi.unstubAllGlobals());

describe('runtime response boundary', () => {
  it.each([null, undefined, {}, { ok: 'true' }, { ok: false }])(
    'rejects a missing or invalid result envelope without exposing the request: %j',
    async (response) => {
      const sendMessage = vi.fn().mockResolvedValue(response);
      vi.stubGlobal('chrome', { runtime: { sendMessage } });
      await expect(sendRuntimeMessage({ type: 'GET_PUBLIC_SETTINGS' })).rejects.toThrow(
        '扩展后台未返回有效响应',
      );
      expect(sendMessage).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { ok: true, data: undefined },
    { ok: false, error: '写入失败' },
  ])('preserves a valid result without retrying or changing its meaning: %j', async (response) => {
    const sendMessage = vi.fn().mockResolvedValue(response);
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    await expect(sendRuntimeMessage({ type: 'GET_PUBLIC_SETTINGS' })).resolves.toBe(response);
    expect(sendMessage).toHaveBeenCalledOnce();
  });
});
