import { initializeContentLanguage } from './ui-language';
import { sendRuntimeMessage } from '../shared/chrome-api';
import type { PageCommand, PublicTranslatorSettings, TranslationMode } from '../shared/messages';
import { isUrlExcluded } from '../shared/settings';
import { TranslationController } from './controller';
import { registerRetryInteractions } from './retry-interaction';
import { tryStartAutomaticTranslation } from './auto-start';
import { isBrowserPdfDocument, mountPdfEntry } from './pdf-entry';
import './styles.css';

// 页面唯一入口：只处理当前网页中的译文采集、渲染和状态切换。
const controller = new TranslationController(() => {
  // This notification carries no page data; the background reads its current active document.
  void sendRuntimeMessage<void>({ type: 'PAGE_RETRY_STATE_CHANGED' }).catch(() => {});
});
const automaticStartup = new AbortController();
registerRetryInteractions((source) => {
  automaticStartup.abort();
  void controller.retry(source);
});

// The browser's PDF viewer has no page text; translation happens in the extension's PDF reader.
const pdfDocument = isBrowserPdfDocument();
function openPdfViewer(translate: TranslationMode): void {
  void sendRuntimeMessage<void>({ type: 'OPEN_PDF_VIEWER', translate }).catch(() => {});
}

chrome.runtime.onMessage.addListener((command: PageCommand, _sender, sendResponse) => {
  if (command.type === 'START_SELECTION_TRANSLATION' || command.type === 'UI_LANGUAGE_CHANGED')
    return;
  if (pdfDocument) {
    if (command.type === 'START_TRANSLATION' || command.type === 'TOGGLE_TRANSLATION')
      openPdfViewer('segmented');
    else if (command.type === 'START_FULL_DOCUMENT_TRANSLATION') openPdfViewer('full-document');
    sendResponse({ ...controller.getStatus(), pdfDocument: true });
    return;
  }
  switch (command.type) {
    case 'TRANSLATION_BATCH_PROGRESS':
      controller.receiveBatchProgress(command);
      break;
    case 'GET_PAGE_DIAGNOSTICS':
      sendResponse(controller.getDiagnostics());
      return;
    case 'START_FULL_DOCUMENT_TRANSLATION':
      automaticStartup.abort();
      void controller.startFullDocument();
      break;
    case 'START_TRANSLATION':
      automaticStartup.abort();
      void controller.start(command.translator);
      break;
    case 'RESTART_TRANSLATION':
      automaticStartup.abort();
      void controller.restart();
      break;
    case 'RETRY_FAILED_TRANSLATIONS':
      automaticStartup.abort();
      void controller.retryAllFailed();
      break;
    case 'STOP_TRANSLATION':
      automaticStartup.abort();
      controller.stop();
      break;
    case 'RESTORE_PAGE':
      automaticStartup.abort();
      controller.restore();
      break;
    case 'TOGGLE_TRANSLATION':
      automaticStartup.abort();
      controller.toggle();
      break;
    case 'SET_DISPLAY_MODE':
      controller.setDisplayMode(command.displayMode);
      break;
    case 'GET_PAGE_STATUS':
      break;
  }
  sendResponse(controller.getStatus());
});

// Every full navigation creates a fresh content script, so hostname rules also cover pagination.
if (pdfDocument) {
  // The entry is unrequested UI, so it honours exclusions; explicit commands still work there.
  void sendRuntimeMessage<PublicTranslatorSettings>({ type: 'GET_PUBLIC_SETTINGS' })
    .then((result) => {
      if (result.ok && !isUrlExcluded(location.href, result.data.excludedSites))
        mountPdfEntry(() => openPdfViewer('segmented'));
    })
    .catch(() => {});
} else void tryStartAutomaticTranslation(controller, location.href, automaticStartup.signal);

// BFCache preserves this controller. Cancel its old sessions and explicitly restart only an
// already enabled page when it is restored; a user's stopped page must remain stopped.
let resumeAfterPageShow = false;
window.addEventListener('pagehide', () => {
  automaticStartup.abort();
  const status = controller.getStatus();
  resumeAfterPageShow =
    status.mode === 'segmented' && ['translating', 'complete', 'error'].includes(status.phase);
  controller.stop();
});
window.addEventListener('pageshow', (event) => {
  if (event.persisted && resumeAfterPageShow) void controller.start();
  resumeAfterPageShow = false;
});

initializeContentLanguage();
