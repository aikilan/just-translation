import {
  ArrowUpRight,
  CircleAlert,
  Columns2,
  FileText,
  FolderOpen,
  LoaderCircle,
  Play,
  RotateCcw,
  Rows3,
  Settings,
  SlidersHorizontal,
  Square,
} from 'lucide-react';
import { useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { sendRuntimeMessage } from '../shared/chrome-api';
import {
  getUiLocale,
  i18n,
  LocalizedError,
  renderMessage,
  setUiLanguage,
  t,
  type UiMessage,
} from '../shared/i18n';
import {
  getErrorMessage,
  type PageCommand,
  type PageTranslationStatus,
  type PublicTranslatorSettings,
} from '../shared/messages';
import { activeTranslatorEquals } from '../shared/translation-engines';
import { translationLanguageLabel } from '../shared/translation-languages';
import {
  DisplayModeControl,
  LanguagePicker,
  SettingRow,
  useSettingsMutation,
} from '../ui/controls';
import { TranslatorDisclosure, TranslatorSelect } from '../ui/translator-select';
import type { PdfReaderState } from './pdf-reader';
import type { ViewerStore } from './viewer-store';

export type PdfLayout = 'split' | 'reading';

/** Pages handed to the translator; `following` means newly reached pages keep being added. */
export interface PageProgress {
  unlocked: number;
  total: number;
  following: boolean;
}

export interface PdfViewerAppProps {
  store: ViewerStore;
  getStatus: () => PageTranslationStatus;
  getPageProgress: () => PageProgress;
  runCommand: (command: PageCommand) => void;
  onOpenFile: (file: File) => void;
  onSubmitPassword: (password: string) => void;
  onLayoutChange: (layout: PdfLayout) => void;
  onRetryLoad: () => void;
}

/** Toolbar and document states of the PDF viewer; the document itself is rendered outside React. */
export function PdfViewerApp({
  store,
  getStatus,
  getPageProgress,
  runCommand,
  onOpenFile,
  onSubmitPassword,
  onLayoutChange,
  onRetryLoad,
}: PdfViewerAppProps) {
  const viewer = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [settings, setSettings] = useState<PublicTranslatorSettings>();
  const [loadError, setLoadError] = useState<UiMessage>();
  const [status, setStatus] = useState(getStatus);
  const [pages, setPages] = useState(getPageProgress);
  const [panelOpen, setPanelOpen] = useState(false);
  const settingsRevision = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const { feedback, save } = useSettingsMutation();
  useTranslation(undefined, { i18n });
  const locale = getUiLocale();

  useEffect(() => {
    let alive = true;
    async function refresh() {
      const request = ++settingsRevision.current;
      try {
        const result = await sendRuntimeMessage<PublicTranslatorSettings>({
          type: 'GET_PUBLIC_SETTINGS',
        });
        if (!result.ok) throw new LocalizedError(result.error);
        if (alive && request === settingsRevision.current) {
          setSettings(result.data);
          setLoadError(undefined);
        }
      } catch (error) {
        if (alive && request === settingsRevision.current) setLoadError(getErrorMessage(error));
      }
    }
    void refresh();
    const changed = (_changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local') void refresh();
    };
    chrome.storage.onChanged.addListener(changed);
    return () => {
      alive = false;
      chrome.storage.onChanged.removeListener(changed);
    };
  }, []);

  useEffect(() => {
    if (settings) setUiLanguage(settings.uiLanguage);
  }, [settings?.uiLanguage]);

  useEffect(() => {
    // The toolbar follows the interface language; the PDF text keeps its own direction.
    document.documentElement.lang = locale;
    document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr';
  }, [locale]);

  useEffect(() => {
    document.title = viewer.fileName ? `${viewer.fileName} · ${t('只是翻译')}` : t('只是翻译');
  }, [viewer.fileName, locale]);

  useEffect(() => {
    const timer = setInterval(() => {
      setStatus(getStatus());
      setPages(getPageProgress());
    }, 400);
    return () => clearInterval(timer);
  }, [getStatus, getPageProgress]);

  function command(value: PageCommand) {
    runCommand(value);
    setStatus(getStatus());
    setPages(getPageProgress());
  }

  function accept(value: PublicTranslatorSettings) {
    settingsRevision.current += 1;
    setSettings(value);
  }

  const reader = viewer.reader;
  const documentReady = reader.phase === 'ready';
  const documentWorking = reader.phase === 'loading' || reader.phase === 'extracting';
  const contextChanged = Boolean(
    settings &&
    status.context &&
    (!activeTranslatorEquals(settings.activeTranslator, status.context.translator) ||
      settings.targetLanguage !== status.context.targetLanguage),
  );
  const needsRestart = status.context ? contextChanged : Boolean(status.needsRestart);
  const fullDocument = status.mode === 'full-document';
  const incremental = fullDocument && status.stage === 'incremental';
  const translating = status.phase === 'translating';
  const canTranslate = Boolean(settings?.ready) && (documentReady || documentWorking);
  const saving = Object.values(feedback).some((value) => value?.status === 'saving');

  const complete = status.phase === 'complete' && status.total > 0;
  const action = needsRestart
    ? t('用新设置重新翻译')
    : translating
      ? t('停止翻译')
      : (!fullDocument || incremental) && status.failed > 0
        ? t('重试全部失败')
        : complete
          ? t('恢复原文')
          : fullDocument
            ? t('重新全文翻译')
            : status.phase === 'stopped'
              ? t('继续翻译')
              : status.phase === 'error'
                ? t('重新翻译')
                : t('翻译此 PDF');

  /** Same order as the popup; a finished document toggles back to the original like Alt+T. */
  function primaryAction() {
    if (needsRestart) command({ type: 'RESTART_TRANSLATION' });
    else if (translating) command({ type: 'STOP_TRANSLATION' });
    else if ((!fullDocument || incremental) && status.failed > 0)
      command({ type: 'RETRY_FAILED_TRANSLATIONS' });
    else if (complete) command({ type: 'RESTORE_PAGE' });
    else if (fullDocument) command({ type: 'START_FULL_DOCUMENT_TRANSLATION' });
    else command({ type: 'START_TRANSLATION' });
  }

  const statusText = describeStatus(reader, status, needsRestart, pages);
  const pageLabel =
    viewer.pageCount > 0
      ? t('第 {{p0}} / {{p1}} 页', { p0: viewer.currentPage || 1, p1: viewer.pageCount })
      : '';

  return (
    <>
      <header className="viewer-toolbar" translate="no">
        <div className="viewer-file">
          <img src="/icons/icon.svg" alt="" className="viewer-logo" />
          <div className="viewer-file-copy">
            <strong title={viewer.sourceUrl ?? viewer.fileName}>
              {viewer.fileName || t('只是翻译')}
            </strong>
            <small>{[pageLabel, statusText].filter(Boolean).join(' · ') || t('PDF 翻译')}</small>
          </div>
        </div>
        <div className="viewer-actions">
          <div className="segmented-control" role="group" aria-label={t('页面布局')}>
            <button
              type="button"
              aria-pressed={viewer.layout === 'split'}
              title={t('原版对照')}
              onClick={() => onLayoutChange('split')}
            >
              <Columns2 aria-hidden="true" />
              <span className="viewer-label">{t('原版对照')}</span>
            </button>
            <button
              type="button"
              aria-pressed={viewer.layout === 'reading'}
              title={t('阅读模式')}
              onClick={() => onLayoutChange('reading')}
            >
              <Rows3 aria-hidden="true" />
              <span className="viewer-label">{t('阅读模式')}</span>
            </button>
          </div>
          {settings ? (
            <DisplayModeControl
              value={status.context || status.total ? status.displayMode : settings.displayMode}
              disabled={saving}
              onChange={(displayMode) => {
                void save(
                  'mode',
                  { type: 'UPDATE_READING_PREFERENCES', patch: { displayMode } },
                  (next) => {
                    accept(next);
                    command({ type: 'SET_DISPLAY_MODE', displayMode });
                  },
                );
              }}
            />
          ) : null}
          <button
            type="button"
            className={`button ${(translating || complete) && !needsRestart ? '' : 'button-primary'}`}
            disabled={(!complete && !canTranslate) || saving}
            onClick={primaryAction}
          >
            {translating && !needsRestart ? (
              <Square aria-hidden="true" />
            ) : (((!fullDocument || incremental) && status.failed > 0) || complete) &&
              !needsRestart ? (
              <RotateCcw aria-hidden="true" />
            ) : (
              <Play aria-hidden="true" />
            )}
            {action}
          </button>
          {!fullDocument || (incremental && status.failed > 0) ? (
            <button
              type="button"
              className="icon-button"
              aria-label={t('全文完整翻译')}
              title={
                settings?.supportsFullDocument
                  ? t('让 AI 一次理解全文，保留跨段上下文；会重新翻译当前已加载的正文。')
                  : t('仅支持 AI 配置')
              }
              disabled={!canTranslate || saving || !settings?.supportsFullDocument}
              onClick={() => command({ type: 'START_FULL_DOCUMENT_TRANSLATION' })}
            >
              <FileText aria-hidden="true" />
            </button>
          ) : null}
          {complete && !needsRestart ? null : (
            <button
              type="button"
              className="icon-button"
              aria-label={t('恢复原文')}
              title={t('恢复原文')}
              disabled={!status.total && !translating}
              onClick={() => command({ type: 'RESTORE_PAGE' })}
            >
              <RotateCcw aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            className="icon-button"
            aria-label={t('翻译设置')}
            title={t('翻译设置')}
            aria-expanded={panelOpen}
            aria-controls="viewer-panel"
            onClick={() => setPanelOpen((open) => !open)}
          >
            <SlidersHorizontal aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label={t('打开 PDF 文件')}
            title={t('打开 PDF 文件')}
            onClick={() => fileInput.current?.click()}
          >
            <FolderOpen aria-hidden="true" />
          </button>
          {viewer.sourceUrl && /^https?:/u.test(viewer.sourceUrl) ? (
            <a
              className="icon-button"
              href={viewer.sourceUrl}
              aria-label={t('在浏览器中打开原 PDF')}
              title={t('在浏览器中打开原 PDF')}
            >
              <ArrowUpRight aria-hidden="true" />
            </a>
          ) : null}
          <input
            ref={fileInput}
            type="file"
            accept="application/pdf,.pdf"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) onOpenFile(file);
            }}
          />
        </div>
        {reader.phase === 'extracting' ? (
          <div
            className="viewer-progress"
            role="progressbar"
            aria-label={t('PDF 解析进度')}
            aria-valuemin={0}
            aria-valuemax={reader.pageCount}
            aria-valuenow={reader.extractedPages}
          >
            <span
              style={{ width: `${(reader.extractedPages / Math.max(1, reader.pageCount)) * 100}%` }}
            />
          </div>
        ) : null}
      </header>
      {panelOpen ? (
        <section id="viewer-panel" className="viewer-panel" translate="no">
          {settings ? (
            <>
              <SettingRow label={t('翻译引擎')} feedback={feedback.profile}>
                <TranslatorSelect
                  activeTranslator={settings.activeTranslator}
                  profiles={settings.profiles}
                  disabled={saving}
                  onChange={(translator) => {
                    void save('profile', { type: 'SET_ACTIVE_TRANSLATOR', translator }, accept);
                  }}
                />
              </SettingRow>
              <p className="translator-disclosure">
                <TranslatorDisclosure translator={settings.activeTranslator} />
              </p>
              <SettingRow label={t('翻译为')} feedback={feedback.language}>
                <LanguagePicker
                  label={t('翻译为')}
                  value={settings.targetLanguage}
                  allowCustom={settings.activeTranslator.kind === 'ai'}
                  builtinEngine={
                    settings.activeTranslator.kind === 'builtin'
                      ? settings.activeTranslator.engine
                      : undefined
                  }
                  disabled={saving}
                  onChange={(targetLanguage) => {
                    void save(
                      'language',
                      { type: 'UPDATE_READING_PREFERENCES', patch: { targetLanguage } },
                      accept,
                    );
                  }}
                />
              </SettingRow>
              {needsRestart && status.context ? (
                <p className="viewer-note">
                  {t('当前译文保留{{p0}}，重新翻译后应用新设置。', {
                    p0: `（${translationLanguageLabel(status.context.targetLanguage)}）`,
                  })}
                </p>
              ) : null}
            </>
          ) : null}
          <button
            type="button"
            className="text-button"
            onClick={() => void chrome.runtime.openOptionsPage()}
          >
            <Settings aria-hidden="true" />
            {t('打开设置')}
          </button>
        </section>
      ) : null}
      {settings && !settings.ready && reader.phase !== 'empty' ? (
        <div className="viewer-banner" role="alert" translate="no">
          <CircleAlert aria-hidden="true" />
          <span>
            {settings.configurationError
              ? renderMessage(settings.configurationError)
              : t('当前翻译引擎不可用')}
          </span>
        </div>
      ) : null}
      {status.error && !translating ? (
        <div className="viewer-banner" role="alert" translate="no">
          <CircleAlert aria-hidden="true" />
          <span>{renderMessage(status.error)}</span>
        </div>
      ) : null}
      {loadError ? (
        <div className="viewer-banner" role="alert" translate="no">
          <CircleAlert aria-hidden="true" />
          <span>{renderMessage(loadError)}</span>
        </div>
      ) : null}
      <DocumentState
        reader={reader}
        sourceUrl={viewer.sourceUrl}
        onChooseFile={() => fileInput.current?.click()}
        onSubmitPassword={onSubmitPassword}
        onRetryLoad={onRetryLoad}
      />
    </>
  );
}

function describeStatus(
  reader: PdfReaderState,
  status: PageTranslationStatus,
  needsRestart: boolean,
  pages: PageProgress,
): string {
  if (reader.phase === 'loading')
    return reader.percent === undefined
      ? t('正在加载 PDF…')
      : t('正在加载 PDF… {{p0}}%', { p0: reader.percent });
  if (reader.phase === 'extracting')
    return t('正在解析 {{p0}} / {{p1}} 页', { p0: reader.extractedPages, p1: reader.pageCount });
  if (reader.phase !== 'ready') return '';
  if (needsRestart) return t('新设置已就绪');
  const fullDocument = status.mode === 'full-document';
  const incremental = fullDocument && status.stage === 'incremental';
  const counts =
    status.total > 0
      ? [
          t('translatedCount', { translated: status.translated, count: status.total }),
          ...(status.failed ? [t('failedCount', { count: status.failed })] : []),
        ].join(' · ')
      : '';
  if (status.phase === 'translating') {
    if (fullDocument)
      return {
        collecting: t('收集全文'),
        requesting: t('全文翻译中'),
        applying: t('回填译文'),
        incremental: t('正在补译新内容'),
      }[status.stage ?? 'collecting'];
    return counts || t('正在翻译');
  }
  if (fullDocument && !incremental && status.phase === 'error') return t('全文翻译失败');
  if (status.failed > 0) return `${t('部分段落未完成')} · ${counts}`;
  if (status.phase === 'complete' && pages.following && pages.unlocked < pages.total)
    // Lazy translation is only finished for the pages read so far.
    return t('已翻译 {{p0}} / {{p1}} 页，滚动到的页面会继续翻译', {
      p0: pages.unlocked,
      p1: pages.total,
    });
  if (status.phase === 'complete')
    return status.total ? `${t('翻译完成')} · ${counts}` : t('未发现需要翻译的内容');
  if (status.phase === 'stopped') return t('已停止');
  if (status.phase === 'error') return t('暂时无法翻译');
  if (reader.textPages === 0) return t('未找到可提取的文字，可能是扫描件；暂不支持 OCR。');
  return '';
}

function DocumentState({
  reader,
  sourceUrl,
  onChooseFile,
  onSubmitPassword,
  onRetryLoad,
}: {
  reader: PdfReaderState;
  sourceUrl?: string;
  onChooseFile: () => void;
  onSubmitPassword: (password: string) => void;
  onRetryLoad: () => void;
}) {
  const [password, setPassword] = useState('');
  const passwordId = useId();
  useEffect(() => {
    if (reader.phase !== 'password') setPassword('');
  }, [reader.phase]);
  if (reader.phase === 'ready' || reader.phase === 'extracting') return null;
  if (reader.phase === 'loading')
    return (
      <section className="viewer-state" role="status" translate="no">
        <LoaderCircle className="spin" aria-hidden="true" />
        <p>
          {reader.percent === undefined
            ? t('正在加载 PDF…')
            : t('正在加载 PDF… {{p0}}%', { p0: reader.percent })}
        </p>
      </section>
    );
  if (reader.phase === 'password')
    return (
      <section className="viewer-state" translate="no">
        <form
          className="viewer-card"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            if (password) onSubmitPassword(password);
          }}
        >
          <h1>{t('此 PDF 受密码保护')}</h1>
          <label className="field" htmlFor={passwordId}>
            <span>{t('密码')}</span>
            <input
              id={passwordId}
              type="password"
              autoComplete="off"
              autoFocus
              value={password}
              aria-invalid={reader.incorrect}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          {reader.incorrect ? (
            <small className="field-error" role="alert">
              {t('密码错误，请重试')}
            </small>
          ) : null}
          <button type="submit" className="button button-primary" disabled={!password}>
            {t('打开')}
          </button>
        </form>
      </section>
    );
  if (reader.phase === 'error')
    return (
      <section className="viewer-state" translate="no">
        <div className="viewer-card">
          <CircleAlert aria-hidden="true" className="viewer-state-icon" />
          <p role="alert">{renderMessage(reader.error)}</p>
          <div className="viewer-card-actions">
            {reader.kind === 'file-access' ? (
              <button
                type="button"
                className="button"
                onClick={() =>
                  void chrome.tabs.create({
                    url: `chrome://extensions/?id=${chrome.runtime.id}`,
                  })
                }
              >
                {t('打开扩展详情页')}
              </button>
            ) : null}
            {reader.kind === 'network' || reader.kind === 'other' ? (
              <button type="button" className="button" onClick={onRetryLoad}>
                {t('重新加载')}
              </button>
            ) : null}
            {sourceUrl && /^https?:/u.test(sourceUrl) ? (
              <a className="button" href={sourceUrl}>
                {t('在浏览器中打开原 PDF')}
              </a>
            ) : null}
            <button type="button" className="button button-primary" onClick={onChooseFile}>
              {t('选择 PDF 文件')}
            </button>
          </div>
        </div>
      </section>
    );
  return (
    <section className="viewer-state" translate="no">
      <div className="viewer-card viewer-drop">
        <FileText aria-hidden="true" className="viewer-state-icon" />
        <h1>{t('拖放 PDF 到这里，或选择本地文件')}</h1>
        <p>{t('文件只在本机读取；开始翻译后，提取出的文字会发送给当前翻译引擎。')}</p>
        <button type="button" className="button button-primary" onClick={onChooseFile}>
          <FolderOpen aria-hidden="true" />
          {t('选择 PDF 文件')}
        </button>
      </div>
    </section>
  );
}
