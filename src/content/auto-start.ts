import { sendRuntimeMessage } from '../shared/chrome-api';
import type { PublicTranslatorSettings, Result } from '../shared/messages';
import { isUrlAutoTranslated, isUrlExcluded } from '../shared/settings';

interface AutoStartController {
  start(): Promise<void>;
}

type PublicSettingsReader = () => Promise<Result<PublicTranslatorSettings>>;

/** Starts only after the trusted background confirms both provider and exact hostname. */
export async function tryStartAutomaticTranslation(
  controller: AutoStartController,
  pageUrl: string,
  signal: AbortSignal,
  readSettings: PublicSettingsReader = () =>
    sendRuntimeMessage<PublicTranslatorSettings>({ type: 'GET_PUBLIC_SETTINGS' }),
): Promise<void> {
  if (signal.aborted) return;
  const result = await readSettings();
  // A later user command retires this startup intent, including after restore returns to idle.
  if (signal.aborted) return;
  if (!result.ok || !result.data.configured) return;
  if (isUrlExcluded(pageUrl, result.data.excludedSites)) return;
  if (!isUrlAutoTranslated(pageUrl, result.data.autoTranslateSites)) return;
  await controller.start();
}
