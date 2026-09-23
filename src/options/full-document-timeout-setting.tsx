import { useEffect, useRef, useState } from 'react';
import { t } from '../shared/i18n';
import { isValidFullDocumentTimeout, type TranslatorSettings } from '../shared/settings';
import type { PublicTranslatorSettings } from '../shared/messages';
import { SettingRow, useSettingsMutation } from '../ui/controls';

/** A single global preference, saved independently from unsaved provider configuration. */
export function FullDocumentTimeoutSetting({
  settings,
  onSaved,
}: {
  settings: TranslatorSettings;
  onSaved: (settings: PublicTranslatorSettings) => void;
}) {
  const [draft, setDraft] = useState(String(settings.fullDocumentTimeoutMinutes));
  const previous = useRef(settings.fullDocumentTimeoutMinutes);
  const [invalid, setInvalid] = useState(false);
  const { feedback, save, clear } = useSettingsMutation();
  useEffect(() => {
    const old = previous.current;
    setDraft((current) =>
      current === String(old) ? String(settings.fullDocumentTimeoutMinutes) : current,
    );
    previous.current = settings.fullDocumentTimeoutMinutes;
  }, [settings.fullDocumentTimeoutMinutes]);
  function commit() {
    const value = Number(draft);
    const valid = draft.trim() !== '' && isValidFullDocumentTimeout(value);
    setInvalid(!valid);
    if (!valid || value === settings.fullDocumentTimeoutMinutes) return;
    void save(
      'fullDocumentTimeoutMinutes',
      { type: 'UPDATE_READING_PREFERENCES', patch: { fullDocumentTimeoutMinutes: value } },
      (result) => {
        setDraft(String(result.fullDocumentTimeoutMinutes));
        onSaved(result);
      },
    );
  }
  return (
    <div className="preferences-list">
      <SettingRow
        label={t('全文最长等待（分钟）')}
        description={t(
          '仅用于 AI 全文翻译。默认 10 分钟；首次输出 120 秒、输出停滞 60 秒保护仍然有效。下次翻译生效。',
        )}
        feedback={feedback.fullDocumentTimeoutMinutes}
      >
        <input
          type="number"
          min={2}
          max={60}
          step={1}
          aria-label={t('全文最长等待（分钟）')}
          aria-invalid={invalid}
          value={draft}
          disabled={feedback.fullDocumentTimeoutMinutes?.status === 'saving'}
          onChange={(event) => {
            setDraft(event.target.value);
            setInvalid(false);
            clear('fullDocumentTimeoutMinutes');
          }}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
          }}
        />
        {invalid ? <p role="alert">{t('全文最长等待必须是 2–60 的整数')}</p> : null}
      </SettingRow>
    </div>
  );
}
