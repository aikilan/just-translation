import {
  t,
  message,
  toUiMessage,
  renderMessage,
  type UiMessage,
  getUiLocale,
} from '../shared/i18n';
import { ArrowDown, Plus, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type {
  PublicTranslatorSettings,
  ReadingPreferences,
  SiteRuleUpdate,
} from '../shared/messages';
import { isUrlExcluded, normalizeSiteRule, type TranslatorSettings } from '../shared/settings';
import {
  DisplayModeControl,
  LanguagePicker,
  SaveFeedback,
  SettingRow,
  Switch,
  useSettingsMutation,
} from '../ui/controls';

interface Props {
  settings: TranslatorSettings;
  onSaved: (result: PublicTranslatorSettings) => void;
}

export function ReadingPreferencesPanel({ settings, onSaved }: Props) {
  const [draft, setDraft] =
    useState<Omit<ReadingPreferences, 'translationConcurrency' | 'translationRetryCount'>>(
      settings,
    );
  const { feedback, save, clear } = useSettingsMutation();
  const previous = useRef(settings);
  useEffect(() => {
    const old = previous.current;
    setDraft((current) => ({
      targetLanguage:
        current.targetLanguage === old.targetLanguage
          ? settings.targetLanguage
          : current.targetLanguage,
      displayMode:
        current.displayMode === old.displayMode ? settings.displayMode : current.displayMode,
      translateDynamicContent:
        current.translateDynamicContent === old.translateDynamicContent
          ? settings.translateDynamicContent
          : current.translateDynamicContent,
    }));
    previous.current = settings;
  }, [settings]);

  /** Writes just the changed preference; failed input remains local and retryable. */
  function change<K extends keyof typeof draft>(key: K, value: (typeof draft)[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
    clear(key);
    void save(key, { type: 'UPDATE_READING_PREFERENCES', patch: { [key]: value } }, (result) => {
      setDraft((current) => ({ ...current, [key]: result[key] }));
      onSaved(result);
    });
  }
  return (
    <>
      <div className="preferences-list">
        <SettingRow
          label={t('目标语言')}
          description={t('下一次翻译时使用的语言')}
          feedback={feedback.targetLanguage}
        >
          <LanguagePicker
            label={t('目标语言')}
            value={draft.targetLanguage}
            disabled={feedback.targetLanguage?.status === 'saving'}
            onChange={(value) => change('targetLanguage', value)}
          />
        </SettingRow>
        <SettingRow
          label={t('默认展示')}
          description={t('双语阅读或专注译文')}
          feedback={feedback.displayMode}
        >
          <DisplayModeControl
            value={draft.displayMode}
            disabled={feedback.displayMode?.status === 'saving'}
            onChange={(value) => change('displayMode', value)}
          />
        </SettingRow>
        <SettingRow
          label={t('动态内容翻译')}
          description={t('继续翻译后来加载的正文、评论等内容')}
          feedback={feedback.translateDynamicContent}
        >
          <Switch
            label={t('动态内容翻译')}
            checked={draft.translateDynamicContent}
            disabled={feedback.translateDynamicContent?.status === 'saving'}
            onChange={(value) => change('translateDynamicContent', value)}
          />
        </SettingRow>
      </div>
      <div className="reading-preview-heading">
        <h2>{t('阅读效果')}</h2>
        <span>{t('排版示例 · 不调用 API')}</span>
      </div>
      <div className="reading-preview" data-reading-preview>
        <span className="eyebrow">{t('一小段阅读时光')}</span>
        <h3>{t('让好奇心走得更远')}</h3>
        {draft.displayMode === 'bilingual' ? (
          <>
            <p lang="en" dir="ltr">
              Reading opens a window to ideas beyond our everyday world. A few quiet moments can
              change how we see things.
            </p>
            <ArrowDown aria-hidden="true" className="preview-arrow" />
          </>
        ) : null}
        <p lang={getUiLocale()} dir={getUiLocale() === 'ar' ? 'rtl' : 'ltr'}>
          {t('阅读为我们打开一扇窗，通往日常之外的思想。片刻安静，也能改变我们看待世界的方式。')}
        </p>
        <small>{t('实际译文继承所在网页的字体与颜色。')}</small>
      </div>
      <p className="section-note">
        {t('语言与动态翻译偏好用于下一次翻译。已打开网页的显示方式可在插件弹窗中切换。')}
      </p>
    </>
  );
}

export function SiteRulesPanel({ settings, onSaved }: Props) {
  return (
    <div className="site-rules">
      <SiteRuleList list="autoTranslateSites" settings={settings} onSaved={onSaved} />
      <SiteRuleList list="excludedSites" settings={settings} onSaved={onSaved} />
    </div>
  );
}

function SiteRuleList({ list, settings, onSaved }: Props & { list: SiteRuleUpdate['list'] }) {
  const excluded = list === 'excludedSites';
  const name = excluded ? t('不翻译') : t('自动翻译');
  const [input, setInput] = useState('');
  const [error, setError] = useState<UiMessage | ''>('');
  const { feedback, save, clear } = useSettingsMutation();
  const saving = feedback.rule?.status === 'saving';
  const sites = settings[list];
  function update(hostname: string, enabled: boolean) {
    if (saving) return;
    try {
      const normalized = normalizeSiteRule(hostname, excluded);
      if (enabled && sites.includes(normalized)) {
        setError(message('此站点已在列表中'));
        return;
      }
      setError('');
      void save(
        'rule',
        { type: 'UPDATE_SITE_RULE', rule: { list, hostname: normalized, enabled } },
        (result) => {
          if (enabled) setInput('');
          onSaved(result);
        },
      );
    } catch (reason) {
      setError(reason instanceof Error ? toUiMessage(reason) : message('域名无效'));
    }
  }
  return (
    <section className="site-rule-section">
      <div className="section-heading">
        <h2>{name}</h2>
        <span className="rule-count">{t('siteCount', { count: sites.length })}</span>
      </div>
      <p>
        {excluded
          ? t('这些站点始终保持原文。不翻译优先于自动翻译。')
          : t('进入这些网站时自动开始翻译，仅匹配填写的精确域名。')}
      </p>
      <form
        className="site-add-form"
        onSubmit={(event) => {
          event.preventDefault();
          update(input, true);
        }}
      >
        <input
          aria-label={t('{{p0}}域名', { p0: name })}
          value={input}
          disabled={saving}
          placeholder={excluded ? t('example.com 或 *.example.com') : 'news.example.com'}
          spellCheck={false}
          dir="ltr"
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `${list}-error` : undefined}
          onChange={(event) => {
            setInput(event.target.value);
            setError('');
            clear('rule');
          }}
        />
        <button
          type="submit"
          className="button"
          disabled={saving}
          aria-label={t('添加{{p0}}站点', { p0: name })}
        >
          <Plus aria-hidden="true" />
          {t('添加')}
        </button>
      </form>
      {error ? (
        <p className="field-error" role="alert" id={`${list}-error`}>
          {renderMessage(error)}
        </p>
      ) : null}
      <SaveFeedback state={feedback.rule} />
      {sites.length ? (
        <ul className="site-list">
          {sites.map((hostname) => (
            <li key={hostname}>
              <div>
                <span className="site-hostname" dir="ltr">
                  {hostname}
                </span>
                {!excluded && isUrlExcluded(`https://${hostname}`, settings.excludedSites) ? (
                  <small className="rule-conflict">{t('匹配排除规则，不翻译优先')}</small>
                ) : null}
              </div>
              <button
                type="button"
                className="icon-button"
                disabled={saving}
                aria-label={t('删除{{p0}}站点 {{p1}}', { p0: name, p1: hostname })}
                onClick={() => update(hostname, false)}
              >
                <Trash2 aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="empty-rules">
          <span>{excluded ? t('还没有不翻译的站点') : t('还没有自动翻译的站点')}</span>
          <small>
            {excluded
              ? t('添加域名，让这些网站保持原样。')
              : t('也可以在网页的插件弹窗中开启“此站自动翻译”。')}
          </small>
        </div>
      )}
    </section>
  );
}
