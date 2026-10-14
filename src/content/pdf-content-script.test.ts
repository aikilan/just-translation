// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import type { PageCommand, RuntimeRequest } from '../shared/messages';

const pdf = vi.hoisted(() => ({
  mount: vi.fn<(onTranslate: () => void) => () => void>(() => () => {}),
}));
const controller = vi.hoisted(() => ({
  start: vi.fn().mockResolvedValue(undefined),
  startFullDocument: vi.fn().mockResolvedValue(undefined),
  toggle: vi.fn(),
  getStatus: vi.fn(() => ({
    mode: 'segmented',
    phase: 'idle',
    translated: 0,
    failed: 0,
    total: 0,
    displayMode: 'bilingual',
  })),
}));
vi.mock('./pdf-entry', () => ({ isBrowserPdfDocument: () => true, mountPdfEntry: pdf.mount }));
vi.mock('./controller', () => ({
  TranslationController: class {
    start = controller.start;
    startFullDocument = controller.startFullDocument;
    toggle = controller.toggle;
    getStatus = controller.getStatus;
    stop = vi.fn();
  },
}));
vi.mock('./ui-language', () => ({ initializeContentLanguage: vi.fn() }));
vi.mock('./retry-interaction', () => ({ registerRetryInteractions: vi.fn() }));

let message: (command: PageCommand, sender: unknown, respond: (value: unknown) => void) => void;
let sendMessage: ReturnType<typeof vi.fn<(request: RuntimeRequest) => Promise<unknown>>>;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  sendMessage = vi.fn(() => Promise.resolve({ ok: true, data: { excludedSites: [] } }));
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage,
      onMessage: {
        addListener: (listener: typeof message) => {
          message = listener;
        },
      },
    },
  });
  await import('./content-script');
});

it('offers the PDF reader instead of starting webpage translation on a browser PDF', async () => {
  await vi.waitFor(() => expect(pdf.mount).toHaveBeenCalledOnce());
  // Automatic site translation never runs on a PDF; only settings were read for exclusions.
  expect(sendMessage.mock.calls.map(([request]) => request.type)).toEqual(['GET_PUBLIC_SETTINGS']);
  pdf.mount.mock.calls[0][0]();
  expect(sendMessage).toHaveBeenLastCalledWith({ type: 'OPEN_PDF_VIEWER', translate: 'segmented' });
});

it('does not inject the entry on an excluded site', async () => {
  vi.resetModules();
  vi.clearAllMocks();
  sendMessage.mockResolvedValue({ ok: true, data: { excludedSites: [location.hostname] } });
  await import('./content-script');
  await vi.waitFor(() => expect(sendMessage).toHaveBeenCalled());
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(pdf.mount).not.toHaveBeenCalled();
});

it.each([
  ['START_TRANSLATION', 'segmented'],
  ['TOGGLE_TRANSLATION', 'segmented'],
  ['START_FULL_DOCUMENT_TRANSLATION', 'full-document'],
] as const)('routes %s to the reader and reports a PDF document', (type, translate) => {
  const respond = vi.fn();
  message({ type }, {}, respond);
  expect(sendMessage).toHaveBeenCalledWith({ type: 'OPEN_PDF_VIEWER', translate });
  expect(controller.start).not.toHaveBeenCalled();
  expect(controller.startFullDocument).not.toHaveBeenCalled();
  expect(controller.toggle).not.toHaveBeenCalled();
  expect(respond).toHaveBeenCalledWith(expect.objectContaining({ pdfDocument: true }));
});

it('answers status queries without opening the reader', () => {
  const respond = vi.fn();
  sendMessage.mockClear();
  message({ type: 'GET_PAGE_STATUS' }, {}, respond);
  expect(sendMessage).not.toHaveBeenCalled();
  expect(respond).toHaveBeenCalledWith(
    expect.objectContaining({ phase: 'idle', pdfDocument: true }),
  );
});
