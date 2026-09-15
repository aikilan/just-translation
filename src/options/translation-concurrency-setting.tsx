import { useEffect, useRef, useState } from 'react';
import type { PublicTranslatorSettings } from '../shared/messages';
import { MAX_TRANSLATION_CONCURRENCY, type TranslatorSettings } from '../shared/settings';
import { SettingRow, useSettingsMutation } from '../ui/controls';

interface Props {
  settings: TranslatorSettings;
  onSaved: (result: PublicTranslatorSettings) => void;
}

/** Global request settings save independently of the selected AI profile's unsaved draft. */
export function TranslationConcurrencySetting({ settings, onSaved }: Props) {
  const [draft, setDraft] = useState(settings.translationConcurrency);
  const previous = useRef(settings.translationConcurrency);
  const { feedback, save, clear } = useSettingsMutation();
  useEffect(() => {
    const old = previous.current;
    setDraft((current) => (current === old ? settings.translationConcurrency : current));
    previous.current = settings.translationConcurrency;
  }, [settings.translationConcurrency]);

  function change(value: number) {
    setDraft(value);
    clear('translationConcurrency');
    void save(
      'translationConcurrency',
      { type: 'UPDATE_READING_PREFERENCES', patch: { translationConcurrency: value } },
      (result) => {
        setDraft(result.translationConcurrency);
        onSaved(result);
      },
    );
  }

  return (
    <div className="preferences-list">
      <SettingRow
        label="单页翻译并发数"
        description="所有 AI 配置共用，默认 6。修改后自动保存，下次翻译生效；可视区完成后仍会继续翻译屏外内容。"
        feedback={feedback.translationConcurrency}
      >
        <select
          aria-label="单页翻译并发数"
          value={draft}
          disabled={feedback.translationConcurrency?.status === 'saving'}
          onChange={(event) => change(Number(event.target.value))}
        >
          {Array.from({ length: MAX_TRANSLATION_CONCURRENCY }, (_, i) => i + 1).map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </SettingRow>
    </div>
  );
}
