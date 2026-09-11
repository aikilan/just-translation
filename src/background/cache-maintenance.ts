export const CACHE_CLEANUP_ALARM_NAME = 'just-translate-cache-cleanup';
export const CACHE_CLEANUP_PERIOD_MINUTES = 3 * 24 * 60;

interface AlarmApi {
  get(name: string): Promise<{ name: string } | undefined>;
  create(name: string, alarmInfo: { periodInMinutes: number }): Promise<void> | void;
}

interface ExpiredCacheCleaner {
  deleteExpired(): Promise<number>;
}

/** Registers one recurring cleanup without resetting its schedule on every worker wake-up. */
export async function ensureCacheCleanupAlarm(alarms: AlarmApi): Promise<void> {
  if (await alarms.get(CACHE_CLEANUP_ALARM_NAME)) return;
  await alarms.create(CACHE_CLEANUP_ALARM_NAME, {
    periodInMinutes: CACHE_CLEANUP_PERIOD_MINUTES,
  });
}

export async function runCacheCleanupForAlarm(
  alarm: { name: string },
  cache: ExpiredCacheCleaner,
): Promise<void> {
  if (alarm.name !== CACHE_CLEANUP_ALARM_NAME) return;
  await cache.deleteExpired();
}
