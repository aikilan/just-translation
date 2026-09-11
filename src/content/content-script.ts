import type { PageCommand } from '../shared/messages';
import { TranslationController } from './controller';
import { registerRetryInteractions } from './retry-interaction';
import { tryStartAutomaticTranslation } from './auto-start';
import './styles.css';

// 页面唯一入口：只处理当前网页中的译文采集、渲染和状态切换。
const controller = new TranslationController();
registerRetryInteractions((source) => {
  void controller.retry(source);
});

chrome.runtime.onMessage.addListener((command: PageCommand, _sender, sendResponse) => {
  switch (command.type) {
    case 'TRANSLATION_BATCH_PROGRESS':
      controller.receiveBatchProgress(command);
      break;
    case 'GET_PAGE_DIAGNOSTICS':
      sendResponse(controller.getDiagnostics());
      return;
    case 'START_TRANSLATION':
      void controller.start();
      break;
    case 'STOP_TRANSLATION':
      controller.stop();
      break;
    case 'RESTORE_PAGE':
      controller.restore();
      break;
    case 'TOGGLE_TRANSLATION':
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
void tryStartAutomaticTranslation(controller, location.href);

// BFCache preserves this controller. Cancel its old sessions and explicitly restart only an
// already enabled page when it is restored; a user's stopped page must remain stopped.
let resumeAfterPageShow = false;
window.addEventListener('pagehide', () => {
  resumeAfterPageShow = ['translating', 'complete', 'error'].includes(controller.getStatus().phase);
  controller.stop();
});
window.addEventListener('pageshow', (event) => {
  if (event.persisted && resumeAfterPageShow) void controller.start();
  resumeAfterPageShow = false;
});
