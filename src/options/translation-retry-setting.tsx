import { t } from '../shared/i18n';
import { useEffect, useRef, useState } from 'react';
import type { PublicTranslatorSettings } from '../shared/messages';
import { MAX_TRANSLATION_RETRY_COUNT, type TranslatorSettings } from '../shared/settings';
import { SettingRow, useSettingsMutation } from '../ui/controls';

interface Props {
  settings: TranslatorSettings;
  onSaved: (result: PublicTranslatorSettings) => void;
}

/** Saves the global retry budget independently of unsaved AI profile edits. */
export function TranslationRetrySetting({ settings, onSaved }: Props) {
  const [draft, setDraft] = useState(settings.translationRetryCount);
  const previous = useRef(settings.translationRetryCount);
  const { feedback, save, clear } = useSettingsMutation();
  useEffect(() => {
    const old = previous.current;
    setDraft((current) => (current === old ? settings.translationRetryCount : current));
    previous.current = settings.translationRetryCount;
  }, [settings.translationRetryCount]);

  /** Retains a failed selection locally so the same value can be saved again. */
  function change(value: number) {
    setDraft(value);
    clear('translationRetryCount');
    void save(
      'translationRetryCount',
      { type: 'UPDATE_READING_PREFERENCES', patch: { translationRetryCount: value } },
      (result) => {
        setDraft(result.translationRetryCount);
        onSaved(result);
      },
    );
  }

  return (
    <div className="preferences-list">
      <SettingRow
        label={t('翻译失败重试次数')}
        description={t('默认 1 次，0 表示不重试。仅用于普通翻译，全文翻译不自动重试。')}
        feedback={feedback.translationRetryCount}
      >
        <select
          aria-label={t('翻译失败重试次数')}
          value={draft}
          disabled={feedback.translationRetryCount?.status === 'saving'}
          onChange={(event) => change(Number(event.target.value))}
        >
          {Array.from({ length: MAX_TRANSLATION_RETRY_COUNT + 1 }, (_, value) => (
            <option key={value} value={value}>
              {value === 0 ? t('0 次（不重试）') : t('retryCount', { count: value })}
            </option>
          ))}
        </select>
      </SettingRow>
    </div>
  );
}
