import PQueue from 'p-queue';
import { SETTINGS_STORAGE_KEY, mergeSettings, type TranslatorSettings } from './settings';

// All read/modify/write transactions run in the background through this single queue.
const writes = new PQueue({ concurrency: 1 });

/** Reads a normalized snapshot without writing from an options page or content context. */
export async function getSettings(): Promise<TranslatorSettings> {
  const stored = await chrome.storage.local.get(SETTINGS_STORAGE_KEY);
  return mergeSettings(stored[SETTINGS_STORAGE_KEY]);
}

/** Applies a domain-validated change to the latest snapshot and verifies durable readback. */
export function updateStoredSettings(
  update: (current: TranslatorSettings) => TranslatorSettings,
): Promise<TranslatorSettings> {
  return writes.add(async () => {
    const next = update(await getSettings());
    await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: next });
    const stored = await getSettings();
    // Compare the same canonical schema: Chrome message/storage dictionaries may reorder keys.
    if (JSON.stringify(stored) !== JSON.stringify(mergeSettings(next))) {
      throw new Error('设置写入后回读不一致，请重新加载扩展后重试');
    }
    return stored;
  });
}

export async function initializeSettings(): Promise<void> {
  await updateStoredSettings((settings) => settings);
}
