import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { TranslationController } from '../content/controller';
import { registerRetryInteractions } from '../content/retry-interaction';
import { message, setUiLanguage } from '../shared/i18n';
import type { PageCommand, RuntimeRequest } from '../shared/messages';
import {
  extensionOrigin,
  getPdfFileName,
  getPdfViewerUrl,
  readPdfViewerParameters,
} from '../shared/pdf-viewer';
import { getSettings } from '../shared/settings-store';
import { PdfReader, type PdfSource } from './pdf-reader';
import { loadPdfDocument } from './pdfjs-loader';
import { PdfViewerApp, type PdfLayout } from './viewer-app';
import { PdfViewerSession } from './viewer-session';
import { createViewerStore } from './viewer-store';
import '../ui/base.css';
import '../content/styles.css';
import './viewer.css';

const LAYOUT_STORAGE_KEY = 'justranslate.pdf.layout';
const uiRoot = document.querySelector<HTMLElement>('#viewer-ui');
const documentRoot = document.querySelector<HTMLElement>('#pdf-document');
if (!uiRoot || !documentRoot) throw new Error('PDF viewer root elements are missing');

const parameters = readPdfViewerParameters(location.href);
const store = createViewerStore({
  reader: { phase: 'empty' },
  fileName: parameters.source ? getPdfFileName(parameters.source) : '',
  sourceUrl: parameters.source,
  pageCount: 0,
  currentPage: 0,
  layout: readLayout(),
});
documentRoot.dataset.layout = store.getSnapshot().layout;

const session = new PdfViewerSession(() => new TranslationController());
const reader = new PdfReader(documentRoot, loadPdfDocument, {
  onState: (state) => {
    session.updateReader(state);
    store.update({
      reader: state,
      pageCount:
        state.phase === 'extracting' || state.phase === 'ready'
          ? state.pageCount
          : store.getSnapshot().pageCount,
    });
  },
  onPage: (currentPage) => store.update({ currentPage }),
});
let currentSource: PdfSource | undefined = parameters.source
  ? { kind: 'url', url: parameters.source }
  : undefined;
registerRetryInteractions((source) => session.retry(source));

function open(source: PdfSource, fileName: string, sourceUrl?: string): void {
  currentSource = source;
  session.replaceDocument();
  store.update({ fileName, sourceUrl, pageCount: 0, currentPage: 0 });
  void reader.open(source);
}

async function openFile(file: File): Promise<void> {
  if (file.type !== 'application/pdf' && !/\.pdf$/iu.test(file.name)) {
    store.update({
      reader: { phase: 'error', kind: 'invalid', error: message('请选择 PDF 文件') },
    });
    return;
  }
  const data = new Uint8Array(await file.arrayBuffer());
  // A reload must not reopen the previous address after the user switched to a local file.
  history.replaceState(null, '', getPdfViewerUrl());
  open({ kind: 'data', name: file.name, data }, file.name);
}

// Commands from the popup or shortcut arrive on the runtime channel, addressed by tab ID.
let tabId: number | undefined;
void chrome.tabs.getCurrent().then((tab) => {
  tabId = tab?.id;
});
chrome.runtime.onMessage.addListener(
  (request: RuntimeRequest | PageCommand, sender, sendResponse) => {
    // Content scripts share the extension ID; only extension pages and the worker may control us.
    if (sender.id !== chrome.runtime.id) return;
    if (sender.tab && !sender.url?.startsWith(`${extensionOrigin()}/`)) return;
    if (request.type === 'TRANSLATION_BATCH_PROGRESS') {
      session.receiveBatchProgress(request);
      return;
    }
    if (request.type !== 'PDF_VIEWER_COMMAND' || tabId === undefined || request.tabId !== tabId)
      return;
    const response = session.handleCommand(request.command);
    if (response) sendResponse(response);
  },
);

window.addEventListener('pagehide', () => session.stop());
window.addEventListener('dragover', (event) => {
  if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
});
window.addEventListener('drop', (event) => {
  const file = event.dataTransfer?.files[0];
  if (!file) return;
  event.preventDefault();
  void openFile(file);
});

if (currentSource) {
  void reader.open(currentSource);
  if (parameters.translate) {
    session.translate(parameters.translate);
    // Reloading the viewer later should not send the document again without a new request.
    history.replaceState(null, '', getPdfViewerUrl(parameters.source));
  }
}

function readLayout(): PdfLayout {
  try {
    const value = localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (value === 'split' || value === 'reading') return value;
  } catch {
    // Storage can be unavailable; the default layout still works.
  }
  return window.innerWidth < 900 ? 'reading' : 'split';
}

function changeLayout(layout: PdfLayout): void {
  documentRoot!.dataset.layout = layout;
  store.update({ layout });
  try {
    localStorage.setItem(LAYOUT_STORAGE_KEY, layout);
  } catch {
    // The choice still applies to the current document.
  }
  reader.relayout();
}

void getSettings()
  .then((settings) => setUiLanguage(settings.uiLanguage))
  .catch(() => {})
  .then(() => {
    createRoot(uiRoot).render(
      <StrictMode>
        <PdfViewerApp
          store={store}
          getStatus={() => session.getStatus()}
          runCommand={(command) => {
            session.handleCommand(command);
          }}
          onOpenFile={(file) => void openFile(file)}
          onSubmitPassword={(password) => reader.submitPassword(password)}
          onLayoutChange={changeLayout}
          onRetryLoad={() => {
            if (currentSource)
              open(currentSource, store.getSnapshot().fileName, store.getSnapshot().sourceUrl);
          }}
        />
      </StrictMode>,
    );
  });
