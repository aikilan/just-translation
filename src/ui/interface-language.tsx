import { useTranslation } from 'react-i18next';
import { useEffect, useRef, useState } from 'react';
import { getUiLocale, isUiLanguage, setUiLanguage, t, i18n, type UiLanguage } from '../shared/i18n';
import type { PublicTranslatorSettings } from '../shared/messages';
import { SaveFeedback, useSettingsMutation } from './controls';

/** Updates extension-owned document metadata without remounting any editor or losing drafts. */
export function useInterfaceLanguage(
  settings: { uiLanguage: UiLanguage } | undefined,
  options = false,
): void {
  useTranslation(undefined, { i18n });
  const locale = getUiLocale();
  useEffect(() => {
    if (settings) setUiLanguage(settings.uiLanguage);
  }, [settings?.uiLanguage]);
  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr';
    document.title = options ? t('只是翻译 · 设置') : t('只是翻译');
  }, [locale, options]);
}

/** This independent preference saves only its own value and never touches AI configuration drafts. */
export function InterfaceLanguage({
  value,
  onSaved,
}: {
  value: UiLanguage;
  onSaved: (settings: PublicTranslatorSettings) => void;
}) {
  const [draft, setDraft] = useState(value);
  const previous = useRef(value);
  const { feedback, save, clear } = useSettingsMutation();
  useEffect(() => {
    const old = previous.current;
    setDraft((current) => (current === old ? value : current));
    previous.current = value;
  }, [value]);
  return (
    <label className="interface-language">
      <span>{t('界面语言')}</span>
      <select
        aria-label={t('界面语言')}
        value={draft}
        disabled={feedback.locale?.status === 'saving'}
        onChange={(event) => {
          const choice = event.target.value;
          if (!isUiLanguage(choice)) return;
          setDraft(choice);
          clear('locale');
          void save('locale', { type: 'UPDATE_UI_LANGUAGE', uiLanguage: choice }, (result) => {
            setDraft(result.uiLanguage);
            setUiLanguage(result.uiLanguage);
            onSaved(result);
          });
        }}
      >
        <option value="system">{t('跟随浏览器')}</option>
        <option value="zh-CN" lang="zh-CN">
          简体中文
        </option>
        <option value="en" lang="en">
          English
        </option>
        <option value="fr" lang="fr">
          Français
        </option>
        <option value="de" lang="de">
          Deutsch
        </option>
        <option value="ar" lang="ar" dir="rtl">
          العربية
        </option>
      </select>
      <SaveFeedback state={feedback.locale} />
    </label>
  );
}
