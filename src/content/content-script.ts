import { initializeContentLanguage } from './ui-language';
import { sendRuntimeMessage } from '../shared/chrome-api';
import type {
  PageCommand,
  PageTranslationStatus,
  PublicTranslatorSettings,
  TranslationMode,
} from '../shared/messages';
import { isUrlExcluded } from '../shared/settings';
import { TranslationController } from './controller';
import { registerRetryInteractions } from './retry-interaction';
import { tryStartAutomaticTranslation } from './auto-start';
import { detectPageLanguage, waitForDomQuiet, type PageLanguageResult } from './page-language';
import { isBrowserPdfDocument, mountPdfEntry } from './pdf-entry';
import { isYouTubeWatchHost, YouTubeSubtitles } from './youtube/youtube-subtitles';
import { setDocumentTranslationStyle } from './dom-translator';
import { YOUTUBE_SUBTITLES_ENABLED } from '../shared/features';
import './styles.css';

// 页面唯一入口：只处理当前网页中的译文采集、渲染和状态切换。
const controller = new TranslationController(() => {
  // This notification carries no page data; the background reads its current active document.
  void sendRuntimeMessage<void>({ type: 'PAGE_RETRY_STATE_CHANGED' }).catch(() => {});
});
let automaticStartup = new AbortController();
registerRetryInteractions((source) => {
  automaticStartup.abort();
  void controller.retry(source);
});

// The browser's PDF viewer has no page text; translation happens in the extension's PDF reader.
const pdfDocument = isBrowserPdfDocument();
function openPdfViewer(translate: TranslationMode): void {
  void sendRuntimeMessage<void>({ type: 'OPEN_PDF_VIEWER', translate }).catch(() => {});
}

// Video subtitles are a separate feature of this page; page translation never depends on them.
const youtubeSubtitles =
  YOUTUBE_SUBTITLES_ENABLED && !pdfDocument && isYouTubeWatchHost()
    ? new YouTubeSubtitles()
    : undefined;
youtubeSubtitles?.initialize();
// One local detection per URL serves both language rules and the popup's language switch.
let languageDetection: { url: string; result: Promise<PageLanguageResult> } | undefined;
let pageLanguage: string | undefined;
// After an SPA route change, detection waits for the new route to render before sampling.
let routeRendered: Promise<void> = Promise.resolve();
function readPageLanguage(): Promise<PageLanguageResult> {
  if (languageDetection?.url !== location.href) {
    const url = location.href;
    const result = routeRendered
      .then(() =>
        // A newer route replaced this one while it rendered; its text is not this URL's.
        location.href === url ? detectPageLanguage() : ({ status: 'unknown' } as const),
      )
      .then((value) => {
        if (languageDetection?.url === url) {
          pageLanguage = value.status === 'detected' ? value.tag : undefined;
          // Too little text yet: let a later read try again.
          if (value.status === 'insufficient') languageDetection = undefined;
        }
        return value;
      });
    languageDetection = { url, result };
    pageLanguage = undefined;
  }
  return languageDetection.result;
}

function pageStatus(): PageTranslationStatus {
  const status: PageTranslationStatus = { ...controller.getStatus() };
  if (youtubeSubtitles) status.videoSubtitles = youtubeSubtitles.getStatus();
  if (pageLanguage) status.pageLanguage = pageLanguage;
  else if (!pdfDocument) void readPageLanguage().catch(() => {});
  return status;
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
      youtubeSubtitles?.setDisplayMode(command.displayMode);
      break;
    case 'SET_TRANSLATION_STYLE':
      setDocumentTranslationStyle(command.translationStyle);
      break;
    case 'SET_VIDEO_SUBTITLES':
      youtubeSubtitles?.setEnabled(command.enabled);
      break;
    case 'GET_PAGE_STATUS':
      break;
  }
  sendResponse(pageStatus());
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
} else
  void tryStartAutomaticTranslation(
    controller,
    location.href,
    automaticStartup.signal,
    undefined,
    readPageLanguage,
  );

/** Only an enabled segmented page may resume by itself; a user's stopped page remains stopped. */
function isResumable(status: PageTranslationStatus): boolean {
  return status.mode === 'segmented' && ['translating', 'complete', 'error'].includes(status.phase);
}

// BFCache preserves this controller. Cancel its old sessions and explicitly restart only an
// already enabled page when it is restored.
let resumeAfterPageShow = false;
window.addEventListener('pagehide', () => {
  automaticStartup.abort();
  resumeAfterPageShow = isResumable(controller.getStatus());
  controller.stop();
  youtubeSubtitles?.suspend();
});
window.addEventListener('pageshow', (event) => {
  if (event.persisted && resumeAfterPageShow) void controller.start();
  resumeAfterPageShow = false;
  if (event.persisted) youtubeSubtitles?.resume();
});

interface HistoryEntry {
  readonly key: string;
  readonly url: string | null;
}
interface HistoryNavigation extends EventTarget {
  readonly currentEntry: HistoryEntry | null;
}
interface HistoryEntryChangeEvent extends Event {
  readonly navigationType: 'push' | 'replace' | 'reload' | 'traverse' | null;
  readonly from: HistoryEntry;
}

// SPA route changes keep this document, so its dynamic observer would translate the next route.
// Treat a changed path like a full navigation: a pushed route starts untranslated, while
// back/forward mirrors BFCache per history entry and resumes only a route enabled when left.
// Query/fragment changes (filters, pagination, anchors) and replaceState (often rewritten while
// scrolling) stay within the current page.
const resumableEntries = new Map<string, boolean>();
// The browser PDF viewer translates in the extension reader, never through page auto-start.
const historyNavigation = pdfDocument
  ? undefined
  : (window as Window & { navigation?: HistoryNavigation }).navigation;
historyNavigation?.addEventListener('currententrychange', (event) => {
  const { navigationType, from } = event as HistoryEntryChangeEvent;
  const current = historyNavigation.currentEntry;
  const status = controller.getStatus();
  resumableEntries.set(from.key, isResumable(status));
  if (navigationType !== 'push' && navigationType !== 'traverse') return;
  if (!current || isSamePath(from.url, current.url)) return;
  routeRendered = waitForDomQuiet();
  languageDetection = undefined;
  pageLanguage = undefined;
  // A pushed entry always has a new key, so it follows the never-left branch below.
  const resume = resumableEntries.get(current.key);
  if (resume && isResumable(status)) return;
  automaticStartup.abort();
  if (status.phase !== 'idle') controller.restore();
  if (resume) {
    void controller.start();
  } else if (resume === undefined) {
    // An entry this script never left follows the same hostname rule as a full navigation.
    automaticStartup = new AbortController();
    void tryStartAutomaticTranslation(
      controller,
      location.href,
      automaticStartup.signal,
      undefined,
      readPageLanguage,
    );
  }
});

function isSamePath(from: string | null, to: string | null): boolean {
  if (!from || !to) return true;
  return new URL(from).pathname === new URL(to).pathname;
}

initializeContentLanguage();
