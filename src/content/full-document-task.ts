import { message, LocalizedError } from '../shared/i18n';
import { FullDocumentStatusView, isFullDocumentStatusMutation } from './full-document-status-view';
import { getTitleSourceText, isDocumentTitle } from './document-title';
import { getLabelText } from './label-presentation';
import type { TranslationUnit } from '../shared/batching';
import { sendRuntimeMessage } from '../shared/chrome-api';
import {
  getErrorMessage,
  type PageTranslationStatus,
  type PublicTranslatorSettings,
  type TranslationSessionInfo,
} from '../shared/messages';
import { preservesProtectedMarkers } from '../shared/protected-markers';
import { isUrlExcluded, type DisplayMode } from '../shared/settings';
import { TranslationMetrics } from '../shared/translation-metrics';
import {
  discoverTranslatableElements,
  collectOriginalReadingUnits,
  discoverOriginalReadingUnits,
  type OriginalReadingUnit,
  getElementSourceText,
  prepareTranslationRender,
  restoreDocument,
  setDocumentDisplayMode,
} from './dom-translator';
import { RenderTasks } from './render-tasks';

interface SourceUnit extends TranslationUnit {
  element: HTMLElement;
  /** Kept exclusively in the content script, including protected text, for source validation. */
  original: string;
}
const COMMIT_ATTRIBUTE = 'data-justranslate-full-pending';
const SOURCE_CHANGED = message('正文已变化，请重新全文翻译');

/** Completed snapshot handed to the ordinary scheduler without exposing provider configuration. */
export interface FullDocumentResult {
  session: TranslationSessionInfo;
  sources: Array<SourceUnit & { translatedText: string }>;
}

/** One immutable initial snapshot and one atomic commit; the controller owns later additions. */
export class FullDocumentTranslationTask {
  private readonly abort = new AbortController();
  private readonly sessionId = crypto.randomUUID();
  private readonly render = new RenderTasks();
  private readonly metrics = new TranslationMetrics();
  private sources: SourceUnit[] = [];
  private readonly view: FullDocumentStatusView;
  private status: PageTranslationStatus = {
    mode: 'full-document',
    phase: 'translating',
    stage: 'collecting',
    translated: 0,
    failed: 0,
    total: 0,
    displayMode: 'bilingual',
  };

  constructor(
    private readonly readSettings: () => Promise<PublicTranslatorSettings>,
    private readonly onCollect: (settings: PublicTranslatorSettings) => void,
    actions: { stop: () => void; retry: () => void },
  ) {
    this.view = new FullDocumentStatusView(actions);
  }

  getStatus(): PageTranslationStatus {
    return { ...this.status };
  }
  getDiagnostics() {
    return this.metrics.snapshot();
  }

  async start(): Promise<FullDocumentResult | undefined> {
    let sessionStarted = false;
    this.view.update(this.status);
    try {
      const finishPreflight = this.metrics.start('preflight');
      const settings = await this.readSettings();
      this.abort.signal.throwIfAborted();
      if (isUrlExcluded(location.href, settings.excludedSites))
        throw new LocalizedError(message('当前站点已被排除'));
      if (!settings.supportsFullDocument)
        throw new LocalizedError(message('全文上下文翻译仅支持 AI 配置'));
      this.status.displayMode = settings.displayMode;
      const session = await sendRuntimeMessage<TranslationSessionInfo>({
        type: 'BEGIN_TRANSLATION_SESSION',
        mode: 'full-document',
        sessionId: this.sessionId,
        translator: settings.activeTranslator,
      });
      if (!session.ok) throw new LocalizedError(session.error);
      sessionStarted = true;
      this.abort.signal.throwIfAborted();
      if (!session.data?.configurationId) throw new LocalizedError(message('翻译会话缺少配置指纹'));
      this.status.context = session.data.context;
      this.onCollect(settings);
      finishPreflight();
      const finishDiscovery = this.metrics.start('discovery');
      this.sources = (await this.collect()).map((element, index) => ({
        id: `full-${index}`,
        element,
        text: getElementSourceText(element),
        original: originalText(element),
      }));
      this.status.total = this.sources.length;
      // Keep the last source check and request dispatch in one uninterrupted turn.
      const response = await this.withCurrentSnapshot(() => {
        finishDiscovery();
        if (!this.sources.length) {
          this.status.phase = 'complete';
          return undefined;
        }
        this.status.stage = 'requesting';
        this.view.update(this.status);
        // Only IDs and protected source text cross the extension message boundary.
        const units = this.sources.map(({ id, text }) => ({ id, text }));
        this.metrics.recordBatch(
          units.length,
          units.reduce((sum, unit) => sum + unit.text.length, 0),
        );
        return sendRuntimeMessage<Record<string, string>>({
          type: 'TRANSLATE_FULL_DOCUMENT',
          sessionId: this.sessionId,
          units,
        });
      });
      if (!response) return { session: session.data, sources: [] };
      this.abort.signal.throwIfAborted();
      if (!response.ok) throw new LocalizedError(response.error);
      assertCompleteResult(this.sources, response.data);
      const finishRender = this.metrics.start('render');
      await this.withCurrentSnapshot(() => {
        this.status.stage = 'applying';
        this.view.update(this.status);
        // DOM writes remain framed; CSS withholds all staged translations until the final check.
        document.documentElement.setAttribute(COMMIT_ATTRIBUTE, '');
        for (const source of this.sources) {
          this.render.enqueue(() => {
            this.abort.signal.throwIfAborted();
            if (!source.element.isConnected || originalText(source.element) !== source.original)
              throw new LocalizedError(SOURCE_CHANGED);
            return prepareTranslationRender(source.element, response.data[source.id]);
          });
        }
      });
      await this.render.waitForIdle();
      await this.withCurrentSnapshot(() => {
        setDocumentDisplayMode(this.status.displayMode);
        document.documentElement.removeAttribute(COMMIT_ATTRIBUTE);
        this.status.translated = this.sources.length;
        this.status.phase = 'complete';
        finishRender();
        this.metrics.markFirstTranslation();
      });
      this.abort.signal.throwIfAborted();
      return {
        session: session.data,
        sources: this.sources.map((source) => ({
          ...source,
          translatedText: response.data[source.id],
        })),
      };
    } catch (error) {
      if (this.abort.signal.aborted) return;
      this.render.stop();
      restoreDocument();
      document.documentElement.removeAttribute(COMMIT_ATTRIBUTE);
      if (this.abort.signal.aborted) return;
      this.status.phase = 'error';
      this.status.failed = this.sources.length;
      this.status.error = getErrorMessage(error);
    } finally {
      this.status.stage = undefined;
      this.view.update(this.status);
      this.metrics.finish();
      // A begin response may arrive after stop: still retire the captured trusted session.
      if (sessionStarted)
        void sendRuntimeMessage<void>({
          type: 'END_TRANSLATION_SESSION',
          sessionId: this.sessionId,
        }).catch(() => {});
    }
  }

  /** Close the last await boundary before the controller adopts these exact source identities. */
  confirmHandoff(): boolean {
    try {
      this.assertMatchingSources(
        collectOriginalReadingUnits(document.body, { url: location.href }),
      );
      return true;
    } catch (error) {
      restoreDocument();
      this.status.phase = 'error';
      this.status.translated = 0;
      this.status.failed = this.sources.length;
      this.status.error = getErrorMessage(error);
      this.view.update(this.status);
      return false;
    }
  }

  stop(): void {
    this.view.destroy();
    if (this.status.phase === 'complete') {
      // Stop can arrive between the atomic commit and the controller's asynchronous handoff.
      this.abort.abort();
      this.status.phase = 'stopped';
      return;
    }
    if (this.status.phase !== 'translating') return;
    this.abort.abort();
    this.render.stop();
    restoreDocument();
    document.documentElement.removeAttribute(COMMIT_ATTRIBUTE);
    this.status.phase = 'stopped';
    this.status.stage = undefined;
    this.metrics.finish();
    void sendRuntimeMessage<void>({
      type: 'CANCEL_TRANSLATION_REQUESTS',
      sessionId: this.sessionId,
    }).catch(() => {});
  }

  setDisplayMode(mode: DisplayMode): void {
    this.status.displayMode = mode;
    if (this.status.phase === 'complete') setDocumentDisplayMode(mode);
  }

  private async collect(): Promise<HTMLElement[]> {
    const elements: HTMLElement[] = [];
    for await (const chunk of discoverTranslatableElements(document.body, {
      url: location.href,
      signal: this.abort.signal,
    }))
      elements.push(...chunk);
    this.abort.signal.throwIfAborted();
    return elements.sort((left, right) =>
      left === right ? 0 : left.compareDocumentPosition(right) & 4 ? -1 : 1,
    );
  }

  /** Budget the normal scan; if DOM changed across its yields, make one atomic read-only
   * sweep before committing. No page JS runs between that sweep and commit, so unrelated
   * animations need not stop, while insertions into an already-scanned branch cannot slip in. */
  private async withCurrentSnapshot<T>(commit: () => T): Promise<T> {
    let changed = false;
    const inspect = (records: MutationRecord[]) => {
      changed ||= records.some((record) => {
        if (isFullDocumentStatusMutation(record)) return false;
        const element =
          record.target instanceof Element ? record.target : record.target.parentElement;
        return !element?.closest('[data-justranslate-translation]');
      });
    };
    const observer = new MutationObserver(inspect);
    // Ancestors, newly preferred scopes and stylesheets can affect reading eligibility too.
    observer.observe(document, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
    try {
      const current: OriginalReadingUnit[] = [];
      for await (const chunk of discoverOriginalReadingUnits(document.body, {
        url: location.href,
        signal: this.abort.signal,
      }))
        current.push(...chunk);
      this.abort.signal.throwIfAborted();
      inspect(observer.takeRecords());
      this.assertMatchingSources(
        changed ? collectOriginalReadingUnits(document.body, { url: location.href }) : current,
      );
      this.abort.signal.throwIfAborted();
      return commit();
    } finally {
      observer.disconnect();
    }
  }

  private assertMatchingSources(units: OriginalReadingUnit[]): void {
    // New independent units are queued for incremental translation; captured units must survive unchanged.
    const captured = new Set(this.sources.map((source) => source.element));
    const elements = units.filter(
      (unit): unit is HTMLElement => unit instanceof HTMLElement && captured.has(unit),
    );
    elements.sort((left, right) =>
      left === right ? 0 : left.compareDocumentPosition(right) & 4 ? -1 : 1,
    );
    if (
      elements.length !== this.sources.length ||
      this.sources.some(
        (source, index) =>
          !source.element.isConnected ||
          elements[index] !== source.element ||
          getElementSourceText(source.element) !== source.text ||
          originalText(source.element) !== source.original,
      )
    )
      throw new LocalizedError(SOURCE_CHANGED);
  }
}

/** Ignores our feedback and wrapper nodes; protected values participate locally but never leave here. */
function originalText(element: HTMLElement): string {
  if (isDocumentTitle(element)) return getTitleSourceText(element);
  const label = getLabelText(element);
  if (label !== undefined) return label;
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest('[data-justranslate-translation]')
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  const parts: string[] = [];
  while (walker.nextNode()) parts.push(walker.currentNode.textContent ?? '');
  return parts.join('');
}

function assertCompleteResult(units: TranslationUnit[], result: Record<string, string>): void {
  if (
    !result ||
    Object.keys(result).length !== units.length ||
    units.some(
      (unit) =>
        !Object.hasOwn(result, unit.id) ||
        typeof result[unit.id] !== 'string' ||
        !result[unit.id].trim() ||
        !preservesProtectedMarkers(unit.text, result[unit.id]),
    )
  )
    throw new LocalizedError(message('全文结果不完整或保护标记损坏，请重新全文翻译'));
}
