// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageTranslationStatus } from '../shared/messages';
import {
  PdfViewerSession,
  type ViewerPageScope,
  type ViewerTranslationController,
} from './viewer-session';

const IDLE: PageTranslationStatus = {
  mode: 'segmented',
  phase: 'idle',
  translated: 0,
  failed: 0,
  total: 0,
  displayMode: 'bilingual',
};
const READY = { phase: 'ready', pageCount: 3, textPages: 3 } as const;

function fakeController(status: Partial<PageTranslationStatus> = {}) {
  return {
    getStatus: vi.fn(() => ({ ...IDLE, ...status })),
    getDiagnostics: vi.fn(() => ({}) as never),
    receiveBatchProgress: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined),
    startFullDocument: vi.fn().mockResolvedValue(undefined),
    retryAllFailed: vi.fn().mockResolvedValue(undefined),
    retry: vi.fn().mockResolvedValue(undefined),
    revealContent: vi.fn(() => true),
    stop: vi.fn(),
    restore: vi.fn(),
    setDisplayMode: vi.fn(),
  } satisfies ViewerTranslationController;
}

function fakeScope() {
  return {
    watch: vi.fn(() => [] as HTMLElement[]),
    stopWatching: vi.fn(),
    unlockAll: vi.fn(() => [] as HTMLElement[]),
    lockAll: vi.fn(),
    progress: vi.fn(() => ({ unlocked: 1, total: 3 })),
  } satisfies ViewerPageScope;
}

describe('PDF viewer session', () => {
  let controllers: ReturnType<typeof fakeController>[];
  let scope: ReturnType<typeof fakeScope>;
  let session: PdfViewerSession;
  beforeEach(() => {
    controllers = [];
    scope = fakeScope();
    session = new PdfViewerSession(() => {
      const controller = fakeController();
      controllers.push(controller);
      return controller;
    }, scope);
  });
  afterEach(() => vi.useRealTimers());

  it('waits for the whole document before translating and reports the wait as translating', () => {
    session.updateReader({ phase: 'loading' });
    expect(session.handleCommand({ type: 'START_TRANSLATION' })).toMatchObject({
      phase: 'translating',
    });
    session.updateReader({ phase: 'extracting', pageCount: 3, extractedPages: 1 });
    expect(controllers[0].start).not.toHaveBeenCalled();
    session.updateReader(READY);
    expect(controllers[0].start).toHaveBeenCalledOnce();
    expect(session.hasPendingStart()).toBe(false);
  });

  it('unlocks the pages in range before the first pass starts', () => {
    session.updateReader(READY);
    const translator = { kind: 'builtin', engine: 'google-free' } as const;
    session.handleCommand({ type: 'START_TRANSLATION', translator });
    expect(scope.watch).toHaveBeenCalledOnce();
    expect(scope.watch.mock.invocationCallOrder[0]).toBeLessThan(
      controllers[0].start.mock.invocationCallOrder[0],
    );
    expect(controllers[0].start).toHaveBeenCalledWith(translator);
    expect(session.getPageProgress()).toEqual({ unlocked: 1, total: 3, following: true });
  });

  it('adds pages reached by scrolling and offers them again while a retry owns the translator', () => {
    vi.useFakeTimers();
    session.updateReader(READY);
    session.translate();
    const page = document.createElement('div');
    controllers[0].revealContent.mockReturnValueOnce(false);
    session.reveal([page]);
    expect(controllers[0].revealContent).toHaveBeenCalledWith([page]);
    vi.advanceTimersByTime(300);
    expect(controllers[0].revealContent).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(300);
    expect(controllers[0].revealContent).toHaveBeenCalledTimes(2);
  });

  it('ignores reached pages once translation was stopped', () => {
    session.updateReader(READY);
    session.translate();
    session.handleCommand({ type: 'STOP_TRANSLATION' });
    expect(scope.stopWatching).toHaveBeenCalled();
    session.reveal([document.createElement('div')]);
    expect(controllers[0].revealContent).not.toHaveBeenCalled();
    expect(session.getPageProgress().following).toBe(false);
  });

  it('gives full-document translation every page at once', () => {
    session.updateReader({ phase: 'loading' });
    expect(session.handleCommand({ type: 'START_FULL_DOCUMENT_TRANSLATION' })).toMatchObject({
      mode: 'full-document',
      stage: 'collecting',
    });
    session.updateReader(READY);
    expect(scope.unlockAll).toHaveBeenCalledOnce();
    expect(scope.watch).not.toHaveBeenCalled();
    expect(controllers[0].startFullDocument).toHaveBeenCalledOnce();
  });

  it('locks every page again when the original is restored', () => {
    session.updateReader(READY);
    session.translate();
    session.handleCommand({ type: 'RESTORE_PAGE' });
    expect(controllers[0].restore).toHaveBeenCalledOnce();
    expect(scope.lockAll).toHaveBeenCalledOnce();
    session.reveal([document.createElement('div')]);
    expect(controllers[0].revealContent).not.toHaveBeenCalled();
  });

  it('toggles like the webpage shortcut and restarts in the previous mode', () => {
    session.updateReader(READY);
    session.handleCommand({ type: 'TOGGLE_TRANSLATION' });
    expect(controllers[0].start).toHaveBeenCalledOnce();
    controllers[0].getStatus.mockReturnValue({ ...IDLE, phase: 'complete', total: 2 });
    session.handleCommand({ type: 'TOGGLE_TRANSLATION' });
    expect(controllers[0].restore).toHaveBeenCalledOnce();
    expect(scope.lockAll).toHaveBeenCalledOnce();

    controllers[0].getStatus.mockReturnValue({ ...IDLE, mode: 'full-document', phase: 'complete' });
    session.handleCommand({ type: 'RESTART_TRANSLATION' });
    expect(controllers[0].restore).toHaveBeenCalledTimes(2);
    expect(controllers[0].startFullDocument).toHaveBeenCalledOnce();
  });

  it('drops a queued request when loading fails, stops or is toggled off', () => {
    session.updateReader({ phase: 'loading' });
    session.translate();
    session.updateReader({ phase: 'error', kind: 'network', error: { text: 'offline' } });
    session.updateReader(READY);
    expect(controllers[0].start).not.toHaveBeenCalled();

    session.updateReader({ phase: 'loading' });
    session.handleCommand({ type: 'TOGGLE_TRANSLATION' });
    session.handleCommand({ type: 'TOGGLE_TRANSLATION' });
    session.handleCommand({ type: 'START_TRANSLATION' });
    session.handleCommand({ type: 'STOP_TRANSLATION' });
    session.updateReader(READY);
    expect(controllers[0].start).not.toHaveBeenCalled();
  });

  it('forwards the remaining page commands to the page translator', () => {
    session.updateReader(READY);
    session.handleCommand({ type: 'SET_DISPLAY_MODE', displayMode: 'translation' });
    expect(controllers[0].setDisplayMode).toHaveBeenCalledWith('translation');
    session.handleCommand({ type: 'RETRY_FAILED_TRANSLATIONS' });
    expect(controllers[0].retryAllFailed).toHaveBeenCalledOnce();
    expect(session.handleCommand({ type: 'GET_PAGE_DIAGNOSTICS' })).toEqual({});
    expect(session.handleCommand({ type: 'UI_LANGUAGE_CHANGED', locale: 'en' })).toBeUndefined();
  });

  it('gives a newly opened document a fresh translator with the same display mode', () => {
    controllers[0].getStatus.mockReturnValue({ ...IDLE, displayMode: 'translation' });
    session.replaceDocument();
    expect(controllers[0].stop).toHaveBeenCalled();
    expect(controllers[0].restore).toHaveBeenCalled();
    expect(controllers).toHaveLength(2);
    expect(controllers[1].setDisplayMode).toHaveBeenCalledWith('translation');
    session.updateReader(READY);
    session.translate();
    expect(controllers[1].start).toHaveBeenCalledOnce();
    expect(controllers[0].start).not.toHaveBeenCalled();
  });
});
