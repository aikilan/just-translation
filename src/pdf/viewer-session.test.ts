import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageTranslationStatus } from '../shared/messages';
import { PdfViewerSession, type ViewerTranslationController } from './viewer-session';

const IDLE: PageTranslationStatus = {
  mode: 'segmented',
  phase: 'idle',
  translated: 0,
  failed: 0,
  total: 0,
  displayMode: 'bilingual',
};

function fakeController(status: Partial<PageTranslationStatus> = {}) {
  return {
    getStatus: vi.fn(() => ({ ...IDLE, ...status })),
    getDiagnostics: vi.fn(() => ({}) as never),
    receiveBatchProgress: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined),
    startFullDocument: vi.fn().mockResolvedValue(undefined),
    restart: vi.fn().mockResolvedValue(undefined),
    retryAllFailed: vi.fn().mockResolvedValue(undefined),
    retry: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    restore: vi.fn(),
    toggle: vi.fn(),
    setDisplayMode: vi.fn(),
  } satisfies ViewerTranslationController;
}

describe('PDF viewer session', () => {
  let controllers: ReturnType<typeof fakeController>[];
  let session: PdfViewerSession;
  beforeEach(() => {
    controllers = [];
    session = new PdfViewerSession(() => {
      const controller = fakeController();
      controllers.push(controller);
      return controller;
    });
  });

  it('waits for the whole document before translating and reports the wait as translating', () => {
    session.updateReader({ phase: 'loading' });
    expect(session.handleCommand({ type: 'START_TRANSLATION' })).toMatchObject({
      phase: 'translating',
    });
    session.updateReader({ phase: 'extracting', pageCount: 3, extractedPages: 1 });
    expect(controllers[0].start).not.toHaveBeenCalled();
    session.updateReader({ phase: 'ready', pageCount: 3, textPages: 3 });
    expect(controllers[0].start).toHaveBeenCalledOnce();
    expect(session.hasPendingStart()).toBe(false);
  });

  it('keeps the full-document mode of a queued request', () => {
    session.updateReader({ phase: 'loading' });
    expect(session.handleCommand({ type: 'START_FULL_DOCUMENT_TRANSLATION' })).toMatchObject({
      mode: 'full-document',
      stage: 'collecting',
    });
    session.updateReader({ phase: 'ready', pageCount: 1, textPages: 1 });
    expect(controllers[0].startFullDocument).toHaveBeenCalledOnce();
  });

  it('drops a queued request when loading fails, stops or is toggled off', () => {
    session.updateReader({ phase: 'loading' });
    session.translate();
    session.updateReader({ phase: 'error', kind: 'network', error: { text: 'offline' } });
    session.updateReader({ phase: 'ready', pageCount: 1, textPages: 1 });
    expect(controllers[0].start).not.toHaveBeenCalled();

    session.updateReader({ phase: 'loading' });
    session.handleCommand({ type: 'TOGGLE_TRANSLATION' });
    session.handleCommand({ type: 'TOGGLE_TRANSLATION' });
    session.handleCommand({ type: 'START_TRANSLATION' });
    session.handleCommand({ type: 'STOP_TRANSLATION' });
    session.updateReader({ phase: 'ready', pageCount: 1, textPages: 1 });
    expect(controllers[0].start).not.toHaveBeenCalled();
  });

  it('passes the disclosed recipient and commands to the page translator once ready', () => {
    session.updateReader({ phase: 'ready', pageCount: 1, textPages: 1 });
    const translator = { kind: 'builtin', engine: 'google-free' } as const;
    session.handleCommand({ type: 'START_TRANSLATION', translator });
    expect(controllers[0].start).toHaveBeenCalledWith(translator);
    session.handleCommand({ type: 'TOGGLE_TRANSLATION' });
    expect(controllers[0].toggle).toHaveBeenCalledOnce();
    session.handleCommand({ type: 'SET_DISPLAY_MODE', displayMode: 'translation' });
    expect(controllers[0].setDisplayMode).toHaveBeenCalledWith('translation');
    session.handleCommand({ type: 'RETRY_FAILED_TRANSLATIONS' });
    expect(controllers[0].retryAllFailed).toHaveBeenCalledOnce();
    session.handleCommand({ type: 'RESTORE_PAGE' });
    expect(controllers[0].restore).toHaveBeenCalledOnce();
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
    session.updateReader({ phase: 'ready', pageCount: 1, textPages: 1 });
    session.translate();
    expect(controllers[1].start).toHaveBeenCalledOnce();
    expect(controllers[0].start).not.toHaveBeenCalled();
  });
});
