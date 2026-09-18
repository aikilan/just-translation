import { DEFAULT_SETTINGS } from '../shared/settings';
/** Explicitly configured fixture; production defaults intentionally require a provider choice. */
export const TEST_PROFILE = {
  ...DEFAULT_SETTINGS.profiles[0],
  provider: 'custom' as const,
  protocol: 'openai' as const,
  apiUrl: 'https://api.openai.com/v1',
};
