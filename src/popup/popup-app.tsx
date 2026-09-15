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
  type PageCommand,
  type PageTranslationStatus,
  type PublicTranslatorSettings,
} from '../shared/messages';
import { isUrlExcluded } from '../shared/settings';
import {
  DisplayModeControl,
  LanguagePicker,
  SettingRow,
  Switch,
  languageLabel,
  useSettingsMutation,
} from '../ui/controls';

type TranslationCommand = Extract<
  PageCommand['type'],
  | 'START_TRANSLATION'
  | 'STOP_TRANSLATION'
  | 'RESTORE_PAGE'
  | 'RESTART_TRANSLATION'
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
interface PageState {
  settings: PublicTranslatorSettings;
  tabId?: number;
  hostname?: string;
  url?: string;
  available: boolean;
  restricted: boolean;
}

export function PopupApp() {
  const [page, setPage] = useState<PageState>();
  const [status, setStatus] = useState(IDLE);
  const [loadError, setLoadError] = useState('');
  const [commandError, setCommandError] = useState('');
  const [busy, setBusy] = useState(false);
  const commandLock = useRef(false);
  const { feedback, save } = useSettingsMutation();

  useEffect(() => {
    let mounted = true;
    let timer: ReturnType<typeof setInterval> | undefined;
    let polling = false;
    async function load() {
      try {
        const [result, tabs] = await Promise.all([
          sendRuntimeMessage<PublicTranslatorSettings>({ type: 'GET_PUBLIC_SETTINGS' }),
          chrome.tabs.query({ active: true, currentWindow: true }),
        ]);
        if (!result.ok) throw new Error(result.error);
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
            ? await sendTabMessage<PageTranslationStatus>(tab.id, {
                type: 'GET_PAGE_STATUS',
              }).catch(() => null)
            : null;
        if (!mounted) return;
        setPage({
          settings: result.data,
          tabId: tab?.id,
          url: tab?.url,
          hostname: http ? new URL(tab.url!).hostname : undefined,
          available: nextStatus !== null,
          restricted,
        });
        setStatus(nextStatus ?? { ...IDLE, displayMode: result.data.displayMode });
        if (nextStatus && tab?.id !== undefined) {
          const tabId = tab.id;
          timer = setInterval(() => {
            if (polling || commandLock.current) return;
            polling = true;
            void sendTabMessage<PageTranslationStatus>(tabId, { type: 'GET_PAGE_STATUS' })
              .then((value) => {
                if (mounted && !commandLock.current) setStatus(value);
              })
              .catch(() => {
                if (mounted) setPage((current) => current && { ...current, available: false });
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
    function changed(_changes: Record<string, chrome.storage.StorageChange>, area: string) {
      if (area !== 'local') return;
      void sendRuntimeMessage<PublicTranslatorSettings>({ type: 'GET_PUBLIC_SETTINGS' })
        .then((result) => {
          if (mounted && result.ok)
            setPage((current) => current && { ...current, settings: result.data });
        })
        .catch(() => {});
    }
    chrome.storage.onChanged.addListener(changed);
    return () => {
      mounted = false;
      clearInterval(timer);
      chrome.storage.onChanged.removeListener(changed);
    };
  }, []);

  /** Serialize explicit page actions, including a full-document restart with current settings. */
  async function run(type: TranslationCommand) {
    if (page?.tabId === undefined || commandLock.current) return;
    commandLock.current = true;
    setBusy(true);
    setCommandError('');
    try {
      setStatus(await sendTabMessage<PageTranslationStatus>(page.tabId, { type }));
    } catch (error) {
      setCommandError(`操作未完成：${getErrorMessage(error)}`);
    } finally {
      commandLock.current = false;
      setBusy(false);
    }
  }
  function accept(settings: PublicTranslatorSettings) {
    setPage((current) => current && { ...current, settings });
  }
  function openSettings(section?: 'sites') {
    if (section)
      void chrome.tabs.create({ url: chrome.runtime.getURL(`src/options/index.html#${section}`) });
    else void chrome.runtime.openOptionsPage();
  }
  const settings = page?.settings;
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
  const action = needsRestart
    ? '用新设置重新翻译'
    : status.phase === 'translating'
      ? '停止翻译'
      : fullDocument
        ? '重新全文翻译'
        : status.failed > 0
          ? '返回网页重试'
          : status.phase === 'stopped'
            ? '继续翻译'
            : status.phase === 'complete'
              ? '翻译新内容'
              : status.phase === 'error'
                ? '重新翻译'
                : '翻译此网页';
  const title = needsRestart
    ? '新设置已就绪'
    : status.phase === 'translating'
      ? fullDocument
        ? { collecting: '收集全文', requesting: '全文翻译中', applying: '回填译文' }[
            status.stage ?? 'collecting'
          ]
        : '正在翻译'
      : fullDocument && status.phase === 'error'
        ? '全文翻译失败'
        : !fullDocument && status.failed > 0
          ? '部分段落未完成'
          : status.phase === 'complete'
            ? status.total
              ? '翻译完成'
              : '未发现需要翻译的内容'
            : status.phase === 'stopped'
              ? '已停止'
              : status.phase === 'error'
                ? '暂时无法翻译'
                : '准备翻译';

  return (
    <main className="popup-shell">
      <header className="popup-header">
        <div className="popup-brand">
          <img src="/icons/icon.svg" alt="" className="popup-logo" />
          <strong>只是翻译</strong>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="打开设置"
          onClick={() => openSettings()}
        >
          <Settings aria-hidden="true" />
        </button>
      </header>
      <div className="popup-content">
        <p className="current-site">{page?.hostname ?? '当前网页'}</p>
        {loadError ? (
          <section className="popup-notice">
            <CircleAlert aria-hidden="true" />
            <h1>无法读取插件状态</h1>
            <p role="alert">{loadError}</p>
            <button className="button" onClick={() => window.location.reload()}>
              重新加载
            </button>
          </section>
        ) : !page || !settings ? (
          <section className="popup-notice" role="status">
            <LoaderCircle className="spin" aria-hidden="true" />
            <p>正在读取插件状态…</p>
          </section>
        ) : !settings.configured ? (
          <section className="popup-notice">
            <h1>用你的 AI，读懂网页</h1>
            <p>连接支持 OpenAI 协议的 API，即可开始双语阅读。</p>
            {settings.configurationError ? <p>{settings.configurationError}</p> : null}
            <button className="button button-primary button-block" onClick={() => openSettings()}>
              连接你的 AI
              <ArrowUpRight aria-hidden="true" />
            </button>
            <small>配置仅保存在本地，请求直接发送到你的 API。</small>
          </section>
        ) : !page.available || excluded ? (
          <section className="popup-notice">
            <CircleAlert aria-hidden="true" />
            <h1>
              {excluded ? '此站已排除' : page.restricted ? '此页面无法翻译' : '尚未连接到当前网页'}
            </h1>
            <p>
              {excluded
                ? '此站符合不翻译规则，自动翻译也不会启动。'
                : page.restricted
                  ? '浏览器内置页、扩展商店等页面不允许读取内容。'
                  : '请刷新网页后重新打开插件。'}
            </p>
            {excluded ? (
              <button className="button" onClick={() => openSettings('sites')}>
                管理站点规则
              </button>
            ) : null}
          </section>
        ) : (
          <section className="translation-status" aria-label="网页翻译状态">
            <div className="status-heading">
              <span className={`status-dot phase-${status.phase}`} />
              <h1>{title}</h1>
              {needsRestart && status.phase === 'translating' ? (
                <button
                  className="text-button"
                  onClick={() => void run('STOP_TRANSLATION')}
                  disabled={busy}
                >
                  停止翻译
                </button>
              ) : null}
            </div>
            <p className="status-description" role="status">
              {needsRestart
                ? `当前译文保留${status.context ? `（${languageLabel(status.context.targetLanguage)}）` : ''}，重新翻译后应用新设置。`
                : fullDocument && status.phase === 'translating'
                  ? `${status.total ? `共 ${status.total} 个段落，` : ''}全文完成后统一显示译文。`
                  : status.total > 0
                    ? `已翻译 ${status.translated} / ${status.total} 个段落${status.failed ? ` · ${status.failed} 个失败` : ''}`
                    : status.phase === 'translating'
                      ? '正在查找需要翻译的内容…'
                      : '译文将显示在原文下方。'}
            </p>
            {!fullDocument && status.phase === 'translating' && status.total > 0 ? (
              <div
                className="progress-track"
                role="progressbar"
                aria-label="已翻译段落"
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
                else if (fullDocument) void run('START_FULL_DOCUMENT_TRANSLATION');
                else if (status.failed > 0) window.close();
                else void run('START_TRANSLATION');
              }}
            >
              {busy ? (
                <LoaderCircle className="spin" aria-hidden="true" />
              ) : status.phase === 'translating' && !needsRestart ? (
                <Square aria-hidden="true" />
              ) : (
                <Play aria-hidden="true" />
              )}
              {action}
            </button>
            {!fullDocument ? (
              <button
                type="button"
                className="text-button full-document-action"
                title="让 AI 一次理解全文，保留跨段上下文；会重新翻译当前已加载的正文。"
                disabled={busy || saving}
                onClick={() => void run('START_FULL_DOCUMENT_TRANSLATION')}
              >
                <FileText aria-hidden="true" />
                全文完整翻译
              </button>
            ) : null}
            {status.failed ? (
              <p className="retry-guidance">
                {fullDocument
                  ? '原文已保留，重试会重新提交全文。'
                  : '在网页中点击失败段落的“重试”，已完成的译文会保留。'}
              </p>
            ) : null}
            {status.error ? (
              <details className="popup-error" open>
                <summary>错误详情</summary>
                <p>{status.error}</p>
                <button className="text-button" onClick={() => openSettings()}>
                  检查 AI 配置
                  <ArrowUpRight aria-hidden="true" />
                </button>
              </details>
            ) : null}
          </section>
        )}
        {commandError ? (
          <p className="field-error" role="alert">
            {commandError}
          </p>
        ) : null}
        {settings?.configured ? (
          <div className="popup-preferences">
            <SettingRow label="翻译为" feedback={feedback.language}>
              <LanguagePicker
                label="翻译为"
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
            <SettingRow label="显示方式" feedback={feedback.mode}>
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
                        void sendTabMessage<PageTranslationStatus>(page.tabId, {
                          type: 'SET_DISPLAY_MODE',
                          displayMode,
                        })
                          .then(setStatus)
                          .catch(() =>
                            setCommandError('偏好已保存，当前网页应用失败，请刷新后重试。'),
                          );
                    },
                  );
                }}
              />
            </SettingRow>
            <SettingRow label="AI 配置" feedback={feedback.profile}>
              <select
                aria-label="AI 配置"
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
                    {profile.configured ? '' : '（待配置）'}
                  </option>
                ))}
              </select>
            </SettingRow>
            <SettingRow label="此站自动翻译" feedback={feedback.auto}>
              <Switch
                label="此站自动翻译"
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
          恢复原文
        </button>
        <span>
          <kbd>Alt</kbd> + <kbd>T</kbd>
        </span>
      </footer>
    </main>
  );
}
