import {
  BookOpen,
  Globe2,
  LoaderCircle,
  Settings2,
  SlidersHorizontal,
  ShieldCheck,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import packageJson from '../../package.json' with { type: 'json' };
import { getSettings } from '../shared/settings-store';
import { getErrorMessage, type PublicTranslatorSettings } from '../shared/messages';
import type { TranslationProfile, TranslatorSettings } from '../shared/settings';
import { AIConfiguration } from './ai-configuration';
import { TranslationConcurrencySetting } from './translation-concurrency-setting';
import { TranslationRetrySetting } from './translation-retry-setting';
import { ReadingPreferencesPanel, SiteRulesPanel } from './preference-panels';

type Section = 'api' | 'reading' | 'sites';
const sections = [
  {
    id: 'api',
    title: 'AI 配置',
    description: '连接你的 AI，管理用于翻译的服务。',
    icon: Settings2,
  },
  {
    id: 'reading',
    title: '阅读偏好',
    description: '让译文以你习惯的方式出现。修改后自动保存。',
    icon: BookOpen,
  },
  {
    id: 'sites',
    title: '站点规则',
    description: '决定哪些网站自动翻译，哪些网站保持原样。',
    icon: Globe2,
  },
] as const;

/** Owns confirmed settings only. Each editor keeps unsaved values within its own concern. */
export function OptionsApp() {
  const [settings, setSettings] = useState<TranslatorSettings>();
  const [error, setError] = useState('');
  const [section, setSection] = useState<Section>(() =>
    location.hash === '#sites' ? 'sites' : location.hash === '#reading' ? 'reading' : 'api',
  );
  useEffect(() => {
    let mounted = true;
    let revision = 0;
    async function refresh() {
      const request = ++revision;
      try {
        const value = await getSettings();
        if (mounted && request === revision) {
          setSettings(value);
          setError('');
        }
      } catch (reason) {
        if (mounted) setError(getErrorMessage(reason));
      }
    }
    void refresh();
    const changed = (_changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local') void refresh();
    };
    chrome.storage.onChanged.addListener(changed);
    return () => {
      mounted = false;
      chrome.storage.onChanged.removeListener(changed);
    };
  }, []);
  function acceptPublic(value: PublicTranslatorSettings) {
    setSettings(
      (current) =>
        current && {
          ...current,
          activeProfileId: value.activeProfileId,
          targetLanguage: value.targetLanguage,
          displayMode: value.displayMode,
          translateDynamicContent: value.translateDynamicContent,
          translationConcurrency: value.translationConcurrency,
          translationRetryCount: value.translationRetryCount,
          autoTranslateSites: value.autoTranslateSites,
          excludedSites: value.excludedSites,
        },
    );
  }
  function savedProfile(profile: TranslationProfile, value: PublicTranslatorSettings) {
    setSettings(
      (current) =>
        current && {
          ...current,
          activeProfileId: value.activeProfileId,
          profiles: current.profiles.some((item) => item.id === profile.id)
            ? current.profiles.map((item) => (item.id === profile.id ? profile : item))
            : [...current.profiles, profile],
        },
    );
  }
  function deletedProfile(id: string, value: PublicTranslatorSettings) {
    setSettings(
      (current) =>
        current && {
          ...current,
          activeProfileId: value.activeProfileId,
          profiles: current.profiles.filter((item) => item.id !== id),
        },
    );
  }
  function navigate(next: Section) {
    setSection(next);
    history.replaceState(null, '', `#${next}`);
  }
  const active = sections.find((item) => item.id === section)!;
  return (
    <main className="options-layout">
      <aside className="options-sidebar">
        <a
          className="options-brand"
          href="#api"
          onClick={(event) => {
            event.preventDefault();
            navigate('api');
          }}
        >
          <img src="/icons/icon.svg" alt="" />
          <span>
            只是翻译<small>设置</small>
          </span>
        </a>
        <nav className="options-nav" aria-label="设置导航">
          {sections.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-current={section === item.id ? 'page' : undefined}
              onClick={() => navigate(item.id)}
            >
              <item.icon aria-hidden="true" />
              {item.title}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <span>你的 API，你的阅读方式。</span>
          <small>版本 {packageJson.version}</small>
        </div>
      </aside>
      <div className="options-workspace">
        <header className="workspace-header">
          <span className="eyebrow">偏好设置</span>
          <h1>{active.title}</h1>
          <p>{active.description}</p>
        </header>
        {error ? (
          <div role="alert" className="load-error">
            <h2>无法读取本地设置</h2>
            <p>{error}</p>
            <button className="button" onClick={() => location.reload()}>
              重新加载
            </button>
          </div>
        ) : !settings ? (
          <p role="status" className="loading-state">
            <LoaderCircle className="spin" aria-hidden="true" />
            正在读取本地设置…
          </p>
        ) : (
          <>
            <section className="ai-workspace" hidden={section !== 'api'} aria-label="AI 配置">
              <div className="configuration-editor" role="region" aria-label="配置编辑器">
                <AIConfiguration
                  settings={settings}
                  onSaved={savedProfile}
                  onDeleted={deletedProfile}
                  onActivated={acceptPublic}
                />
              </div>
              <aside className="translation-preferences" aria-label="翻译偏好">
                <div className="inspector-heading">
                  <SlidersHorizontal aria-hidden="true" />
                  <h2>翻译偏好</h2>
                </div>
                <p className="inspector-description">
                  所有 AI 配置共用，修改后自动保存。
                  <br />
                  下次翻译生效。
                </p>
                <TranslationConcurrencySetting settings={settings} onSaved={acceptPublic} />
                <TranslationRetrySetting settings={settings} onSaved={acceptPublic} />
                <div className="privacy-note">
                  <ShieldCheck aria-hidden="true" />
                  <div>
                    <strong>只在你的浏览器中保存</strong>
                    <p>密钥保存在本地，翻译请求直接发送到你配置的 API。</p>
                  </div>
                </div>
              </aside>
            </section>
            <section
              className="preference-workspace"
              hidden={section !== 'reading'}
              aria-label="阅读偏好"
            >
              <ReadingPreferencesPanel settings={settings} onSaved={acceptPublic} />
            </section>
            <section
              className="preference-workspace"
              hidden={section !== 'sites'}
              aria-label="站点规则"
            >
              <SiteRulesPanel settings={settings} onSaved={acceptPublic} />
            </section>
          </>
        )}
      </div>
    </main>
  );
}
