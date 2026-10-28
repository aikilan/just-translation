import {
  t,
  message,
  LocalizedError,
  renderMessage,
  type MessageKey,
  type UiMessage,
} from '../shared/i18n';
import { Check, LoaderCircle, RotateCcw } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { sendRuntimeMessage } from '../shared/chrome-api';
import {
  getErrorMessage,
  type PublicTranslatorSettings,
  type RuntimeRequest,
} from '../shared/messages';
import { TRANSLATION_STYLES, type DisplayMode, type TranslationStyle } from '../shared/settings';
import type { BuiltinTranslatorId } from '../shared/translation-engines';
import {
  builtinLanguageCode,
  isPresetTranslationLanguage,
  sortedTranslationLanguages,
  translationLanguageLabel,
  type TranslationLanguage,
} from '../shared/translation-languages';
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
  onDraftChange,
  disabled,
  label,
  allowCustom,
  builtinEngine,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Live custom input, including invalid drafts; onChange commits only valid values. */
  onDraftChange?: (value: string) => void;
  disabled?: boolean;
  label: string;
  allowCustom: boolean;
  /** Presets the selected free engine cannot translate into stay visible but disabled. */
  builtinEngine?: BuiltinTranslatorId;
}) {
  const [custom, setCustom] = useState(!isPresetTranslationLanguage(value));
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<UiMessage | ''>('');
  const previousValue = useRef(value);
  const id = useId();
  useEffect(() => {
    if (previousValue.current === value) return;
    previousValue.current = value;
    // A parent reflecting the current draft must not hide the custom input mid-edit.
    if (value === draft) return;
    setDraft(value);
    setCustom(!isPresetTranslationLanguage(value));
  }, [value, draft]);
  const { common, others } = sortedTranslationLanguages();
  const renderOption = (language: TranslationLanguage) => (
    <option
      key={language.id}
      value={language.id}
      disabled={Boolean(builtinEngine && !builtinLanguageCode(builtinEngine, language.id))}
    >
      {translationLanguageLabel(language.id)}
    </option>
  );
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
          if (next !== '__custom__') {
            setDraft(next);
            onChange(next);
          }
        }}
      >
        <optgroup label={t('常用语言')}>{common.map(renderOption)}</optgroup>
        <optgroup label={t('全部语言')}>{others.map(renderOption)}</optgroup>
        <option value="__custom__" disabled={!allowCustom}>
          {t('自定义语言…')}
        </option>
      </select>
      {custom ? (
        <input
          aria-label={t('自定义目标语言')}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `${id}-error` : !allowCustom ? `${id}-guidance` : undefined}
          disabled={disabled || !allowCustom}
          value={draft}
          placeholder={t('输入目标语言')}
          onChange={(event) => {
            setDraft(event.target.value);
            setError('');
            onDraftChange?.(event.target.value);
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
        <small id={`${id}-error`} className="field-error" role="alert">
          {renderMessage(error)}
        </small>
      ) : null}
      {!allowCustom ? (
        <small id={`${id}-guidance`} className="field-guidance">
          {t('自定义目标语言仅支持 AI 配置')}
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

const TRANSLATION_STYLE_LABELS = {
  inherit: '继承网页',
  faded: '弱化',
  dashed: '虚线下划线',
  highlight: '背景高亮',
  quote: '引用竖线',
  blur: '学习模式（悬停显示）',
} as const satisfies Record<TranslationStyle, MessageKey>;

export function TranslationStyleControl({
  value,
  onChange,
  disabled,
}: {
  value: TranslationStyle;
  onChange: (value: TranslationStyle) => void;
  disabled?: boolean;
}) {
  return (
    <select
      aria-label={t('译文样式')}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value as TranslationStyle)}
    >
      {TRANSLATION_STYLES.map((style) => (
        <option key={style} value={style}>
          {t(TRANSLATION_STYLE_LABELS[style])}
        </option>
      ))}
    </select>
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
