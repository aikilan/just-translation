import { useEffect, useRef, useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import {
  ArrowRight,
  CircleAlert,
  ClipboardPaste,
  Copy,
  Languages,
  LoaderCircle,
  RotateCcw,
  Square,
  X,
} from 'lucide-react';
import { getUiLocale, renderMessage, subscribeUiLanguage, t } from '../shared/i18n';
import { LanguagePicker } from '../ui/controls';
import { TranslatorSelect } from '../ui/translator-select';
import { QuickTranslationController } from './quick-translation-controller';
import { QuickImageInput } from './quick-image-input';
import styles from './quick-translation.css?inline';

/** Browser-native modal and Shadow DOM own focus, stacking, and style isolation. */
export class QuickTranslationDialog {
  private readonly host = document.createElement('div');
  private readonly dialog = document.createElement('dialog');
  private readonly root: Root;
  private readonly unsubscribe: () => void;

  constructor(private readonly model = new QuickTranslationController()) {
    this.host.setAttribute('data-justranslate-quick', '');
    this.host.setAttribute('translate', 'no');
    this.host.className = 'notranslate';
    // The isolated content-script world retains this root; page scripts must not reach
    // file inputs or image bytes through host.shadowRoot or composed event paths.
    const shadow = this.host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = styles;
    this.dialog.setAttribute('aria-labelledby', 'quick-translation-title');
    this.dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      this.model.close();
    });
    // Native close events are queued. Do not let an earlier close dismiss a reopened dialog.
    this.dialog.addEventListener('close', () => {
      if (!this.dialog.open && this.model.getSnapshot().open) this.model.close();
    });
    shadow.append(style, this.dialog);
    document.documentElement.append(this.host);
    this.root = createRoot(this.dialog);
    // Native showModal must see the editor on the first open for stable sizing and focus.
    flushSync(() => {
      this.root.render(<QuickTranslationApp model={model} dialog={this.dialog} />);
    });
    this.unsubscribe = model.subscribe(() => {
      const { open } = model.getSnapshot();
      if (open && !this.dialog.open) this.dialog.showModal();
      if (!open && this.dialog.open) this.dialog.close();
    });
  }

  open(): void {
    // showModal can reject an inactive document; propagate that failure to the popup's ack.
    if (!this.dialog.open) this.dialog.showModal();
    void this.model.open();
  }
  close(): void {
    this.model.close();
  }
  destroy(): void {
    this.model.close();
    this.unsubscribe();
    this.root.unmount();
    this.host.remove();
  }
}

function QuickTranslationApp({
  model,
  dialog,
}: {
  model: QuickTranslationController;
  dialog: HTMLDialogElement;
}) {
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot);
  const locale = useSyncExternalStore(subscribeUiLanguage, getUiLocale);
  const input = useRef<HTMLTextAreaElement>(null);
  const pending = state.phase === 'loading';
  const disabled = pending || state.settingsLoading;
  useEffect(() => {
    dialog.lang = locale;
    dialog.dir = locale === 'ar' ? 'rtl' : 'ltr';
  }, [locale, dialog]);
  useEffect(() => {
    if (state.open) input.current?.focus({ preventScroll: true });
  }, [state.open]);
  const focusInput = () => input.current?.focus({ preventScroll: true });
  return (
    <div
      className="quick-translation"
      onKeyDown={(event) => {
        event.stopPropagation();
        if (
          (event.metaKey || event.ctrlKey) &&
          event.key === 'Enter' &&
          !event.nativeEvent.isComposing
        ) {
          event.preventDefault();
          if (!pending) void model.translate();
        }
      }}
    >
      <header className="quick-header">
        <div className="quick-brand">
          <span className="quick-logo">
            <Languages aria-hidden="true" />
          </span>
          <div>
            <h1 id="quick-translation-title">{t('快捷翻译')}</h1>
            <small>{t('只是翻译')}</small>
          </div>
        </div>
        <button
          className="icon-button"
          type="button"
          aria-label={t('关闭快捷翻译')}
          onClick={() => model.close()}
        >
          <X aria-hidden="true" />
        </button>
      </header>
      <div className="quick-workspace">
        <section className="quick-pane">
          <div className="quick-pane-header">
            <label htmlFor="quick-source">{t('原文')}</label>
            <small>{t('自动检测语言')}</small>
          </div>
          <textarea
            id="quick-source"
            ref={input}
            dir="auto"
            spellCheck={false}
            aria-label={t('原文')}
            placeholder={t('输入或粘贴需要翻译的内容…')}
            value={state.source}
            readOnly={pending}
            onChange={(event) => model.setSource(event.target.value)}
          />
          <QuickImageInput model={model} state={state} />
          <div className="quick-pane-footer">
            <div className="quick-input-actions">
              <button
                className="text-button"
                type="button"
                disabled={pending || state.pasting || state.copying}
                onClick={() => {
                  void model.paste().then(() => {
                    if (model.getSnapshot().open) focusInput();
                  });
                }}
              >
                {state.pasting ? (
                  <LoaderCircle className="spin" aria-hidden="true" />
                ) : (
                  <ClipboardPaste aria-hidden="true" />
                )}
                {t('粘贴')}
              </button>
              <button
                className="text-button"
                type="button"
                disabled={pending || !state.source}
                onClick={() => {
                  model.setSource('');
                  focusInput();
                }}
              >
                {t('清空')}
              </button>
            </div>
            <small className="quick-count">
              {t('{{p0}} 字符', { p0: Array.from(state.source).length })}
            </small>
          </div>
        </section>
        <section className="quick-pane quick-result-pane">
          <div className="quick-pane-header">
            <span>{t('译文')}</span>
            {state.translator ? (
              <LanguagePicker
                label={t('翻译为')}
                value={state.targetLanguage}
                allowCustom={state.translator.kind === 'ai'}
                disabled={disabled}
                onChange={(value) => model.setTargetLanguage(value)}
                onDraftChange={(value) => model.setTargetLanguage(value)}
              />
            ) : null}
          </div>
          <div className="quick-output" aria-live="polite" aria-busy={pending}>
            {pending ? (
              <div className="quick-pending">
                <LoaderCircle className="spin" aria-hidden="true" />
                {t('翻译中…')}
              </div>
            ) : state.phase === 'error' ? (
              <div className="quick-error" role="alert">
                <strong>
                  <CircleAlert aria-hidden="true" />
                  {t('暂时无法翻译')}
                </strong>
                <p>{renderMessage(state.error)}</p>
                <button
                  className="text-button"
                  type="button"
                  onClick={() => void model.translate()}
                >
                  <RotateCcw aria-hidden="true" />
                  {t('重试')}
                </button>
              </div>
            ) : state.result && 'status' in state.result && state.result.status === 'no-text' ? (
              <span className="quick-placeholder">{t('未识别到可翻译文字')}</span>
            ) : state.result ? (
              <div className="quick-result" data-quick-result dir="auto" tabIndex={0}>
                {state.result.text}
              </div>
            ) : (
              <span className="quick-placeholder">{t('译文将显示在这里')}</span>
            )}
          </div>
          <div className="quick-pane-footer">
            <small className="quick-success">
              {state.phase === 'success' && state.result?.text ? t('翻译完成') : ''}
            </small>
            <button
              className="text-button"
              type="button"
              disabled={!state.result?.text || state.copying || state.pasting}
              onClick={() => void model.copy()}
            >
              <Copy aria-hidden="true" />
              {t('复制译文')}
            </button>
          </div>
        </section>
      </div>
      {state.settingsError ? (
        <div className="quick-notice" role="alert">
          <span>{renderMessage(state.settingsError)}</span>
          <button className="text-button" type="button" onClick={() => void model.reloadSettings()}>
            {t('重新加载')}
          </button>
        </div>
      ) : null}
      {state.feedback ? (
        <div className="quick-feedback" role="status">
          {renderMessage(state.feedback)}
        </div>
      ) : null}
      <footer className="quick-footer">
        <div className="quick-engine">
          <span>{t('翻译引擎')}</span>
          {state.translator && state.settings ? (
            <TranslatorSelect
              activeTranslator={state.translator}
              profiles={state.settings.profiles}
              disabled={disabled}
              onChange={(value) => model.setTranslator(value)}
            />
          ) : (
            <small role="status">
              {state.settingsLoading ? t('正在读取插件状态…') : t('无法读取插件状态')}
            </small>
          )}
        </div>
        <div className="quick-submit">
          <small className="quick-shortcut">⌘ / Ctrl + Enter</small>
          <button
            className="primary-button"
            type="button"
            disabled={!pending && !model.canTranslate}
            onClick={() => (pending ? model.stop() : void model.translate())}
          >
            {pending ? <Square aria-hidden="true" /> : null}
            {pending ? t('停止翻译') : state.result ? t('重新翻译') : t('翻译')}
            {!pending ? <ArrowRight aria-hidden="true" /> : null}
          </button>
        </div>
        <small className="quick-disclosure">{t('输入内容会发送到所选翻译服务。')}</small>
      </footer>
    </div>
  );
}
