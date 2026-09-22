import { t, message, LocalizedError, renderMessage, type UiMessage } from '../shared/i18n';
import { Check, LoaderCircle, RotateCcw } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { sendRuntimeMessage } from '../shared/chrome-api';
import {
  getErrorMessage,
  type PublicTranslatorSettings,
  type RuntimeRequest,
} from '../shared/messages';
import type { DisplayMode } from '../shared/settings';
import { TRANSLATION_LANGUAGES } from '../shared/translation-languages';
export type SaveState =
  | { status: 'saving' }
  | { status: 'saved' }
  | { status: 'error'; message: UiMessage; retry: () => void };

/** Tracks independent writes and guards same-control reentry before React has rendered. */
export function useSettingsMutation() {
  const [feedback, setFeedback] = useState<Record<string, SaveState | undefined>>({});
  const pending = useRef(new Set<string>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function save(
    key: string,
    request: RuntimeRequest,
    onSuccess: (value: PublicTranslatorSettings) => void,
  ): Promise<void> {
    if (pending.current.has(key)) return;
    pending.current.add(key);
    setFeedback((current) => ({ ...current, [key]: { status: 'saving' } }));
    try {
      const response = await sendRuntimeMessage<PublicTranslatorSettings>(request);
      if (!response.ok) throw new LocalizedError(response.error);
      if (mounted.current) {
        onSuccess(response.data);
        setFeedback((current) => ({ ...current, [key]: { status: 'saved' } }));
      }
    } catch (error) {
      if (mounted.current)
        setFeedback((current) => ({
          ...current,
          [key]: {
            status: 'error',
            message: getErrorMessage(error),
            retry: () => {
              void save(key, request, onSuccess);
            },
          },
        }));
    } finally {
      pending.current.delete(key);
    }
  }
  function clear(key: string) {
    setFeedback((current) => ({ ...current, [key]: undefined }));
  }
  return { feedback, save, clear };
}

export function SaveFeedback({ state }: { state?: SaveState }) {
  if (!state) return null;
  return (
    <div
      className={`save-feedback is-${state.status}`}
      role={state.status === 'error' ? 'alert' : 'status'}
    >
      {state.status === 'saving' ? (
        <>
          <LoaderCircle className="spin" aria-hidden="true" />
          {t('保存中…')}
        </>
      ) : state.status === 'saved' ? (
        <>
          <Check aria-hidden="true" />
          {t('已保存')}
        </>
      ) : (
        <>
          <span>{renderMessage(state.message)}</span>
          <button type="button" className="text-button" onClick={state.retry}>
            <RotateCcw aria-hidden="true" />
            {t('重试保存')}
          </button>
        </>
      )}
    </div>
  );
}

export function LanguagePicker({
  value,
  onChange,
  disabled,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  label: string;
}) {
  const [custom, setCustom] = useState(!TRANSLATION_LANGUAGES.some(([id]) => id === value));
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<UiMessage | ''>('');
  const id = useId();
  useEffect(() => {
    setDraft(value);
    if (!TRANSLATION_LANGUAGES.some(([id]) => id === value)) setCustom(true);
  }, [value]);
  function commit() {
    if (!draft.trim()) {
      setError(message('请填写目标语言'));
      return;
    }
    setError('');
    if (draft.trim() !== value) onChange(draft.trim());
  }
  return (
    <div className="language-picker">
      <select
        aria-label={label}
        disabled={disabled}
        value={custom ? '__custom__' : value}
        onChange={(event) => {
          const next = event.target.value;
          setCustom(next === '__custom__');
          setError('');
          if (next !== '__custom__') onChange(next);
        }}
      >
        {TRANSLATION_LANGUAGES.map(([id, name]) => (
          <option key={id} value={id}>
            {t(name)}
          </option>
        ))}
        <option value="__custom__">{t('自定义语言…')}</option>
      </select>
      {custom ? (
        <input
          aria-label={t('自定义目标语言')}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? id : undefined}
          disabled={disabled}
          value={draft}
          placeholder={t('输入目标语言')}
          onChange={(event) => {
            setDraft(event.target.value);
            setError('');
          }}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commit();
            }
          }}
        />
      ) : null}
      {error ? (
        <small id={id} className="field-error" role="alert">
          {renderMessage(error)}
        </small>
      ) : null}
    </div>
  );
}

export function DisplayModeControl({
  value,
  onChange,
  disabled,
}: {
  value: DisplayMode;
  onChange: (value: DisplayMode) => void;
  disabled?: boolean;
}) {
  return (
    <div className="segmented-control" role="group" aria-label={t('显示方式')}>
      {(['bilingual', 'translation'] as const).map((mode) => (
        <button
          key={mode}
          type="button"
          disabled={disabled}
          aria-pressed={value === mode}
          onClick={() => onChange(mode)}
        >
          {mode === 'bilingual' ? t('双语') : t('仅译文')}
        </button>
      ))}
    </div>
  );
}

export function Switch({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="switch">
      <input
        type="checkbox"
        role="switch"
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span aria-hidden="true" />
    </label>
  );
}

export function SettingRow({
  label,
  description,
  children,
  feedback,
}: {
  label: string;
  description?: string;
  children: ReactNode;
  feedback?: SaveState;
}) {
  return (
    <div className="setting-row">
      <div className="setting-row-main">
        <div className="setting-copy">
          <span>{label}</span>
          {description ? <small>{description}</small> : null}
        </div>
        <div className="setting-control">{children}</div>
      </div>
      <SaveFeedback state={feedback} />
    </div>
  );
}
