import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendRuntimeMessage, sendTabMessage } from './chrome-api';

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
    { ok: false, error: { text: '写入失败' } },
  ])('preserves a valid result without retrying or changing its meaning: %j', async (response) => {
    const sendMessage = vi.fn().mockResolvedValue(response);
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    await expect(sendRuntimeMessage({ type: 'GET_PUBLIC_SETTINGS' })).resolves.toBe(response);
    expect(sendMessage).toHaveBeenCalledOnce();
  });
});

it('forwards frame routing when sending a page command', async () => {
  const response = { phase: 'idle' };
  const sendMessage = vi.fn().mockResolvedValue(response);
  vi.stubGlobal('chrome', { tabs: { sendMessage } });

  await expect(
    sendTabMessage(7, { type: 'GET_PAGE_STATUS' }, { frameId: 0 }),
  ).resolves.toBe(response);
  expect(sendMessage).toHaveBeenCalledWith(7, { type: 'GET_PAGE_STATUS' }, { frameId: 0 });
});
