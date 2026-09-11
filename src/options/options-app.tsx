import {
  BookOpen,
  BrainCircuit,
  Check,
  CheckCircle2,
  CircleAlert,
  Eye,
  EyeOff,
  LoaderCircle,
  Plus,
  Save,
  ShieldCheck,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';

import { sendRuntimeMessage } from '../shared/chrome-api';
import type { PublicTranslatorSettings } from '../shared/messages';
import {
  DEFAULT_SETTINGS,
  DEFAULT_TRANSLATION_PROMPT,
  MAX_TRANSLATION_PROMPT_CHARACTERS,
  getActiveProfile,
  getSettingsValidationMessage,
  validateSettings,
  validateTranslationProfile,
  type TranslationProfile,
  type TranslatorSettings,
} from '../shared/settings';
import { getSettings } from '../shared/settings-store';
import { testTranslatorConfiguration } from './test-configuration';

type OptionsSection = 'api' | 'reading' | 'sites';
type Feedback = { type: 'success' | 'error' | 'working'; message: string };
type SectionFeedback = Partial<Record<OptionsSection, Feedback>>;
type ConnectionViewState =
  | { status: 'saved' }
  | { status: 'testing' }
  | { status: 'connected'; latencyMs: number; translatedText: string }
  | { status: 'error'; message: string };

interface SectionDefinition {
  id: OptionsSection;
  title: string;
  description: string;
  icon: LucideIcon;
}

const SECTIONS: readonly SectionDefinition[] = [
  {
    id: 'api',
    title: 'AI 接口',
    description: '配置 AI 服务接口、模型及认证信息',
    icon: BrainCircuit,
  },
  {
    id: 'reading',
    title: '阅读体验',
    description: '调整译文语言、展示方式与动态内容翻译',
    icon: BookOpen,
  },
  {
    id: 'sites',
    title: '站点排除',
    description: '排除不需要 AI 翻译处理的网站',
    icon: ShieldCheck,
  },
] as const;

const TARGET_LANGUAGES = [
  'Simplified Chinese',
  'Traditional Chinese',
  'English',
  'Japanese',
  'Korean',
  'French',
  'German',
  'Spanish',
];

export function OptionsApp() {
  const [activeSection, setActiveSection] = useState<OptionsSection>('api');
  const [settings, setSettings] = useState<TranslatorSettings>(DEFAULT_SETTINGS);
  const [excludedSitesText, setExcludedSitesText] = useState('');
  const [sectionFeedback, setSectionFeedback] = useState<SectionFeedback>({});
  const [connectionView, setConnectionView] = useState<ConnectionViewState>({ status: 'saved' });
  const [showApiKey, setShowApiKey] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    let mounted = true;
    void getSettings()
      .then((storedSettings) => {
        if (!mounted) return;
        setSettings(storedSettings);
        setExcludedSitesText(storedSettings.excludedSites.join('\n'));
      })
      .catch((error: unknown) => {
        if (!mounted) return;
        setSectionFeedback({
          api: { type: 'error', message: `读取设置失败：${getMessage(error)}` },
        });
      })
      .finally(() => {
        if (mounted) setLoaded(true);
      });
    return () => {
      mounted = false;
    };
  }, []);

  const draftSettings: TranslatorSettings = {
    ...settings,
    excludedSites: parseExcludedSites(excludedSitesText),
  };
  const validation = validateSettings(draftSettings);
  const activeProfile = getActiveProfile(settings);
  const activeProfileErrors = activeProfile ? validateTranslationProfile(activeProfile) : {};
  const activeConfigurationValid = Boolean(
    activeProfile &&
    Object.keys(activeProfileErrors).length === 0 &&
    draftSettings.targetLanguage.trim(),
  );
  const isTesting = connectionView.status === 'testing';
  const currentSection = SECTIONS.find((section) => section.id === activeSection) ?? SECTIONS[0];

  /** Saves the complete settings contract even though each panel edits only one concern. */
  async function handleSave(event: FormEvent, section: OptionsSection): Promise<void> {
    event.preventDefault();
    if (isSaving) return;
    if (!validation.valid) {
      updateSectionFeedback(section, {
        type: 'error',
        message: getSettingsValidationMessage(validation) ?? '配置无效',
      });
      return;
    }
    setIsSaving(true);
    updateSectionFeedback(section, { type: 'working', message: '正在保存…' });
    try {
      const normalizedSettings = normalizeSettings(draftSettings);
      const result = await sendRuntimeMessage<PublicTranslatorSettings>({
        type: 'SAVE_SETTINGS',
        settings: normalizedSettings,
      });
      if (!result.ok) throw new Error(result.error);
      if (!result.data.configured) throw new Error('后台未能确认该配置');
      setSettings(normalizedSettings);
      updateSectionFeedback(section, {
        type: 'success',
        message: section === 'api' ? '已保存，弹窗已可使用该 AI 配置。' : '设置已保存。',
      });
    } catch (error) {
      updateSectionFeedback(section, { type: 'error', message: getMessage(error) });
    } finally {
      setIsSaving(false);
    }
  }

  /** Measures the direct provider round trip without changing the shared OpenAI client. */
  async function handleTestConnection(): Promise<void> {
    if (isTesting) return;
    if (!activeConfigurationValid) {
      setConnectionView({
        status: 'error',
        message:
          Object.values(activeProfileErrors)[0] ??
          (!draftSettings.targetLanguage.trim() ? '请填写目标语言' : '配置无效'),
      });
      return;
    }
    if (!activeProfile) {
      setConnectionView({ status: 'error', message: '当前翻译配置不存在' });
      return;
    }

    const startedAt = performance.now();
    setConnectionView({ status: 'testing' });
    try {
      const translatedText = await testTranslatorConfiguration(
        activeProfile,
        draftSettings.targetLanguage,
      );
      const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
      setConnectionView({ status: 'connected', latencyMs, translatedText });
    } catch (error) {
      setConnectionView({ status: 'error', message: getMessage(error) });
    }
  }

  if (!loaded) {
    return (
      <main className="options-loading" aria-live="polite">
        <LoaderCircle aria-hidden="true" />
        正在读取本地设置…
      </main>
    );
  }

  function updateSectionFeedback(section: OptionsSection, feedback: Feedback): void {
    setSectionFeedback((current) => ({ ...current, [section]: feedback }));
  }

  function clearSectionFeedback(section: OptionsSection): void {
    setSectionFeedback((current) => {
      if (!current[section]) return current;
      const next = { ...current };
      delete next[section];
      return next;
    });
  }

  function resetConnectionResult(): void {
    setConnectionView({ status: 'saved' });
    clearSectionFeedback('api');
  }

  function updateActiveProfile(patch: Partial<TranslationProfile>): void {
    setSettings((current) => ({
      ...current,
      profiles: current.profiles.map((profile) =>
        profile.id === current.activeProfileId ? { ...profile, ...patch } : profile,
      ),
    }));
    resetConnectionResult();
  }

  function addProfile(): void {
    const profile: TranslationProfile = {
      id: crypto.randomUUID(),
      name: `配置 ${settings.profiles.length + 1}`,
      apiUrl: 'https://api.openai.com/v1',
      apiKey: '',
      model: '',
      translationPrompt: DEFAULT_TRANSLATION_PROMPT,
    };
    setSettings({
      ...settings,
      profiles: [...settings.profiles, profile],
      activeProfileId: profile.id,
    });
    resetConnectionResult();
  }

  function deleteActiveProfile(): void {
    if (settings.profiles.length <= 1) return;
    const profiles = settings.profiles.filter((profile) => profile.id !== settings.activeProfileId);
    setSettings({ ...settings, profiles, activeProfileId: profiles[0].id });
    resetConnectionResult();
  }

  return (
    <main className="options-layout">
      <OptionsSidebar activeSection={activeSection} onSelect={setActiveSection} />

      <div className="options-workspace">
        <header className="workspace-header">
          <div>
            <h1>{currentSection.title}</h1>
            <p>{currentSection.description}</p>
          </div>
          {activeSection === 'api' ? (
            <ConnectionStatusBadge state={connectionView} configured={activeConfigurationValid} />
          ) : null}
        </header>

        {activeSection === 'api' ? (
          <form
            className="settings-panel panel-enter"
            role="tabpanel"
            id="panel-api"
            aria-labelledby="tab-api"
            onSubmit={(event) => void handleSave(event, 'api')}
          >
            <div className="profile-toolbar">
              <label className="field profile-selector">
                <span>当前配置</span>
                <select
                  aria-label="当前 AI 配置"
                  value={settings.activeProfileId}
                  onChange={(event) => {
                    setSettings({ ...settings, activeProfileId: event.target.value });
                    resetConnectionResult();
                  }}
                >
                  {settings.profiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name || '未命名配置'}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="button button-secondary button-icon"
                type="button"
                onClick={addProfile}
              >
                <Plus aria-hidden="true" />
                新增配置
              </button>
              <button
                className="button button-secondary button-danger button-icon"
                type="button"
                disabled={settings.profiles.length <= 1}
                onClick={deleteActiveProfile}
              >
                <Trash2 aria-hidden="true" />
                删除配置
              </button>
            </div>

            <div className="api-field-stack">
              <label className="field">
                <span>配置名称</span>
                <input
                  aria-label="配置名称"
                  value={activeProfile?.name ?? ''}
                  onChange={(event) => updateActiveProfile({ name: event.target.value })}
                  aria-invalid={Boolean(activeProfileErrors.name)}
                />
                <FieldMessage error={activeProfileErrors.name} />
              </label>

              <label className="field">
                <span>API 地址</span>
                <input
                  aria-label="API 地址"
                  type="url"
                  value={activeProfile?.apiUrl ?? ''}
                  placeholder="https://api.openai.com/v1"
                  onChange={(event) => updateActiveProfile({ apiUrl: event.target.value })}
                  aria-invalid={Boolean(activeProfileErrors.apiUrl)}
                />
                <FieldMessage error={activeProfileErrors.apiUrl} />
              </label>

              <div className="field-grid api-credentials-grid">
                <label className="field">
                  <span>API Key</span>
                  <div className="secret-input">
                    <input
                      aria-label="API Key"
                      type={showApiKey ? 'text' : 'password'}
                      value={activeProfile?.apiKey ?? ''}
                      autoComplete="off"
                      placeholder="sk-... （本地服务可留空）"
                      onChange={(event) => updateActiveProfile({ apiKey: event.target.value })}
                    />
                    <button
                      type="button"
                      aria-label={showApiKey ? '隐藏 API Key' : '显示 API Key'}
                      onClick={() => setShowApiKey((visible) => !visible)}
                    >
                      {showApiKey ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
                      {showApiKey ? '隐藏' : '显示'}
                    </button>
                  </div>
                </label>

                <label className="field">
                  <span>模型</span>
                  <input
                    aria-label="模型"
                    value={activeProfile?.model ?? ''}
                    placeholder="gpt-4.1-mini"
                    onChange={(event) => updateActiveProfile({ model: event.target.value })}
                    aria-invalid={Boolean(activeProfileErrors.model)}
                  />
                  <FieldMessage error={activeProfileErrors.model} />
                </label>
              </div>

              <div className="field prompt-field">
                <div className="prompt-field-heading">
                  <label htmlFor="translation-prompt">自定义翻译 Prompt</label>
                  <button
                    type="button"
                    onClick={() =>
                      updateActiveProfile({
                        translationPrompt: DEFAULT_TRANSLATION_PROMPT,
                      })
                    }
                  >
                    恢复默认 Prompt
                  </button>
                </div>
                <textarea
                  id="translation-prompt"
                  aria-label="自定义翻译 Prompt"
                  rows={6}
                  maxLength={MAX_TRANSLATION_PROMPT_CHARACTERS}
                  value={activeProfile?.translationPrompt ?? ''}
                  onChange={(event) =>
                    updateActiveProfile({
                      translationPrompt: event.target.value,
                    })
                  }
                  aria-invalid={Boolean(activeProfileErrors.translationPrompt)}
                />
                <div className="prompt-guidance">
                  <small>
                    支持 {'{{targetLanguage}}'} 目标语言占位符。扩展会固定追加网页防注入、请求 ID 和
                    JSON 响应规则，确保译文能安全映射回原节点。
                  </small>
                  <small className="prompt-length">
                    {activeProfile?.translationPrompt.length ?? 0} /{' '}
                    {MAX_TRANSLATION_PROMPT_CHARACTERS}
                  </small>
                </div>
                <FieldMessage error={activeProfileErrors.translationPrompt} />
              </div>
            </div>

            <ConnectionFeedback state={connectionView} configured={activeConfigurationValid} />

            <div className="panel-footer api-actions">
              <div className="primary-actions">
                <button
                  className="button button-primary button-icon"
                  type="submit"
                  disabled={isSaving || isTesting}
                >
                  <Save aria-hidden="true" />
                  {isSaving ? '正在保存…' : '保存并启用'}
                </button>
                <button
                  className="button button-secondary"
                  type="button"
                  disabled={isTesting || isSaving}
                  onClick={() => void handleTestConnection()}
                >
                  {isTesting ? '正在测试…' : '测试连接'}
                </button>
              </div>
              <PanelFeedback feedback={sectionFeedback.api} />
            </div>
          </form>
        ) : null}

        {activeSection === 'reading' ? (
          <form
            className="settings-panel panel-enter"
            role="tabpanel"
            id="panel-reading"
            aria-labelledby="tab-reading"
            onSubmit={(event) => void handleSave(event, 'reading')}
          >
            <div className="field-grid reading-grid">
              <label className="field">
                <span>目标语言</span>
                <input
                  aria-label="目标语言"
                  list="target-languages"
                  value={settings.targetLanguage}
                  onChange={(event) => {
                    setSettings({ ...settings, targetLanguage: event.target.value });
                    setConnectionView({ status: 'saved' });
                    clearSectionFeedback('reading');
                  }}
                  aria-invalid={Boolean(validation.errors.targetLanguage)}
                />
                <datalist id="target-languages">
                  {TARGET_LANGUAGES.map((language) => (
                    <option key={language} value={language} />
                  ))}
                </datalist>
                <FieldMessage error={validation.errors.targetLanguage} />
              </label>

              <label className="field">
                <span>默认展示</span>
                <select
                  aria-label="默认展示"
                  value={settings.displayMode}
                  onChange={(event) => {
                    setSettings({
                      ...settings,
                      displayMode: event.target.value as TranslatorSettings['displayMode'],
                    });
                    clearSectionFeedback('reading');
                  }}
                >
                  <option value="bilingual">原文 + 译文</option>
                  <option value="translation">仅译文</option>
                </select>
              </label>
            </div>

            <div className="panel-divider" />

            <label className="checkbox-setting">
              <input
                type="checkbox"
                checked={settings.translateDynamicContent}
                onChange={(event) => {
                  setSettings({ ...settings, translateDynamicContent: event.target.checked });
                  clearSectionFeedback('reading');
                }}
              />
              <span className="checkbox-control" aria-hidden="true">
                <Check />
              </span>
              <span className="checkbox-copy">
                <strong>动态内容翻译</strong>
                <small>
                  自动翻译页面中动态加载的评论、弹窗和实时更新文本；关闭后仅翻译静态内容。
                </small>
              </span>
            </label>

            <div className="panel-footer panel-footer-end">
              <PanelFeedback feedback={sectionFeedback.reading} />
              <button
                className="button button-primary button-icon"
                type="submit"
                disabled={isSaving || isTesting}
              >
                <Save aria-hidden="true" />
                {isSaving ? '正在保存…' : '保存设置'}
              </button>
            </div>
          </form>
        ) : null}

        {activeSection === 'sites' ? (
          <form
            className="settings-panel panel-enter"
            role="tabpanel"
            id="panel-sites"
            aria-labelledby="tab-sites"
            onSubmit={(event) => void handleSave(event, 'sites')}
          >
            <label className="field site-rules-field">
              <span>排除站点（每行一个）</span>
              <small>输入域名或通配符，每行一个，支持 *.example.com 格式。</small>
              <textarea
                aria-label="排除站点"
                rows={10}
                value={excludedSitesText}
                placeholder={'bank.example.com\n*.internal.example.com\nlocalhost'}
                onChange={(event) => {
                  setExcludedSitesText(event.target.value);
                  clearSectionFeedback('sites');
                }}
              />
            </label>

            <div className="panel-footer panel-footer-end">
              <PanelFeedback feedback={sectionFeedback.sites} />
              <button
                className="button button-primary button-icon"
                type="submit"
                disabled={isSaving || isTesting}
              >
                <Save aria-hidden="true" />
                {isSaving ? '正在保存…' : '保存设置'}
              </button>
            </div>
          </form>
        ) : null}
      </div>
    </main>
  );
}

interface OptionsSidebarProps {
  activeSection: OptionsSection;
  onSelect: (section: OptionsSection) => void;
}

function OptionsSidebar({ activeSection, onSelect }: OptionsSidebarProps) {
  return (
    <aside className="options-sidebar">
      <div className="options-brand">
        <img src="/icons/icon.svg" alt="" />
        <span>AI 翻译设置</span>
      </div>
      <nav className="options-nav" role="tablist" aria-label="设置导航">
        {SECTIONS.map((section) => {
          const Icon = section.icon;
          const selected = section.id === activeSection;
          return (
            <button
              key={section.id}
              id={`tab-${section.id}`}
              className={selected ? 'options-nav-item is-active' : 'options-nav-item'}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`panel-${section.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => onSelect(section.id)}
            >
              <Icon aria-hidden="true" />
              <span>{section.title}</span>
            </button>
          );
        })}
      </nav>
    </aside>
  );
}

function ConnectionStatusBadge({
  state,
  configured,
}: {
  state: ConnectionViewState;
  configured: boolean;
}) {
  const presentation = getConnectionPresentation(state, configured);
  const Icon = presentation.icon;
  return (
    <div
      className={`connection-status connection-status-${presentation.tone}`}
      data-state={state.status}
      role="status"
    >
      <Icon aria-hidden="true" />
      {presentation.label}
    </div>
  );
}

function ConnectionFeedback({
  state,
  configured,
}: {
  state: ConnectionViewState;
  configured: boolean;
}) {
  let message = '配置保存在当前浏览器，测试请求会直接发送到你的 API。';
  if (state.status === 'testing') message = '正在直接请求你的 API…';
  if (state.status === 'connected') {
    message = `接口正常，响应格式有效，响应时间：${state.latencyMs}ms；测试译文：${state.translatedText}`;
  }
  if (state.status === 'error') message = `连接失败：${state.message}`;
  if (state.status === 'saved' && !configured) message = '请补全当前设置后再测试连接。';
  return (
    <div
      aria-live="polite"
      className={`connection-feedback connection-feedback-${state.status}`}
      data-state={state.status}
    >
      {message}
    </div>
  );
}

function PanelFeedback({ feedback }: { feedback?: Feedback }) {
  return (
    <div
      aria-live="polite"
      className={feedback ? `feedback feedback-${feedback.type}` : 'feedback'}
    >
      {feedback?.message ?? ''}
    </div>
  );
}

function FieldMessage({ error }: { error?: string }) {
  return error ? <small className="field-error">{error}</small> : null;
}

function getConnectionPresentation(
  state: ConnectionViewState,
  configured: boolean,
): { label: string; tone: 'saved' | 'testing' | 'connected' | 'error'; icon: LucideIcon } {
  if (state.status === 'testing') {
    return { label: '连接中', tone: 'testing', icon: LoaderCircle };
  }
  if (state.status === 'connected') {
    return { label: '已连接', tone: 'connected', icon: CheckCircle2 };
  }
  if (state.status === 'error') {
    return { label: '连接失败', tone: 'error', icon: CircleAlert };
  }
  return configured
    ? { label: '已配置', tone: 'saved', icon: CheckCircle2 }
    : { label: '待配置', tone: 'error', icon: CircleAlert };
}

function normalizeSettings(settings: TranslatorSettings): TranslatorSettings {
  return {
    ...settings,
    profiles: settings.profiles.map((profile) => ({
      ...profile,
      name: profile.name.trim(),
      apiUrl: profile.apiUrl.trim(),
      model: profile.model.trim(),
      translationPrompt: profile.translationPrompt.trim(),
    })),
    targetLanguage: settings.targetLanguage.trim(),
  };
}

function parseExcludedSites(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/\r?\n/u)
        .map((site) => site.trim())
        .filter(Boolean),
    ),
  ];
}

function getMessage(error: unknown): string {
  return error instanceof Error ? error.message : '保存失败';
}
