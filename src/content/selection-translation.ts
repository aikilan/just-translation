import { message, LocalizedError } from '../shared/i18n';
import { sendRuntimeMessage } from '../shared/chrome-api';
import {
  getErrorMessage,
  type Result,
  type RuntimeRequest,
  type SelectionTranslationResult,
} from '../shared/messages';
import { SelectionTranslationView, type SelectionAnchor } from './selection-translation-view';

type SelectionSender = (request: RuntimeRequest) => Promise<Result<unknown>>;

/** One active selection per document. Identity checks also retire responses that cannot be aborted. */
export class SelectionTranslationController {
  private active?: {
    requestId: string;
    text: string;
    anchor: SelectionAnchor;
    view: SelectionTranslationView;
  };
  constructor(private readonly send: SelectionSender = sendRuntimeMessage) {}

  start(text: string, anchor: SelectionAnchor): void {
    if (!text.trim()) return;
    this.close();
    const requestId = crypto.randomUUID();
    const view = new SelectionTranslationView({
      close: () => this.close(),
      retry: () => this.start(text, anchor),
    });
    const task = { requestId, text, anchor, view };
    this.active = task;
    view.show(text, anchor);
    if (this.active !== task) return;
    void this.translate(task);
  }

  close(): void {
    const task = this.active;
    if (!task) return;
    this.active = undefined;
    task.view.destroy();
    void this.send({ type: 'CANCEL_SELECTION_TRANSLATION', requestId: task.requestId }).catch(
      () => undefined,
    );
  }

  private async translate(
    task: NonNullable<SelectionTranslationController['active']>,
  ): Promise<void> {
    try {
      const result = await this.send({
        type: 'TRANSLATE_SELECTION',
        requestId: task.requestId,
        text: task.text,
      });
      if (this.active !== task) return;
      if (!result.ok) throw new LocalizedError(result.error);
      if (!isTranslationResult(result.data))
        throw new LocalizedError(message('后台未返回有效译文，请重试'));
      task.view.success(result.data);
    } catch (error) {
      if (this.active === task) task.view.error(getErrorMessage(error));
    }
  }
}

function isTranslationResult(value: unknown): value is SelectionTranslationResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    'text' in value &&
    typeof value.text === 'string' &&
    'targetLanguage' in value &&
    typeof value.targetLanguage === 'string'
  );
}

/** Snapshot geometry before the native menu/focus changes; Chrome supplies the actual request text. */
export function captureSelectionAnchor(event: MouseEvent, target: Element): SelectionAnchor {
  const editable = target.closest(
    'input,textarea,[contenteditable]:not([contenteditable="false"])',
  );
  const selection = window.getSelection();
  if (!editable && selection && !selection.isCollapsed && selection.rangeCount) {
    const range = selection.getRangeAt(0).cloneRange();
    const start = range.startContainer;
    const end = range.endContainer;
    return {
      getRect: () => (start.isConnected && end.isConnected ? range.getBoundingClientRect() : null),
    };
  }
  const element = editable ?? target;
  const rect = element.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  return {
    getRect: () => {
      if (!element.isConnected) return null;
      const current = element.getBoundingClientRect();
      const left = current.left + x;
      const top = current.top + y;
      return { left, right: left, top, bottom: top };
    },
  };
}
