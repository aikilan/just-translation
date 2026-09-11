import {
  assertConnectionTestTranslation,
  createConnectionTestSegment,
} from '../shared/connection-test';
import { translateBatch } from '../shared/openai-client';
import { validateTranslationProfile, type TranslationProfile } from '../shared/settings';

const CONNECTION_TEST_TIMEOUT_MS = 60_000;

/** Tests the provider directly from the trusted options page so its request and error stay observable. */
export async function testTranslatorConfiguration(
  profile: TranslationProfile,
  targetLanguage: string,
  fetcher: typeof fetch = fetch,
  timeoutMs = CONNECTION_TEST_TIMEOUT_MS,
): Promise<string> {
  const profileErrors = validateTranslationProfile(profile);
  const validationError = Object.values(profileErrors)[0];
  if (validationError) throw new Error(validationError);
  if (!targetLanguage.trim()) throw new Error('请填写目标语言');

  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(new Error('API 请求超时')),
    timeoutMs,
  );
  const segment = createConnectionTestSegment(targetLanguage);

  try {
    const result = await translateBatch(
      { ...profile, targetLanguage },
      [segment],
      fetcher,
      controller.signal,
    );
    const failure = result.failures[segment.requestId];
    if (failure) throw new Error(failure);
    const translatedText = result.translations[segment.requestId];
    assertConnectionTestTranslation(segment.text, translatedText);
    return translatedText;
  } finally {
    clearTimeout(timeoutId);
  }
}
