import { sendRuntimeMessage } from '../shared/chrome-api';
import type { PublicTranslatorSettings, Result } from '../shared/messages';
import { isUrlAutoTranslated, isUrlExcluded } from '../shared/settings';
import { isTargetLanguage } from '../shared/translation-languages';
import { detectPageLanguage, type PageLanguageResult } from './page-language';

interface AutoStartController {
  start(): Promise<void>;
}

type PublicSettingsReader = () => Promise<Result<PublicTranslatorSettings>>;
type PageLanguageReader = () => Promise<PageLanguageResult>;

/** A dynamic page may render its text after document_idle; wait briefly before giving up. */
const LANGUAGE_RETRY_DELAYS_MS = [1_000, 2_000];

/**
 * Starts only after the trusted background confirms the provider and an explicit rule: the exact
 * hostname, or a listed page language. Exclusions win over both.
 */
export async function tryStartAutomaticTranslation(
  controller: AutoStartController,
  pageUrl: string,
  signal: AbortSignal,
  readSettings: PublicSettingsReader = () =>
    sendRuntimeMessage<PublicTranslatorSettings>({ type: 'GET_PUBLIC_SETTINGS' }),
  readPageLanguage: PageLanguageReader = () => detectPageLanguage(),
): Promise<void> {
  if (signal.aborted) return;
  const result = await readSettings();
  // A later user command retires this startup intent, including after restore returns to idle.
  if (signal.aborted) return;
  if (!result.ok || !result.data.ready) return;
  if (isUrlExcluded(pageUrl, result.data.excludedSites)) return;
  if (isUrlAutoTranslated(pageUrl, result.data.autoTranslateSites)) {
    await controller.start();
    return;
  }
  const languages = result.data.autoTranslateLanguages;
  if (!languages.length) return;
  const page = await waitForPageLanguage(readPageLanguage, signal);
  if (signal.aborted || !page || !languages.includes(page.language)) return;
  if (isTargetLanguage(page.tag, result.data.targetLanguage)) return;
  // A listed language never sends sign-in pages by itself; an explicit hostname rule still does.
  if (document.querySelector('input[type="password"]')) return;
  await controller.start();
}

async function waitForPageLanguage(
  readPageLanguage: PageLanguageReader,
  signal: AbortSignal,
): Promise<{ language: string; tag: string } | undefined> {
  for (let attempt = 0; ; attempt += 1) {
    const result = await readPageLanguage();
    if (signal.aborted) return undefined;
    if (result.status === 'detected') return result;
    const delay = LANGUAGE_RETRY_DELAYS_MS[attempt];
    if (result.status === 'unknown' || delay === undefined) return undefined;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delay);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
    if (signal.aborted) return undefined;
  }
}
