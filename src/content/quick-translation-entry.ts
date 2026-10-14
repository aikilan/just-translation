import { getErrorMessage, isQuickTranslationProgress, type Result } from '../shared/messages';
import { QuickTranslationDialog } from './quick-translation-dialog';
import { initializeContentLanguage } from './ui-language';

let currentDialog: QuickTranslationDialog | undefined;

/** This document-local entry owns its UI lifecycle without initializing webpage translation. */
export function openQuickTranslation(): Result<void> {
  try {
    if (!currentDialog) {
      initializeContentLanguage();
      currentDialog = new QuickTranslationDialog();
      // Only the background (no sender tab) reports progress; the request ID selects the task.
      chrome.runtime.onMessage.addListener((event: unknown, sender) => {
        if (sender.id === chrome.runtime.id && !sender.tab && isQuickTranslationProgress(event))
          currentDialog?.receiveProgress(event);
      });
      // BFCache keeps the draft but must retire the previous visible session and its requests.
      window.addEventListener('pagehide', () => currentDialog?.close());
    }
    currentDialog.open();
    return { ok: true, data: undefined };
  } catch (error) {
    return { ok: false, error: getErrorMessage(error) };
  }
}
