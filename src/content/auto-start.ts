import { sendRuntimeMessage } from '../shared/chrome-api';
import type { PublicTranslatorSettings, Result } from '../shared/messages';
import { isUrlAutoTranslated } from '../shared/settings';

interface AutoStartController {
  start(): Promise<void>;
}

type PublicSettingsReader = () => Promise<Result<PublicTranslatorSettings>>;

/** Starts only after the trusted background confirms both provider and exact hostname. */
export async function tryStartAutomaticTranslation(
  controller: AutoStartController,
  pageUrl: string,
  readSettings: PublicSettingsReader = () =>
    sendRuntimeMessage<PublicTranslatorSettings>({ type: 'GET_PUBLIC_SETTINGS' }),
): Promise<void> {
  const result = await readSettings();
  if (!result.ok || !result.data.configured) return;
  if (!isUrlAutoTranslated(pageUrl, result.data.autoTranslateSites)) return;
  await controller.start();
}
