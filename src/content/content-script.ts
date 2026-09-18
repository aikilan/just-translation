import { sendRuntimeMessage } from '../shared/chrome-api';
import type { PageCommand } from '../shared/messages';
import { TranslationController } from './controller';
import { registerRetryInteractions } from './retry-interaction';
import { tryStartAutomaticTranslation } from './auto-start';
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

chrome.runtime.onMessage.addListener((command: PageCommand, _sender, sendResponse) => {
  if (command.type === 'START_SELECTION_TRANSLATION') return;
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
      void controller.start();
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
void tryStartAutomaticTranslation(controller, location.href, automaticStartup.signal);

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
