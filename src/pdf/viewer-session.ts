import type {
  PageCommand,
  PageTranslationStatus,
  TranslationBatchProgress,
  TranslationMode,
} from '../shared/messages';
import type { ActiveTranslator } from '../shared/translation-engines';
import type { TranslationDiagnostics } from '../shared/translation-metrics';
import type { DisplayMode } from '../shared/settings';
import type { PdfReaderState } from './pdf-reader';
import { setDocumentTranslationStyle } from '../content/dom-translator';

/** The page translator API the viewer needs; it is the same controller used on webpages. */
export interface ViewerTranslationController {
  getStatus(): PageTranslationStatus;
  getDiagnostics(): TranslationDiagnostics;
  receiveBatchProgress(event: TranslationBatchProgress): void;
  start(translator?: ActiveTranslator): Promise<void>;
  startFullDocument(): Promise<void>;
  retryAllFailed(): Promise<void>;
  retry(source: HTMLElement): Promise<void>;
  revealContent(roots: readonly HTMLElement[]): boolean;
  stop(): void;
  restore(): void;
  setDisplayMode(displayMode: DisplayMode): void;
}

/** Which pages the translator may see; implemented by PdfPageScope. */
export interface ViewerPageScope {
  watch(): HTMLElement[];
  stopWatching(): void;
  unlockAll(): HTMLElement[];
  lockAll(): void;
  progress(): { unlocked: number; total: number };
}

interface PendingStart {
  mode: TranslationMode;
  translator?: ActiveTranslator;
}

const REVEAL_RETRY_MS = 300;

/**
 * Connects one PDF document to a page translator. Ordinary translation is lazy: only pages the
 * reader has scrolled near are translated, and each newly reached page joins the running or
 * finished translation. Full-document translation needs the whole text and unlocks every page.
 * Translation waits for text extraction, so page geometry and reading text are final.
 */
export class PdfViewerSession {
  private controller: ViewerTranslationController;
  private pending: PendingStart | undefined;
  private readerState: PdfReaderState = { phase: 'empty' };
  /** Pages reached while another operation (a retry) owned the translator. */
  private revealed: HTMLElement[] = [];
  private revealTimer: ReturnType<typeof setTimeout> | undefined;
  private following = false;

  constructor(
    private readonly createController: () => ViewerTranslationController,
    private readonly scope: ViewerPageScope,
  ) {
    this.controller = createController();
  }

  /** A new document never inherits paragraphs, sessions or failures from the previous one. */
  replaceDocument(): void {
    this.pending = undefined;
    this.stopFollowing();
    this.controller.stop();
    this.controller.restore();
    const displayMode = this.controller.getStatus().displayMode;
    this.controller = this.createController();
    this.controller.setDisplayMode(displayMode);
  }

  updateReader(state: PdfReaderState): void {
    this.readerState = state;
    if (state.phase === 'ready') {
      const pending = this.pending;
      this.pending = undefined;
      if (pending) this.run(pending);
    } else if (state.phase === 'error' || state.phase === 'empty') this.pending = undefined;
  }

  isReady(): boolean {
    return this.readerState.phase === 'ready';
  }

  /** Requests made while the PDF is still loading run once all reading text exists. */
  translate(mode: TranslationMode = 'segmented', translator?: ActiveTranslator): void {
    if (this.isReady()) this.run({ mode, translator });
    else if (this.readerState.phase !== 'error' && this.readerState.phase !== 'empty')
      this.pending = { mode, translator };
  }

  /** Called by the page scope when the reader scrolls to pages that were still locked. */
  reveal(readings: readonly HTMLElement[]): void {
    if (!this.following) return;
    this.revealed.push(...readings);
    this.flushRevealed();
  }

  getStatus(): PageTranslationStatus {
    const status = this.controller.getStatus();
    if (!this.pending) return status;
    // Waiting for extraction is part of translating from the user's point of view.
    return {
      ...status,
      mode: this.pending.mode,
      phase: 'translating',
      error: undefined,
      ...(this.pending.mode === 'full-document' ? { stage: 'collecting' as const } : {}),
    };
  }

  /** Pages the translator has been given so far, for "continue by scrolling" guidance. */
  getPageProgress(): { unlocked: number; total: number; following: boolean } {
    return { ...this.scope.progress(), following: this.following };
  }

  hasPendingStart(): boolean {
    return this.pending !== undefined;
  }

  receiveBatchProgress(event: TranslationBatchProgress): void {
    this.controller.receiveBatchProgress(event);
  }

  retry(source: HTMLElement): void {
    void this.controller.retry(source);
  }

  /** Mirrors the webpage content script so the popup, shortcut and toolbar share one behavior. */
  handleCommand(command: PageCommand): PageTranslationStatus | TranslationDiagnostics | undefined {
    switch (command.type) {
      case 'GET_PAGE_DIAGNOSTICS':
        return this.controller.getDiagnostics();
      case 'START_TRANSLATION':
        this.translate('segmented', command.translator);
        break;
      case 'START_FULL_DOCUMENT_TRANSLATION':
        this.translate('full-document');
        break;
      case 'RESTART_TRANSLATION':
        if (this.isReady()) {
          const mode = this.controller.getStatus().mode;
          this.restore();
          this.run({ mode });
        }
        break;
      case 'RETRY_FAILED_TRANSLATIONS':
        void this.controller.retryAllFailed();
        break;
      case 'STOP_TRANSLATION':
        this.stop();
        break;
      case 'RESTORE_PAGE':
        this.restore();
        break;
      case 'TOGGLE_TRANSLATION': {
        const status = this.getStatus();
        if (this.pending) this.pending = undefined;
        else if (status.phase === 'idle' || status.phase === 'stopped') this.translate(status.mode);
        else this.restore();
        break;
      }
      case 'SET_DISPLAY_MODE':
        this.controller.setDisplayMode(command.displayMode);
        break;
      case 'SET_TRANSLATION_STYLE':
        setDocumentTranslationStyle(command.translationStyle);
        break;
      case 'GET_PAGE_STATUS':
        break;
      default:
        // Selection, language and progress events have their own channels in the viewer.
        return undefined;
    }
    return this.getStatus();
  }

  /** Stops network work, also when the viewer document is hidden or replaced. */
  stop(): void {
    this.pending = undefined;
    this.stopFollowing();
    this.controller.stop();
  }

  private restore(): void {
    this.pending = undefined;
    this.stopFollowing();
    this.controller.restore();
    this.scope.lockAll();
  }

  private run({ mode, translator }: PendingStart): void {
    if (mode === 'full-document') {
      this.stopFollowing();
      this.scope.unlockAll();
      void this.controller.startFullDocument();
      return;
    }
    // Unlock the pages in range before the pass starts, so they are its first discovery.
    this.following = true;
    this.scope.watch();
    void this.controller.start(translator);
  }

  private flushRevealed(): void {
    clearTimeout(this.revealTimer);
    this.revealTimer = undefined;
    if (!this.following || this.revealed.length === 0) return;
    if (this.controller.revealContent(this.revealed)) this.revealed = [];
    else this.revealTimer = setTimeout(() => this.flushRevealed(), REVEAL_RETRY_MS);
  }

  private stopFollowing(): void {
    this.following = false;
    this.revealed = [];
    clearTimeout(this.revealTimer);
    this.revealTimer = undefined;
    this.scope.stopWatching();
  }
}
