import { useInterfaceLanguage } from '../ui/interface-language';
import { t, message, LocalizedError, renderMessage, type UiMessage } from '../shared/i18n';
import {
  ArrowUpRight,
  CircleAlert,
  FileText,
  FileUp,
  LoaderCircle,
  Languages,
  Play,
  RotateCcw,
  Settings,
  Square,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { sendRuntimeMessage, sendTabMessage } from '../shared/chrome-api';
import {
  getErrorMessage,
  isPageTranslationStatus,
  type PageCommand,
  type PageTranslationStatus,
  type PublicTranslatorSettings,
  type RuntimeRequest,
} from '../shared/messages';
import { isUrlExcluded } from '../shared/settings';
import { YOUTUBE_SUBTITLES_ENABLED } from '../shared/features';
import {
  getPdfFileName,
  getPdfViewerUrl,
  isLocalPdfUrl,
  isPdfViewerUrl,
  readPdfViewerParameters,
} from '../shared/pdf-viewer';
import {
  isTargetLanguage,
  languageCodeLabel,
  normalizeLanguageCode,
  translationLanguageLabel,
} from '../shared/translation-languages';
import { activeTranslatorEquals } from '../shared/translation-engines';
import {
  DisplayModeControl,
  TranslationStyleControl,
  LanguagePicker,
  SettingRow,
  Switch,
  useSettingsMutation,
} from '../ui/controls';
import { TranslatorDisclosure, TranslatorSelect } from '../ui/translator-select';
import { openQuickTranslationInTab } from './open-quick-translation';

type TranslationCommand = Extract<
  PageCommand['type'],
  | 'START_TRANSLATION'
  | 'STOP_TRANSLATION'
  | 'RESTORE_PAGE'
  | 'RESTART_TRANSLATION'
  | 'RETRY_FAILED_TRANSLATIONS'
  | 'START_FULL_DOCUMENT_TRANSLATION'
>;
const IDLE: PageTranslationStatus = {
  mode: 'segmented',
  phase: 'idle',
  total: 0,
  translated: 0,
  failed: 0,
  displayMode: 'bilingual',
};
const MAIN_FRAME: chrome.tabs.MessageSendOptions = { frameId: 0 };
interface PageState {
  tabId?: number;
  tabIndex?: number;
  hostname?: string;
  url?: string;
  available: boolean;
  restricted: boolean;
  /** The tab is this extension's PDF reader, controlled through the runtime channel. */
  pdfViewer?: boolean;
  /** A local PDF; content scripts never run there, so the popup opens the reader itself. */
  localPdf?: { fileAccess: boolean };
}

/** Page translation lives in the top document, and every response crosses a runtime type boundary. */
async function sendMainFrameCommand(
  tabId: number,
  command: PageCommand,
  pdfViewer = false,
): Promise<PageTranslationStatus> {
  // Extension pages never receive tab messages; the PDF reader answers on the runtime channel.
  const response = pdfViewer
    ? await chrome.runtime.sendMessage<RuntimeRequest, unknown>({
        type: 'PDF_VIEWER_COMMAND',
        tabId,
        command,
      })
    : await sendTabMessage<unknown>(tabId, command, MAIN_FRAME);
  if (!isPageTranslationStatus(response))
    throw new LocalizedError(message('请刷新网页后重新打开插件。'));
  return response;
}

async function readPageStatus(
  tabId: number,
  pdfViewer = false,
): Promise<PageTranslationStatus | null> {
  try {
    return await sendMainFrameCommand(tabId, { type: 'GET_PAGE_STATUS' }, pdfViewer);
  } catch {
    return null;
  }
}

/** Chrome hides extension-page URLs from tab queries; our own contexts are always visible. */
async function findPdfViewerUrl(tabId: number | undefined): Promise<string | undefined> {
  if (tabId === undefined || !chrome.runtime.getContexts) return undefined;
  try {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['TAB'], tabIds: [tabId] });
    return contexts.find((context) => context.frameId === 0 && isPdfViewerUrl(context.documentUrl))
      ?.documentUrl;
  } catch {
    return undefined;
  }
}

/** Opens the PDF reader next to the current tab; without a source the user picks a local file. */
async function openPdfReader(page: PageState | undefined, source?: string): Promise<void> {
  await chrome.tabs.create({
    url: getPdfViewerUrl(source, source ? 'segmented' : undefined),
    ...(page?.tabIndex !== undefined ? { index: page.tabIndex + 1 } : {}),
    ...(page?.tabId !== undefined ? { openerTabId: page.tabId } : {}),
  });
  window.close();
}

export function PopupApp() {
  const [page, setPage] = useState<PageState>();
  const [settings, setSettings] = useState<PublicTranslatorSettings>();
  useInterfaceLanguage(settings);
  const [status, setStatus] = useState(IDLE);
  const [loadError, setLoadError] = useState<UiMessage | ''>('');
  const [commandError, setCommandError] = useState<UiMessage | ''>('');
  const [busy, setBusy] = useState(false);
  const commandLock = useRef(false);
  const settingsRevision = useRef(0);
  const { feedback, save } = useSettingsMutation();

  useEffect(() => {
    let alive = true;
    async function refresh(reportFailure = false) {
      const request = ++settingsRevision.current;
      try {
        const result = await sendRuntimeMessage<PublicTranslatorSettings>({
          type: 'GET_PUBLIC_SETTINGS',
        });
        if (!result.ok) throw new LocalizedError(result.error);
        if (alive && request === settingsRevision.current) setSettings(result.data);
      } catch (error) {
        if (alive && request === settingsRevision.current && reportFailure)
          setLoadError(getErrorMessage(error));
      }
    }
    void refresh(true);
    const changed = (_changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local') return;
      void refresh();
    };
    chrome.storage.onChanged.addListener(changed);
    return () => {
      alive = false;
      chrome.storage.onChanged.removeListener(changed);
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    let timer: ReturnType<typeof setInterval> | undefined;
    let polling = false;
    async function load() {
      try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const tab = tabs[0];
        const http = Boolean(tab?.url && /^https?:/u.test(tab.url));
        const viewerUrl = await findPdfViewerUrl(tab?.id);
        const pdfViewer = viewerUrl !== undefined;
        const restricted =
          !pdfViewer &&
          (!http ||
            Boolean(
              tab?.url &&
              /^https:\/\/(chromewebstore.google.com|chrome.google.com\/webstore|microsoftedge.microsoft.com\/addons)/u.test(
                tab.url,
              ),
            ));
        const localPdf = isLocalPdfUrl(tab?.url)
          ? { fileAccess: await chrome.extension.isAllowedFileSchemeAccess() }
          : undefined;
        const nextStatus =
          !restricted && tab?.id !== undefined ? await readPageStatus(tab.id, pdfViewer) : null;
        if (!mounted) return;
        setPage({
          tabId: tab?.id,
          tabIndex: tab?.index,
          url: viewerUrl ?? tab?.url,
          hostname: http ? new URL(tab.url!).hostname : undefined,
          available: nextStatus !== null,
          restricted,
          pdfViewer,
          localPdf,
        });
        setStatus(nextStatus ?? IDLE);
        if (nextStatus && tab?.id !== undefined) {
          const tabId = tab.id;
          timer = setInterval(() => {
            if (polling || commandLock.current) return;
            polling = true;
            void readPageStatus(tabId, pdfViewer)
              .then((value) => {
                if (!mounted || commandLock.current) return;
                setPage((current) => current && { ...current, available: value !== null });
                if (value) setStatus(value);
              })
              .finally(() => {
                polling = false;
              });
          }, 500);
        }
      } catch (error) {
        if (mounted) setLoadError(getErrorMessage(error));
      }
    }
    void load();
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, []);

  /** Serialize explicit page actions, including a full-document restart with current settings. */
  async function run(type: TranslationCommand) {
    if (page?.tabId === undefined || commandLock.current) return;
    commandLock.current = true;
    setBusy(true);
    setCommandError('');
    try {
      const next = await sendMainFrameCommand(page.tabId, { type }, page.pdfViewer);
      // A browser PDF tab opens the reader in a new tab; this popup belongs to the old one.
      if (
        next.pdfDocument &&
        (type === 'START_TRANSLATION' || type === 'START_FULL_DOCUMENT_TRANSLATION')
      )
        window.close();
      setStatus(next);
    } catch (error) {
      setCommandError(message('操作未完成：{{p0}}', { p0: getErrorMessage(error) }));
    } finally {
      commandLock.current = false;
      setBusy(false);
    }
  }
  /** Keep the popup available for errors; close only after the top document opened its editor. */
  async function openQuickTranslation() {
    if (page?.tabId === undefined || page.restricted || page.pdfViewer || commandLock.current)
      return;
    commandLock.current = true;
    setBusy(true);
    setCommandError('');
    try {
      await openQuickTranslationInTab(page.tabId);
      window.close();
    } catch (error) {
      setCommandError(message('操作未完成：{{p0}}', { p0: getErrorMessage(error) }));
    } finally {
      commandLock.current = false;
      setBusy(false);
    }
  }
  function accept(value: PublicTranslatorSettings) {
    // A confirmed mutation is newer than every settings read already in flight.
    settingsRevision.current += 1;
    setSettings(value);
  }
  function openSettings(section?: 'sites') {
    if (section)
      void chrome.tabs.create({ url: chrome.runtime.getURL(`src/options/index.html#${section}`) });
    else void chrome.runtime.openOptionsPage();
  }
  const excluded = Boolean(
    page?.url && settings && isUrlExcluded(page.url, settings.excludedSites),
  );
  const contextChanged = Boolean(
    settings &&
    status.context &&
    (!activeTranslatorEquals(settings.activeTranslator, status.context.translator) ||
      settings.targetLanguage !== status.context.targetLanguage),
  );
  const needsRestart = status.context ? contextChanged : Boolean(status.needsRestart);
  const saving = Object.values(feedback).some((value) => value?.status === 'saving');
  const canTranslate = Boolean(page?.available && settings?.ready && !excluded);
  // Rules hold the primary language; the tag may also name a Chinese script.
  const pageRuleLanguage = status.pageLanguage
    ? normalizeLanguageCode(status.pageLanguage)
    : undefined;
  const pdf = Boolean(page?.pdfViewer || status.pdfDocument);
  const fullDocument = status.mode === 'full-document';
  const incremental = fullDocument && status.stage === 'incremental';
  // Idle pages only need actions; keep progress, failures, and restart guidance visible.
  const showStatusSummary = status.phase !== 'idle' || needsRestart || status.failed > 0;
  const action = needsRestart
    ? t('用新设置重新翻译')
    : status.phase === 'translating'
      ? t('停止翻译')
      : incremental && status.failed > 0
        ? t('重试全部失败')
        : fullDocument
          ? t('重新全文翻译')
          : status.failed > 0
            ? t('重试全部失败')
            : status.phase === 'stopped'
              ? t('继续翻译')
              : status.phase === 'complete'
                ? t('翻译新内容')
                : status.phase === 'error'
                  ? t('重新翻译')
                  : pdf
                    ? t('翻译此 PDF')
                    : t('翻译此网页');
  const title = needsRestart
    ? t('新设置已就绪')
    : status.phase === 'translating'
      ? fullDocument
        ? {
            collecting: t('收集全文'),
            requesting: t('全文翻译中'),
            applying: t('回填译文'),
            incremental: t('正在补译新内容'),
          }[status.stage ?? 'collecting']
        : t('正在翻译')
      : fullDocument && !incremental && status.phase === 'error'
        ? t('全文翻译失败')
        : (!fullDocument || incremental) && status.failed > 0
          ? t('部分段落未完成')
          : status.phase === 'complete'
            ? status.total
              ? t('翻译完成')
              : t('未发现需要翻译的内容')
            : status.phase === 'stopped'
              ? t('已停止')
              : status.phase === 'error'
                ? t('暂时无法翻译')
                : t('准备翻译');

  const quickTranslationEntry = (
    <button
      className="text-button quick-translation-entry"
      type="button"
      disabled={page?.tabId === undefined || page.restricted || page.pdfViewer || busy || saving}
      onClick={() => void openQuickTranslation()}
    >
      <Languages aria-hidden="true" />
      {t('快捷翻译')}
    </button>
  );
  const showFullDocumentAction = !fullDocument || (incremental && status.failed > 0);
  return (
    <main className="popup-shell">
      <header className="popup-header">
        <div className="popup-brand">
          <img src="/icons/icon.svg" alt="" className="popup-logo" />
          <strong>{t('只是翻译')}</strong>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label={t('打开设置')}
          onClick={() => openSettings()}
        >
          <Settings aria-hidden="true" />
        </button>
      </header>
      <div className="popup-content">
        <p className="current-site">
          {page?.pdfViewer && page.url
            ? (() => {
                const source = readPdfViewerParameters(page.url).source;
                return source ? getPdfFileName(source) : t('PDF 翻译');
              })()
            : (page?.hostname ??
              (page?.localPdf && page.url ? getPdfFileName(page.url) : t('当前网页')))}
        </p>
        {loadError ? (
          <section className="popup-notice">
            <CircleAlert aria-hidden="true" />
            <p role="alert">{renderMessage(loadError)}</p>
            <button className="button" onClick={() => window.location.reload()}>
              {t('重新加载')}
            </button>
          </section>
        ) : !page || !settings ? (
          <section className="popup-notice popup-notice-loading" role="status">
            <LoaderCircle className="spin" aria-hidden="true" />
            <p>{t('正在读取插件状态…')}</p>
          </section>
        ) : !page.available && !page.restricted && !excluded ? (
          <section className="popup-notice" role="status">
            <CircleAlert aria-hidden="true" />
            <p>{t('请刷新页面重新连接插件')}</p>
          </section>
        ) : !settings.ready ? (
          <section className="popup-notice">
            <CircleAlert aria-hidden="true" />
            <p>
              {settings.configurationError
                ? renderMessage(settings.configurationError)
                : t('当前翻译引擎不可用')}
            </p>
            {settings.activeTranslator.kind === 'ai' ? (
              <button className="button button-primary button-block" onClick={() => openSettings()}>
                {t('检查 AI 配置')}
                <ArrowUpRight aria-hidden="true" />
              </button>
            ) : null}
          </section>
        ) : page.localPdf ? (
          <section className="translation-status" aria-label={t('网页翻译状态')}>
            <p className="status-description">
              {page.localPdf.fileAccess
                ? t('在阅读器中打开此 PDF，原文与译文逐页并排显示。')
                : t(
                    '翻译本地 PDF 需要在扩展详情页开启「允许访问文件网址」，也可以直接在阅读器中选择文件。',
                  )}
            </p>
            {page.localPdf.fileAccess ? (
              <button
                className="button button-primary button-block"
                disabled={!settings.ready}
                onClick={() => void openPdfReader(page, page.url)}
              >
                <Play aria-hidden="true" />
                {t('翻译此 PDF')}
              </button>
            ) : (
              <div className="translation-shortcuts">
                <button
                  className="button"
                  onClick={() =>
                    void chrome.tabs.create({
                      url: `chrome://extensions/?id=${chrome.runtime.id}`,
                    })
                  }
                >
                  {t('打开扩展详情页')}
                </button>
                <button className="button button-primary" onClick={() => void openPdfReader(page)}>
                  {t('选择 PDF 文件')}
                </button>
              </div>
            )}
          </section>
        ) : !page.available || excluded ? (
          <section className="popup-notice">
            <CircleAlert aria-hidden="true" />
            <p>{excluded ? t('此站已排除') : t('此页面无法翻译，请切换到普通网页')}</p>
            {excluded ? (
              <button className="button" onClick={() => openSettings('sites')}>
                {t('管理站点规则')}
              </button>
            ) : null}
          </section>
        ) : (
          <section className="translation-status" aria-label={t('网页翻译状态')}>
            {showStatusSummary ? (
              <>
                <div className="status-heading">
                  <span className={`status-dot phase-${status.phase}`} />
                  <h1>{title}</h1>
                  {needsRestart && status.phase === 'translating' ? (
                    <button
                      className="text-button"
                      onClick={() => void run('STOP_TRANSLATION')}
                      disabled={busy}
                    >
                      {t('停止翻译')}
                    </button>
                  ) : null}
                </div>
                <p className="status-description" role="status">
                  {needsRestart
                    ? t('当前译文保留{{p0}}，重新翻译后应用新设置。', {
                        p0: status.context
                          ? `（${translationLanguageLabel(status.context.targetLanguage)}）`
                          : '',
                      })
                    : fullDocument && !incremental && status.phase === 'translating'
                      ? status.total
                        ? t('totalCount', { count: status.total })
                        : t('全文完成后统一显示译文。')
                      : fullDocument && !incremental && status.phase === 'error'
                        ? t('全文请求失败，未应用译文；共 {{count}} 个阅读单元。', {
                            count: status.total,
                          })
                        : status.total > 0
                          ? [
                              t('translatedCount', {
                                translated: status.translated,
                                count: status.total,
                              }),
                              ...(status.failed
                                ? [t('failedCount', { count: status.failed })]
                                : []),
                            ].join(' · ')
                          : status.phase === 'translating'
                            ? t('正在查找需要翻译的内容…')
                            : t('译文将显示在原文下方。')}
                </p>
              </>
            ) : status.pdfDocument ? (
              // The browser's viewer has no page text: say where the translation will appear.
              <p className="status-description">
                {t('在阅读器中打开此 PDF，原文与译文逐页并排显示。')}
              </p>
            ) : null}
            {!fullDocument && !incremental && status.phase === 'translating' && status.total > 0 ? (
              <div
                className="progress-track"
                role="progressbar"
                aria-label={t('已翻译段落')}
                aria-valuemin={0}
                aria-valuemax={status.total}
                aria-valuenow={status.translated}
              >
                <span
                  style={{ width: `${Math.min(100, (status.translated / status.total) * 100)}%` }}
                />
              </div>
            ) : null}
            <button
              className={`button button-block ${status.phase === 'translating' && !needsRestart ? '' : 'button-primary'}`}
              disabled={busy || saving}
              onClick={() => {
                if (needsRestart) void run('RESTART_TRANSLATION');
                else if (status.phase === 'translating') void run('STOP_TRANSLATION');
                else if (incremental && status.failed > 0) void run('RETRY_FAILED_TRANSLATIONS');
                else if (fullDocument) void run('START_FULL_DOCUMENT_TRANSLATION');
                else if (status.failed > 0) void run('RETRY_FAILED_TRANSLATIONS');
                else void run('START_TRANSLATION');
              }}
            >
              {busy ? (
                <LoaderCircle className="spin" aria-hidden="true" />
              ) : status.phase === 'translating' && !needsRestart ? (
                <Square aria-hidden="true" />
              ) : (!fullDocument || incremental) && status.failed > 0 && !needsRestart ? (
                <RotateCcw aria-hidden="true" />
              ) : (
                <Play aria-hidden="true" />
              )}
              {action}
            </button>
            <div
              className={`translation-shortcuts${showFullDocumentAction ? '' : ' single-action'}`}
            >
              {showFullDocumentAction ? (
                <div className="full-document-entry">
                  <button
                    type="button"
                    className="text-button full-document-action"
                    title={
                      settings.supportsFullDocument
                        ? t('让 AI 一次理解全文，保留跨段上下文；会重新翻译当前已加载的正文。')
                        : t('仅支持 AI 配置')
                    }
                    aria-describedby={
                      settings.supportsFullDocument ? undefined : 'full-document-ai-only'
                    }
                    disabled={busy || saving || !settings.supportsFullDocument}
                    onClick={() => void run('START_FULL_DOCUMENT_TRANSLATION')}
                  >
                    <FileText aria-hidden="true" />
                    {fullDocument ? t('重新全文翻译') : t('全文完整翻译')}
                  </button>
                  {!settings.supportsFullDocument ? (
                    <p id="full-document-ai-only" className="full-document-note">
                      {t('仅支持 AI 配置')}
                    </p>
                  ) : null}
                </div>
              ) : null}
              {quickTranslationEntry}
            </div>
            {status.failed ? (
              <p className="retry-guidance">
                {fullDocument && !incremental
                  ? t('原文已保留，重试会重新提交全文。')
                  : t('仅重试失败段落，已完成的译文会保留。')}
              </p>
            ) : null}
            {status.error ? (
              <details className="popup-error" open>
                <summary>{t('错误详情')}</summary>
                <p>{renderMessage(status.error)}</p>
                {settings.activeTranslator.kind === 'ai' ? (
                  <button className="text-button" onClick={() => openSettings()}>
                    {t('检查 AI 配置')}
                    <ArrowUpRight aria-hidden="true" />
                  </button>
                ) : null}
              </details>
            ) : null}
          </section>
        )}
        {settings && (!page?.available || excluded || !settings.ready || loadError) ? (
          <div className="quick-translation-standalone">{quickTranslationEntry}</div>
        ) : null}
        {commandError ? (
          <section className="popup-notice">
            <CircleAlert aria-hidden="true" />
            <p role="alert">{renderMessage(commandError)}</p>
          </section>
        ) : null}
        {settings ? (
          <div className="popup-preferences">
            <SettingRow label={t('翻译引擎')} feedback={feedback.profile}>
              <TranslatorSelect
                activeTranslator={settings.activeTranslator}
                profiles={settings.profiles}
                disabled={saving || busy}
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
                disabled={saving || busy}
                onChange={(targetLanguage) => {
                  void save(
                    'language',
                    { type: 'UPDATE_READING_PREFERENCES', patch: { targetLanguage } },
                    accept,
                  );
                }}
              />
            </SettingRow>
            <SettingRow label={t('显示方式')} feedback={feedback.mode}>
              <DisplayModeControl
                value={status.context || status.total ? status.displayMode : settings.displayMode}
                disabled={saving || busy}
                onChange={(displayMode) => {
                  void save(
                    'mode',
                    { type: 'UPDATE_READING_PREFERENCES', patch: { displayMode } },
                    (next) => {
                      accept(next);
                      if (page?.available && page.tabId !== undefined)
                        void sendMainFrameCommand(page.tabId, {
                          type: 'SET_DISPLAY_MODE',
                          displayMode,
                        })
                          .then(setStatus)
                          .catch(() =>
                            setCommandError(
                              message('偏好已保存，当前网页应用失败，请刷新后重试。'),
                            ),
                          );
                    },
                  );
                }}
              />
            </SettingRow>
            <SettingRow label={t('译文样式')} feedback={feedback.style}>
              <TranslationStyleControl
                value={settings.translationStyle}
                disabled={saving || busy}
                onChange={(translationStyle) => {
                  void save(
                    'style',
                    { type: 'UPDATE_READING_PREFERENCES', patch: { translationStyle } },
                    (next) => {
                      accept(next);
                      if (page?.available && page.tabId !== undefined)
                        void sendMainFrameCommand(page.tabId, {
                          type: 'SET_TRANSLATION_STYLE',
                          translationStyle,
                        })
                          .then(setStatus)
                          .catch(() =>
                            setCommandError(
                              message('偏好已保存，当前网页应用失败，请刷新后重试。'),
                            ),
                          );
                    },
                  );
                }}
              />
            </SettingRow>
            <SettingRow label={t('此站自动翻译')} feedback={feedback.auto}>
              <Switch
                label={t('此站自动翻译')}
                checked={Boolean(
                  page?.hostname && settings.autoTranslateSites.includes(page.hostname),
                )}
                disabled={!canTranslate || !page?.hostname || saving || busy}
                onChange={(enabled) => {
                  if (!page?.hostname) return;
                  void save(
                    'auto',
                    { type: 'SET_SITE_AUTO_TRANSLATE', hostname: page.hostname, enabled },
                    (next) => {
                      accept(next);
                      if (enabled && status.phase === 'idle' && !status.context)
                        void run('START_TRANSLATION');
                    },
                  );
                }}
              />
            </SettingRow>
            {pageRuleLanguage &&
            !isTargetLanguage(status.pageLanguage!, settings.targetLanguage) ? (
              <SettingRow
                label={t('总是翻译{{p0}}网页', { p0: languageCodeLabel(pageRuleLanguage) })}
                feedback={feedback.languageRule}
              >
                <Switch
                  label={t('总是翻译{{p0}}网页', {
                    p0: languageCodeLabel(pageRuleLanguage),
                  })}
                  checked={settings.autoTranslateLanguages.includes(pageRuleLanguage)}
                  disabled={!canTranslate || saving || busy}
                  onChange={(enabled) => {
                    const language = pageRuleLanguage;
                    const next = enabled
                      ? [...new Set([...settings.autoTranslateLanguages, language])]
                      : settings.autoTranslateLanguages.filter((code) => code !== language);
                    void save(
                      'languageRule',
                      {
                        type: 'UPDATE_READING_PREFERENCES',
                        patch: { autoTranslateLanguages: next },
                      },
                      (result) => {
                        accept(result);
                        if (enabled && status.phase === 'idle' && !status.context)
                          void run('START_TRANSLATION');
                      },
                    );
                  }}
                />
              </SettingRow>
            ) : null}
            {YOUTUBE_SUBTITLES_ENABLED && page?.hostname === 'www.youtube.com' ? (
              <SettingRow label={t('YouTube 双语字幕')} feedback={feedback.video}>
                <Switch
                  label={t('YouTube 双语字幕')}
                  // This tab's state when known: the player button may have changed it.
                  checked={status.videoSubtitles?.enabled ?? settings.youtubeSubtitles}
                  disabled={excluded || saving || busy}
                  onChange={(enabled) => {
                    void save(
                      'video',
                      { type: 'UPDATE_READING_PREFERENCES', patch: { youtubeSubtitles: enabled } },
                      (next) => {
                        accept(next);
                        // The switch sets both the preference and this tab, so the two agree.
                        if (page.available && page.tabId !== undefined)
                          void sendMainFrameCommand(page.tabId, {
                            type: 'SET_VIDEO_SUBTITLES',
                            enabled,
                          })
                            .then(setStatus)
                            .catch(() =>
                              setCommandError(
                                message('偏好已保存，当前网页应用失败，请刷新后重试。'),
                              ),
                            );
                      },
                    );
                  }}
                />
              </SettingRow>
            ) : null}
          </div>
        ) : null}
      </div>
      <footer className="popup-footer">
        <div className="popup-footer-actions">
          <button
            className="text-button"
            type="button"
            disabled={!page?.available || !status.total || busy || saving}
            onClick={() => void run('RESTORE_PAGE')}
          >
            <RotateCcw aria-hidden="true" />
            {t('恢复原文')}
          </button>
          <button className="text-button" type="button" onClick={() => void openPdfReader(page)}>
            <FileUp aria-hidden="true" />
            {t('翻译本地 PDF')}
          </button>
        </div>
        <span>
          <kbd>Alt</kbd> + <kbd>T</kbd>
        </span>
      </footer>
    </main>
  );
}
