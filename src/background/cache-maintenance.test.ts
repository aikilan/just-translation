import { describe, expect, it, vi } from 'vitest';

import {
  CACHE_CLEANUP_ALARM_NAME,
  CACHE_CLEANUP_PERIOD_MINUTES,
  ensureCacheCleanupAlarm,
  runCacheCleanupForAlarm,
} from './cache-maintenance';

describe('translation cache maintenance', () => {
  it('creates one three-day recurring alarm when it is missing', async () => {
    const alarms = {
      get: vi.fn().mockResolvedValue(undefined),
      create: vi.fn().mockResolvedValue(undefined),
    };

    await ensureCacheCleanupAlarm(alarms);

    expect(alarms.get).toHaveBeenCalledWith(CACHE_CLEANUP_ALARM_NAME);
    expect(alarms.create).toHaveBeenCalledWith(CACHE_CLEANUP_ALARM_NAME, {
      periodInMinutes: CACHE_CLEANUP_PERIOD_MINUTES,
    });
    expect(CACHE_CLEANUP_PERIOD_MINUTES).toBe(4_320);
  });

  it('does not replace an existing alarm and only cleans for its own alarm name', async () => {
    const alarms = {
      get: vi.fn().mockResolvedValue({ name: CACHE_CLEANUP_ALARM_NAME }),
      create: vi.fn().mockResolvedValue(undefined),
    };
    const cache = { deleteExpired: vi.fn().mockResolvedValue(2) };

    await ensureCacheCleanupAlarm(alarms);
    await runCacheCleanupForAlarm({ name: 'another-extension-alarm' }, cache);
    await runCacheCleanupForAlarm({ name: CACHE_CLEANUP_ALARM_NAME }, cache);

    expect(alarms.create).not.toHaveBeenCalled();
    expect(cache.deleteExpired).toHaveBeenCalledOnce();
  });
});
