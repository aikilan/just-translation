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

/** The page translator API the viewer needs; it is the same controller used on webpages. */
export interface ViewerTranslationController {
  getStatus(): PageTranslationStatus;
  getDiagnostics(): TranslationDiagnostics;
  receiveBatchProgress(event: TranslationBatchProgress): void;
  start(translator?: ActiveTranslator): Promise<void>;
  startFullDocument(): Promise<void>;
  restart(): Promise<void>;
  retryAllFailed(): Promise<void>;
  retry(source: HTMLElement): Promise<void>;
  stop(): void;
  restore(): void;
  toggle(): void;
  setDisplayMode(displayMode: DisplayMode): void;
}

interface PendingStart {
  mode: TranslationMode;
  translator?: ActiveTranslator;
}

/**
 * Connects one PDF document to a page translator. Translation always waits for text extraction
 * to finish, so the translator sees the whole document exactly like a fully loaded webpage.
 */
export class PdfViewerSession {
  private controller: ViewerTranslationController;
  private pending: PendingStart | undefined;
  private readerState: PdfReaderState = { phase: 'empty' };

  constructor(private readonly createController: () => ViewerTranslationController) {
    this.controller = createController();
  }

  /** A new document never inherits paragraphs, sessions or failures from the previous one. */
  replaceDocument(): void {
    this.pending = undefined;
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
        if (this.isReady()) void this.controller.restart();
        break;
      case 'RETRY_FAILED_TRANSLATIONS':
        void this.controller.retryAllFailed();
        break;
      case 'STOP_TRANSLATION':
        this.pending = undefined;
        this.controller.stop();
        break;
      case 'RESTORE_PAGE':
        this.pending = undefined;
        this.controller.restore();
        break;
      case 'TOGGLE_TRANSLATION':
        if (this.pending) this.pending = undefined;
        else if (this.isReady()) this.controller.toggle();
        else this.translate();
        break;
      case 'SET_DISPLAY_MODE':
        this.controller.setDisplayMode(command.displayMode);
        break;
      case 'GET_PAGE_STATUS':
        break;
      default:
        // Selection, language and progress events have their own channels in the viewer.
        return undefined;
    }
    return this.getStatus();
  }

  /** Stops network work when the viewer document is hidden or replaced. */
  stop(): void {
    this.pending = undefined;
    this.controller.stop();
  }

  private run({ mode, translator }: PendingStart): void {
    if (mode === 'full-document') void this.controller.startFullDocument();
    else void this.controller.start(translator);
  }
}
