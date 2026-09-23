import quickTranslationModule from '../content/quick-translation-entry.ts?script&module';
import quickTranslationLoader from '../content/quick-translation-loader.iife.ts?script&iife';
import { isUiMessage, LocalizedError, message } from '../shared/i18n';
import type { Result } from '../shared/messages';

/** Runs in the extension's isolated world. Keep all runtime references local: Chrome serializes it. */
function injectQuickTranslation(moduleUrl: string): Promise<Result<void>> {
  return window.__justTranslateOpenQuickTranslation(moduleUrl);
}

/** Open only the editor, even if webpage translation has no listener; wait for its actual result. */
export async function openQuickTranslationInTab(tabId: number): Promise<void> {
  const frames = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    world: 'ISOLATED',
    files: [quickTranslationLoader],
  });
  const documentId = frames.find((frame) => frame.frameId === 0)?.documentId;
  if (!documentId) throw new LocalizedError(message('当前网页已变化，请重新打开翻译'));
  // Bind the open to the injected document, so a navigation between calls cannot open on a new page.
  const results = await chrome.scripting.executeScript({
    target: { tabId, documentIds: [documentId] },
    world: 'ISOLATED',
    func: injectQuickTranslation,
    args: [chrome.runtime.getURL(quickTranslationModule)],
  });
  const response: unknown = results.find(
    (result) => result.frameId === 0 && result.documentId === documentId,
  )?.result;
  if (response && typeof response === 'object' && 'ok' in response) {
    if (response.ok === true) return;
    if (response.ok === false && 'error' in response && isUiMessage(response.error))
      throw new LocalizedError(response.error);
  }
  throw new LocalizedError(message('当前网页已变化，请重新打开翻译'));
}
