import { useInterfaceLanguage } from '../ui/interface-language';
import { t, message, LocalizedError, renderMessage, type UiMessage } from '../shared/i18n';
import {
  ArrowUpRight,
  CircleAlert,
  FileText,
  LoaderCircle,
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
} from '../shared/messages';
import { isUrlExcluded } from '../shared/settings';
import { translationLanguageLabel } from '../shared/translation-languages';
import {
  DisplayModeControl,
  LanguagePicker,
  SettingRow,
  Switch,
  useSettingsMutation,
} from '../ui/controls';

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
  hostname?: string;
  url?: string;
  available: boolean;
  restricted: boolean;
}

/** Page translation lives in the top document, and every response crosses a runtime type boundary. */
async function sendMainFrameCommand(
  tabId: number,
  command: PageCommand,
): Promise<PageTranslationStatus> {
  const response = await sendTabMessage<unknown>(tabId, command, MAIN_FRAME);
  if (!isPageTranslationStatus(response))
    throw new LocalizedError(message('请刷新网页后重新打开插件。'));
  return response;
}

async function readPageStatus(tabId: number): Promise<PageTranslationStatus | null> {
  try {
    return await sendMainFrameCommand(tabId, { type: 'GET_PAGE_STATUS' });
  } catch {
    return null;
  }
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
        const restricted =
          !http ||
          Boolean(
            tab?.url &&
            /^https:\/\/(chromewebstore.google.com|chrome.google.com\/webstore|microsoftedge.microsoft.com\/addons)/u.test(
              tab.url,
            ),
          );
        const nextStatus =
          !restricted && tab?.id !== undefined
            ? await readPageStatus(tab.id)
            : null;
        if (!mounted) return;
        setPage({
          tabId: tab?.id,
          url: tab?.url,
          hostname: http ? new URL(tab.url!).hostname : undefined,
          available: nextStatus !== null,
          restricted,
        });
        setStatus(nextStatus ?? IDLE);
        if (nextStatus && tab?.id !== undefined) {
          const tabId = tab.id;
          timer = setInterval(() => {
            if (polling || commandLock.current) return;
            polling = true;
            void readPageStatus(tabId)
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
      setStatus(await sendMainFrameCommand(page.tabId, { type }));
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
    (settings.activeProfileId !== status.context.profileId ||
      settings.targetLanguage !== status.context.targetLanguage),
  );
  const needsRestart = status.context ? contextChanged : Boolean(status.needsRestart);
  const saving = Object.values(feedback).some((value) => value?.status === 'saving');
  const canTranslate = Boolean(page?.available && settings?.configured && !excluded);
  const fullDocument = status.mode === 'full-document';
  const incremental = fullDocument && status.stage === 'incremental';
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
        <p className="current-site">{page?.hostname ?? t('当前网页')}</p>
        {loadError ? (
          <section className="popup-notice">
            <CircleAlert aria-hidden="true" />
            <h1>{t('无法读取插件状态')}</h1>
            <p role="alert">{renderMessage(loadError)}</p>
            <button className="button" onClick={() => window.location.reload()}>
              {t('重新加载')}
            </button>
          </section>
        ) : !page || !settings ? (
          <section className="popup-notice" role="status">
            <LoaderCircle className="spin" aria-hidden="true" />
            <p>{t('正在读取插件状态…')}</p>
          </section>
        ) : !page.available && !page.restricted && !excluded ? (
          <section className="popup-notice">
            <CircleAlert aria-hidden="true" />
            <h1>{t('尚未连接到当前网页')}</h1>
            <p>{t('请刷新网页后重新打开插件。')}</p>
          </section>
        ) : !settings.configured ? (
          <section className="popup-notice">
            <h1>{t('用你的 AI，读懂网页')}</h1>
            <p>{t('连接支持 OpenAI 协议的 API，即可开始双语阅读。')}</p>
            {settings.configurationError ? (
              <p>{renderMessage(settings.configurationError)}</p>
            ) : null}
            <button className="button button-primary button-block" onClick={() => openSettings()}>
              {t('连接你的 AI')}
              <ArrowUpRight aria-hidden="true" />
            </button>
            <small>{t('配置仅保存在本地，请求直接发送到你的 API。')}</small>
          </section>
        ) : !page.available || excluded ? (
          <section className="popup-notice">
            <CircleAlert aria-hidden="true" />
            <h1>
              {excluded
                ? t('此站已排除')
                : page.restricted
                  ? t('此页面无法翻译')
                  : t('尚未连接到当前网页')}
            </h1>
            <p>
              {excluded
                ? t('此站符合不翻译规则，自动翻译也不会启动。')
                : page.restricted
                  ? t('浏览器内置页、扩展商店等页面不允许读取内容。')
                  : t('请刷新网页后重新打开插件。')}
            </p>
            {excluded ? (
              <button className="button" onClick={() => openSettings('sites')}>
                {t('管理站点规则')}
              </button>
            ) : null}
          </section>
        ) : (
          <section className="translation-status" aria-label={t('网页翻译状态')}>
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
                  : status.total > 0
                    ? [
                        t('translatedCount', {
                          translated: status.translated,
                          count: status.total,
                        }),
                        ...(status.failed ? [t('failedCount', { count: status.failed })] : []),
                      ].join(' · ')
                    : status.phase === 'translating'
                      ? t('正在查找需要翻译的内容…')
                      : t('译文将显示在原文下方。')}
            </p>
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
            {!fullDocument || (incremental && status.failed > 0) ? (
              <button
                type="button"
                className="text-button full-document-action"
                title={t('让 AI 一次理解全文，保留跨段上下文；会重新翻译当前已加载的正文。')}
                disabled={busy || saving}
                onClick={() => void run('START_FULL_DOCUMENT_TRANSLATION')}
              >
                <FileText aria-hidden="true" />
                {fullDocument ? t('重新全文翻译') : t('全文完整翻译')}
              </button>
            ) : null}
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
                <button className="text-button" onClick={() => openSettings()}>
                  {t('检查 AI 配置')}
                  <ArrowUpRight aria-hidden="true" />
                </button>
              </details>
            ) : null}
          </section>
        )}
        {commandError ? (
          <p className="field-error" role="alert">
            {renderMessage(commandError)}
          </p>
        ) : null}
        {settings?.configured ? (
          <div className="popup-preferences">
            <SettingRow label={t('翻译为')} feedback={feedback.language}>
              <LanguagePicker
                label={t('翻译为')}
                value={settings.targetLanguage}
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
            <SettingRow label={t('AI 配置')} feedback={feedback.profile}>
              <select
                aria-label={t('AI 配置')}
                value={settings.activeProfileId}
                disabled={saving || busy}
                onChange={(event) => {
                  void save(
                    'profile',
                    { type: 'SET_ACTIVE_PROFILE', profileId: event.target.value },
                    accept,
                  );
                }}
              >
                {settings.profiles.map((profile) => (
                  <option key={profile.id} value={profile.id} disabled={!profile.configured}>
                    {profile.name}
                    {profile.configured ? '' : t('（待配置）')}
                  </option>
                ))}
              </select>
            </SettingRow>
            <SettingRow label={t('此站自动翻译')} feedback={feedback.auto}>
              <Switch
                label={t('此站自动翻译')}
                checked={Boolean(
                  page?.hostname && settings.autoTranslateSites.includes(page.hostname),
                )}
                disabled={!canTranslate || saving || busy}
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
          </div>
        ) : null}
      </div>
      <footer className="popup-footer">
        <button
          className="text-button"
          type="button"
          disabled={!page?.available || !status.total || busy || saving}
          onClick={() => void run('RESTORE_PAGE')}
        >
          <RotateCcw aria-hidden="true" />
          {t('恢复原文')}
        </button>
        <span>
          <kbd>Alt</kbd> + <kbd>T</kbd>
        </span>
      </footer>
    </main>
  );
}
