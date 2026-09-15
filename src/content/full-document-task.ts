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
  renderTranslationError,
  renderTranslationPending,
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
const SOURCE_CHANGED = '正文已变化，请重新全文翻译';

/** One immutable document snapshot, one request, and one atomic visible commit. No cache or automatic dynamic translation. */
export class FullDocumentTranslationTask {
  private readonly abort = new AbortController();
  private readonly sessionId = crypto.randomUUID();
  private readonly render = new RenderTasks();
  private readonly metrics = new TranslationMetrics();
  private sources: SourceUnit[] = [];
  private status: PageTranslationStatus = {
    mode: 'full-document',
    phase: 'translating',
    stage: 'collecting',
    translated: 0,
    failed: 0,
    total: 0,
    displayMode: 'bilingual',
  };

  constructor(private readonly readSettings: () => Promise<PublicTranslatorSettings>) {}

  getStatus(): PageTranslationStatus {
    return { ...this.status };
  }
  getDiagnostics() {
    return this.metrics.snapshot();
  }

  async start(): Promise<void> {
    let sessionStarted = false;
    try {
      const finishPreflight = this.metrics.start('preflight');
      const settings = await this.readSettings();
      this.abort.signal.throwIfAborted();
      if (isUrlExcluded(location.href, settings.excludedSites)) throw new Error('当前站点已被排除');
      this.status.displayMode = settings.displayMode;
      const session = await sendRuntimeMessage<TranslationSessionInfo>({
        type: 'BEGIN_TRANSLATION_SESSION',
        mode: 'full-document',
        sessionId: this.sessionId,
        profileId: settings.activeProfileId,
      });
      if (!session.ok) throw new Error(session.error);
      sessionStarted = true;
      this.abort.signal.throwIfAborted();
      this.status.context = session.data.context;
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
        const pending = renderTranslationPending(this.sources[0].element, this.sources[0].id);
        pending.setAttribute('aria-label', '正在翻译全文');
        this.status.stage = 'requesting';
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
      if (!response) return;
      this.abort.signal.throwIfAborted();
      if (!response.ok) throw new Error(response.error);
      assertCompleteResult(this.sources, response.data);
      const finishRender = this.metrics.start('render');
      await this.withCurrentSnapshot(() => {
        this.status.stage = 'applying';
        // DOM writes remain framed; CSS withholds all staged translations until the final check.
        document.documentElement.setAttribute(COMMIT_ATTRIBUTE, '');
        for (const source of this.sources) {
          this.render.enqueue(() => {
            this.abort.signal.throwIfAborted();
            if (!source.element.isConnected || originalText(source.element) !== source.original)
              throw new Error(SOURCE_CHANGED);
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
    } catch (error) {
      if (this.abort.signal.aborted) return;
      this.render.stop();
      restoreDocument();
      document.documentElement.removeAttribute(COMMIT_ATTRIBUTE);
      // Restoring raw-prose anchors may remove our original element references. Recollect the
      // current first reading unit, remaining cancellable until the error control is committed.
      const first = this.sources.length ? (await this.collect().catch(() => []))[0] : undefined;
      if (this.abort.signal.aborted) return;
      this.status.phase = 'error';
      this.status.failed = this.sources.length;
      this.status.error = getErrorMessage(error);
      // Only a generic full retry enters page text; diagnostics remain in the popup.
      if (first) {
        const control = renderTranslationError(first, 'full-retry');
        control.textContent = '全文翻译失败 · 重试全文';
        control.setAttribute('aria-label', control.textContent);
        // The first reading unit can be a heading; feedback stays compact at that location.
        control.style.setProperty('font-size', '14px', 'important');
        control.style.setProperty('font-weight', '400', 'important');
        control.style.setProperty('line-height', '1.5', 'important');
      }
    } finally {
      this.status.stage = undefined;
      this.metrics.finish();
      // A begin response may arrive after stop: still retire the captured trusted session.
      if (sessionStarted)
        void sendRuntimeMessage<void>({
          type: 'END_TRANSLATION_SESSION',
          sessionId: this.sessionId,
        }).catch(() => {});
    }
  }

  stop(): void {
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
    // A newly discovered raw-prose run lacks a captured anchor and therefore is a new unit.
    const elements = units.filter((unit): unit is HTMLElement => unit instanceof HTMLElement);
    elements.sort((left, right) =>
      left === right ? 0 : left.compareDocumentPosition(right) & 4 ? -1 : 1,
    );
    if (
      elements.length !== units.length ||
      elements.length !== this.sources.length ||
      this.sources.some(
        (source, index) =>
          !source.element.isConnected ||
          elements[index] !== source.element ||
          getElementSourceText(source.element) !== source.text ||
          originalText(source.element) !== source.original,
      )
    )
      throw new Error(SOURCE_CHANGED);
  }
}

/** Ignores our feedback and wrapper nodes; protected values participate locally but never leave here. */
function originalText(element: HTMLElement): string {
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
    throw new Error('全文结果不完整或保护标记损坏，请重新全文翻译');
}
