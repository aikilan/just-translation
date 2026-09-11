import {
  BrainCircuit,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  LoaderCircle,
  Play,
  RotateCcw,
  Settings,
  ShieldCheck,
  Square,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useState } from 'react';

import packageJson from '../../package.json' with { type: 'json' };
import { sendRuntimeMessage, sendTabMessage } from '../shared/chrome-api';
import type { PageCommand, PageTranslationStatus, PublicTranslatorSettings } from '../shared/messages';
import type { DisplayMode } from '../shared/settings';

const INITIAL_STATUS: PageTranslationStatus = {
  phase: 'idle',
  translated: 0,
  failed: 0,
  total: 0,
  displayMode: 'bilingual',
};

type TranslationCommand = Extract<
  PageCommand['type'],
  'START_TRANSLATION' | 'STOP_TRANSLATION' | 'RESTORE_PAGE'
>;

interface StatusAction {
  label: string;
  command?: TranslationCommand;
  closesPopup?: boolean;
  tone: 'primary' | 'secondary';
  icon: LucideIcon;
}

export function PopupApp() {
  const [tabId, setTabId] = useState<number>();
  const [configured, setConfigured] = useState(false);
  const [configurationError, setConfigurationError] = useState<string>();
  const [publicSettings, setPublicSettings] = useState<PublicTranslatorSettings>();
  const [activeHostname, setActiveHostname] = useState<string>();
  const [status, setStatus] = useState<PageTranslationStatus>(INITIAL_STATUS);
  const [pageAvailable, setPageAvailable] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>();
  const [moreSettingsOpen, setMoreSettingsOpen] = useState(true);

  useEffect(() => {
    let intervalId: number | undefined;
    let mounted = true;
    void loadInitialState()
      .then(({ activeTabId, activeTabUrl, publicSettings, pageStatus }) => {
        if (!mounted) return;
        setPublicSettings(publicSettings);
        setConfigured(publicSettings.configured);
        setConfigurationError(publicSettings.configurationError);
        setActiveHostname(getHttpHostname(activeTabUrl));
        setStatus(
          pageStatus ?? {
            ...INITIAL_STATUS,
            displayMode: publicSettings.displayMode,
          },
        );
        if (activeTabId === undefined || pageStatus === null) {
          setPageAvailable(false);
          return;
        }
        setTabId(activeTabId);
        intervalId = window.setInterval(() => {
          void sendTabMessage<PageTranslationStatus>(activeTabId, { type: 'GET_PAGE_STATUS' })
            .then(setStatus)
            .catch(() => setPageAvailable(false));
        }, 500);
      })
      .catch((error: unknown) => {
        if (mounted) setLoadError(getMessage(error));
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
      window.clearInterval(intervalId);
    };
  }, []);

  /** Sends one existing content-script command and reflects its immediate status snapshot. */
  async function runCommand(type: TranslationCommand): Promise<void> {
    if (tabId === undefined) return;
    try {
      const nextStatus = await sendTabMessage<PageTranslationStatus>(tabId, { type });
      setStatus(nextStatus);
    } catch {
      setPageAvailable(false);
    }
  }

  async function changeDisplayMode(displayMode: DisplayMode): Promise<void> {
    if (tabId === undefined) return;
    try {
      const nextStatus = await sendTabMessage<PageTranslationStatus>(tabId, {
        type: 'SET_DISPLAY_MODE',
        displayMode,
      });
      setStatus(nextStatus);
    } catch (error) {
      setStatus({ ...status, phase: 'error', error: getMessage(error) });
    }
  }

  async function changeProfile(profileId: string): Promise<void> {
    const result = await sendRuntimeMessage<PublicTranslatorSettings>({
      type: 'SET_ACTIVE_PROFILE',
      profileId,
    });
    if (!result.ok) {
      setLoadError(result.error);
      return;
    }
    setPublicSettings(result.data);
    setConfigured(result.data.configured);
    setConfigurationError(result.data.configurationError);
  }

  async function changeAutoTranslation(enabled: boolean): Promise<void> {
    if (!activeHostname || !publicSettings) return;
    const result = await sendRuntimeMessage<PublicTranslatorSettings>({
      type: 'SET_SITE_AUTO_TRANSLATE',
      hostname: activeHostname,
      enabled,
    });
    if (!result.ok) {
      setLoadError(result.error);
      return;
    }
    setPublicSettings(result.data);
    if (enabled && tabId !== undefined && result.data.configured) {
      try {
        setStatus(await sendTabMessage<PageTranslationStatus>(tabId, { type: 'START_TRANSLATION' }));
      } catch {
        setPageAvailable(false);
      }
    }
  }

  const hasPageTranslationState = status.total > 0;

  return (
    <main className="popup-shell">
      <PopupHeader />

      <div className="popup-content">
        {loading ? (
          <InlineState
            icon={LoaderCircle}
            title="正在读取插件状态"
            description="正在获取当前网页和翻译配置…"
            loading
          />
        ) : loadError ? (
          <InlineState
            icon={CircleAlert}
            title="无法读取插件状态"
            description={loadError}
            tone="error"
            actionLabel="打开设置"
            onAction={() => void chrome.runtime.openOptionsPage()}
          />
        ) : publicSettings ? (
          <>
            <ProfilePicker settings={publicSettings} onChange={changeProfile} />

            <section className="popup-advanced">
              <button
                className="advanced-toggle"
                type="button"
                aria-expanded={moreSettingsOpen}
                aria-controls="popup-advanced-content"
                onClick={() => setMoreSettingsOpen((open) => !open)}
              >
                <span>更多设置</span>
                <ChevronDown aria-hidden="true" />
              </button>

              {moreSettingsOpen ? (
                <div
                  className="popup-advanced-content advanced-enter"
                  id="popup-advanced-content"
                >
                  {!configured ? (
                    <InlineState
                      icon={CircleAlert}
                      title="先连接你的 AI"
                      description={
                        configurationError
                          ? `配置未生效：${configurationError}`
                          : '填写 OpenAI 协议 API 地址和模型后，就可以开始翻译。'
                      }
                      tone="error"
                      actionLabel="打开设置"
                      onAction={() => void chrome.runtime.openOptionsPage()}
                    />
                  ) : !pageAvailable ? (
                    <InlineState
                      icon={CircleAlert}
                      title="这个页面无法翻译"
                      description="浏览器内置页、扩展商店和本地新标签页不允许插件读取内容。"
                    />
                  ) : (
                    <>
                      {activeHostname ? (
                        <label className="site-auto-setting">
                          <span className="setting-copy">
                            <strong>此站自动翻译</strong>
                            <small>进入该网站时自动翻译页面内容</small>
                          </span>
                          <input
                            aria-label="此站自动翻译"
                            type="checkbox"
                            checked={publicSettings.autoTranslateSites.includes(activeHostname)}
                            onChange={(event) => void changeAutoTranslation(event.target.checked)}
                          />
                          <span className="checkbox-control" aria-hidden="true">
                            <Check />
                          </span>
                        </label>
                      ) : null}

                      <TranslationStatusCard
                        status={status}
                        onCommand={runCommand}
                        onViewDetails={() => window.close()}
                      />

                      {status.error ? (
                        <div className="popup-error" role="alert">
                          <CircleAlert aria-hidden="true" />
                          <span>
                            <strong>{status.error}</strong>
                            <small>请检查模型兼容性、响应格式和当前 API 配置。</small>
                          </span>
                          <button
                            type="button"
                            onClick={() => void chrome.runtime.openOptionsPage()}
                          >
                            检查 API 配置
                            <ChevronRight aria-hidden="true" />
                          </button>
                        </div>
                      ) : null}

                      <label className="mode-picker">
                        <span>显示设置</span>
                        <select
                          aria-label="显示设置"
                          value={status.displayMode}
                          onChange={(event) =>
                            void changeDisplayMode(event.target.value as DisplayMode)
                          }
                        >
                          <option value="bilingual">原文 + 译文</option>
                          <option value="translation">仅译文</option>
                        </select>
                      </label>
                    </>
                  )}
                </div>
              ) : null}
            </section>
          </>
        ) : null}
      </div>

      <footer className="popup-footer">
        <button
          className="restore-button"
          type="button"
          disabled={!pageAvailable || !hasPageTranslationState}
          onClick={() => void runCommand('RESTORE_PAGE')}
        >
          <RotateCcw aria-hidden="true" />
          恢复原始网页
        </button>
        <span>Alt + T 快速切换</span>
        <span>v{packageJson.version}</span>
      </footer>
    </main>
  );
}

function PopupHeader() {
  return (
    <header className="popup-header">
      <div className="popup-brand">
        <img className="popup-logo" src="/icons/icon.svg" alt="" />
        <span className="brand-copy">
          <strong>只是翻译</strong>
          <small>
            BYO AI · 不经过中转服务
            <ShieldCheck aria-label="密钥仅保存在本地" />
          </small>
        </span>
      </div>
      <button
        className="icon-button close-button"
        type="button"
        aria-label="关闭弹窗"
        onClick={() => window.close()}
      >
        <X aria-hidden="true" />
      </button>
    </header>
  );
}

function ProfilePicker({
  settings,
  onChange,
}: {
  settings: PublicTranslatorSettings;
  onChange: (profileId: string) => Promise<void>;
}) {
  return (
    <section className="profile-picker">
      <span className="section-label">翻译模型</span>
      <label className="profile-select">
        <BrainCircuit aria-hidden="true" />
        <select
          aria-label="翻译模型"
          value={settings.activeProfileId}
          onChange={(event) => void onChange(event.target.value)}
        >
          {settings.profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name}
            </option>
          ))}
        </select>
      </label>
      <button
        className="settings-button"
        type="button"
        aria-label="打开设置"
        onClick={() => void chrome.runtime.openOptionsPage()}
      >
        <Settings aria-hidden="true" />
      </button>
    </section>
  );
}

function TranslationStatusCard({
  status,
  onCommand,
  onViewDetails,
}: {
  status: PageTranslationStatus;
  onCommand: (command: TranslationCommand) => Promise<void>;
  onViewDetails: () => void;
}) {
  const action = getStatusAction(status);
  const Icon = getStatusIcon(status);
  const ActionIcon = action.icon;
  return (
    <section className={`translation-status-card status-${status.phase}`} aria-live="polite">
      <div className="status-main">
        <span className="status-icon" aria-hidden="true">
          <Icon />
        </span>
        <span className="status-copy">
          <strong>{getStatusTitle(status)}</strong>
          <small>{getStatusDescription(status)}</small>
        </span>
        <button
          className={`status-action status-action-${action.tone}`}
          type="button"
          onClick={() => {
            if (action.closesPopup) onViewDetails();
            else if (action.command) void onCommand(action.command);
          }}
        >
          {action.label}
          <ActionIcon aria-hidden="true" />
        </button>
      </div>
      {status.total > 0 ? (
        <div
          className="progress-track"
          role="progressbar"
          aria-label={`已翻译 ${status.translated} / ${status.total}`}
          aria-valuemin={0}
          aria-valuemax={status.total}
          aria-valuenow={status.translated}
        >
          <span style={{ width: `${Math.min(100, (status.translated / status.total) * 100)}%` }} />
        </div>
      ) : null}
    </section>
  );
}

function InlineState({
  icon: Icon,
  title,
  description,
  tone = 'neutral',
  actionLabel,
  onAction,
  loading = false,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  tone?: 'neutral' | 'error';
  actionLabel?: string;
  onAction?: () => void;
  loading?: boolean;
}) {
  return (
    <section className={`inline-state inline-state-${tone}`}>
      <Icon className={loading ? 'is-spinning' : undefined} aria-hidden="true" />
      <span>
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
      {actionLabel && onAction ? (
        <button className="button button-secondary" type="button" onClick={onAction}>
          {actionLabel}
        </button>
      ) : null}
    </section>
  );
}

async function loadInitialState(): Promise<{
  activeTabId?: number;
  activeTabUrl?: string;
  publicSettings: PublicTranslatorSettings;
  pageStatus: PageTranslationStatus | null;
}> {
  const [settingsResult, tabs] = await Promise.all([
    sendRuntimeMessage<PublicTranslatorSettings>({ type: 'GET_PUBLIC_SETTINGS' }),
    chrome.tabs.query({ active: true, currentWindow: true }),
  ]);
  if (!settingsResult.ok) throw new Error(settingsResult.error);
  const activeTabId = tabs[0]?.id;
  let pageStatus: PageTranslationStatus | null = null;
  if (activeTabId !== undefined) {
    try {
      pageStatus = await sendTabMessage<PageTranslationStatus>(activeTabId, {
        type: 'GET_PAGE_STATUS',
      });
    } catch {
      pageStatus = null;
    }
  }
  return {
    activeTabId,
    activeTabUrl: tabs[0]?.url,
    publicSettings: settingsResult.data,
    pageStatus,
  };
}

function getStatusAction(status: PageTranslationStatus): StatusAction {
  if (status.phase === 'translating') {
    return {
      label: '停止翻译',
      command: 'STOP_TRANSLATION',
      tone: 'secondary',
      icon: Square,
    };
  }
  if (status.phase === 'error' && status.failed > 0) {
    return {
      label: '查看详情',
      closesPopup: true,
      tone: 'secondary',
      icon: ChevronRight,
    };
  }
  if (status.phase === 'complete') {
    return {
      label: '翻译新内容',
      command: 'START_TRANSLATION',
      tone: 'secondary',
      icon: Play,
    };
  }
  if (status.phase === 'stopped') {
    return {
      label: '继续翻译',
      command: 'START_TRANSLATION',
      tone: 'primary',
      icon: Play,
    };
  }
  return {
    label: status.phase === 'error' ? '重新翻译' : '翻译此网页',
    command: 'START_TRANSLATION',
    tone: 'primary',
    icon: Play,
  };
}

function getStatusIcon(status: PageTranslationStatus): LucideIcon {
  if (status.phase === 'error') return CircleAlert;
  if (status.phase === 'complete') return CheckCircle2;
  if (status.phase === 'translating') return LoaderCircle;
  return BrainCircuit;
}

function getStatusTitle(status: PageTranslationStatus): string {
  switch (status.phase) {
    case 'translating':
      return '正在翻译';
    case 'complete':
      return '翻译完成';
    case 'stopped':
      return '已停止';
    case 'error':
      return '翻译中断';
    case 'idle':
      return '准备翻译';
  }
}

function getStatusDescription(status: PageTranslationStatus): string {
  if (status.failed > 0) {
    return `${status.failed} 个段落翻译失败，请在网页中点击失败提示重试`;
  }
  if (status.total > 0) return `已处理 ${status.translated} / ${status.total} 个段落`;
  return '原文会保留在译文上方';
}

function getHttpHostname(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol)
      ? parsed.hostname.toLowerCase()
      : undefined;
  } catch {
    return undefined;
  }
}

function getMessage(error: unknown): string {
  return error instanceof Error ? error.message : '插件通信失败';
}
