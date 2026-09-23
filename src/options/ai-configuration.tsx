import { t, renderMessage, type UiMessage } from '../shared/i18n';
import { DEFAULT_PROVIDER_OPTIONS, getModelCapability } from '../shared/providers';
import {
  ProviderFields,
  ThinkingFields,
  ModelSuggestions,
  ImageInputFields,
} from './provider-fields';
import { Check, Eye, EyeOff, LoaderCircle, Plus, Trash2 } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { getErrorMessage, type PublicTranslatorSettings } from '../shared/messages';
import {
  DEFAULT_TRANSLATION_PROMPT,
  MAX_TRANSLATION_PROMPT_CHARACTERS,
  normalizeTranslationProfile,
  validateTranslationProfile,
  type TranslationProfile,
  type TranslatorSettings,
  type TranslationProfileValidationErrors,
} from '../shared/settings';
import { SaveFeedback, useSettingsMutation } from '../ui/controls';
import { testTranslatorConfiguration } from './test-configuration';

type TestState =
  | { status: 'untested' }
  | { status: 'testing' }
  | { status: 'passed'; text: string; latency: number }
  | { status: 'failed'; message: UiMessage };
interface Props {
  settings: TranslatorSettings;
  onSaved: (profile: TranslationProfile, result: PublicTranslatorSettings) => void;
  onDeleted: (id: string, result: PublicTranslatorSettings) => void;
  onActivated: (result: PublicTranslatorSettings) => void;
}
const sameProfile = (a: TranslationProfile | undefined, b: TranslationProfile | undefined) =>
  JSON.stringify(a) === JSON.stringify(b);

/** Keeps profile drafts independent from global activation, automatic preferences and connection tests. */
export function AIConfiguration({ settings, onSaved, onDeleted, onActivated }: Props) {
  const activeProfileId =
    settings.activeTranslator.kind === 'ai' ? settings.activeTranslator.profileId : undefined;
  const defaultProfileId = activeProfileId ?? settings.profiles[0]?.id ?? '';
  const [drafts, setDrafts] = useState(settings.profiles);
  const [selectedId, setSelectedId] = useState(defaultProfileId);
  const [tests, setTests] = useState<Record<string, TestState>>({});
  const [touched, setTouched] = useState<Record<string, TranslationProfileValidationErrors>>({});
  const [showKey, setShowKey] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const previous = useRef(settings.profiles);
  const testVersion = useRef(0);
  const testing = useRef(false);
  const alive = useRef(true);
  const dialog = useRef<HTMLDialogElement>(null);
  const deleteTrigger = useRef<HTMLButtonElement>(null);
  const { feedback, save, clear } = useSettingsMutation();
  const idPrefix = useId();
  const editedAddresses = useRef(new Set<string>());
  const profile = drafts.find((item) => item.id === selectedId);
  const persisted = settings.profiles.find((item) => item.id === selectedId);
  const dirty = !sameProfile(profile, persisted);
  const anyDirty = drafts.some(
    (item) =>
      !sameProfile(
        item,
        settings.profiles.find((saved) => saved.id === item.id),
      ),
  );
  const busy = feedback.ai?.status === 'saving';
  const state = tests[selectedId] ?? { status: 'untested' };
  const validation = profile ? validateTranslationProfile(profile) : {};
  const errors = touched[selectedId] ?? {};
  const current = selectedId === activeProfileId;
  const firstRun = settings.profiles.every(
    (item) => Object.keys(validateTranslationProfile(item)).length > 0,
  );

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      testVersion.current += 1;
    };
  }, []);
  useEffect(() => {
    const oldSaved = previous.current;
    setDrafts((existing) => [
      ...settings.profiles.map((saved) => {
        const draft = existing.find((item) => item.id === saved.id);
        return draft &&
          !sameProfile(
            draft,
            oldSaved.find((item) => item.id === saved.id),
          )
          ? draft
          : saved;
      }),
      ...existing.filter(
        (item) =>
          !settings.profiles.some((saved) => saved.id === item.id) &&
          !oldSaved.some((saved) => saved.id === item.id),
      ),
    ]);
    previous.current = settings.profiles;
  }, [settings.profiles]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (anyDirty) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [anyDirty]);
  useEffect(() => {
    testVersion.current += 1;
    testing.current = false;
    setTests({});
  }, [settings.targetLanguage]);
  useEffect(() => {
    if (confirmDelete && dialog.current && !dialog.current.open) dialog.current.showModal?.();
    if (!confirmDelete) deleteTrigger.current?.focus();
  }, [confirmDelete]);

  function invalidate() {
    testVersion.current += 1;
    testing.current = false;
    setTests((existing) => ({ ...existing, [selectedId]: { status: 'untested' } }));
    clear('ai');
  }
  function edit(patch: Partial<TranslationProfile>) {
    setDrafts((existing) =>
      existing.map((item) => {
        if (item.id !== selectedId) return item;
        // A manual capability belongs to this endpoint/model/protocol, never the next draft.
        const identityChanged = (['provider', 'protocol', 'apiUrl', 'model'] as const).some(
          (key) => patch[key] !== undefined && patch[key] !== item[key],
        );
        return { ...item, ...patch, ...(identityChanged ? { imageInputEnabled: false } : {}) };
      }),
    );
    setTouched((existing) => ({ ...existing, [selectedId]: {} }));
    invalidate();
  }
  function select(id: string) {
    invalidate();
    setSelectedId(id);
    setShowKey(false);
    setConfirmDelete(false);
  }
  function add() {
    const id = crypto.randomUUID();
    let number = drafts.length + 1;
    while (drafts.some((item) => item.name === t('配置 {{p0}}', { p0: number }))) number += 1;
    setDrafts((existing) => [
      ...existing,
      {
        ...DEFAULT_PROVIDER_OPTIONS,
        id,
        name: t('配置 {{p0}}', { p0: number }),
        apiUrl: '',
        apiKey: '',
        model: '',
        thinkingEnabled: false,
        imageInputEnabled: false,
        translationPrompt: DEFAULT_TRANSLATION_PROMPT,
      },
    ]);
    select(id);
  }
  function discard() {
    // Discard URL ownership together with its draft; saved custom URLs remain protected by value comparison.
    editedAddresses.current.delete(selectedId);
    if (persisted)
      setDrafts((existing) => existing.map((item) => (item.id === selectedId ? persisted : item)));
    else {
      setDrafts((existing) => existing.filter((item) => item.id !== selectedId));
      select(defaultProfileId);
    }
    setTouched((existing) => ({ ...existing, [selectedId]: {} }));
    invalidate();
  }
  function validate(): boolean {
    setTouched((existing) => ({ ...existing, [selectedId]: validation }));
    if (Object.keys(validation).length > 0) {
      const first = Object.keys(validation)[0];
      document.getElementById(`${idPrefix}-${first}`)?.focus();
      return false;
    }
    return Boolean(profile);
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!profile || busy || !validate()) return;
    const snapshot = normalizeTranslationProfile(profile);
    void save('ai', { type: 'SAVE_TRANSLATION_PROFILE', profile: snapshot }, (result) => {
      setDrafts((existing) =>
        existing.map((item) =>
          item.id === snapshot.id && sameProfile(item, profile) ? snapshot : item,
        ),
      );
      onSaved(snapshot, result);
    });
  }
  /** A revision binds a test result to its exact draft and target language, not just the selected tab. */
  async function testConnection() {
    if (testing.current || !profile || !validate()) return;
    const version = ++testVersion.current;
    const testedId = selectedId;
    testing.current = true;
    setTests((existing) => ({ ...existing, [testedId]: { status: 'testing' } }));
    const started = performance.now();
    try {
      const text = await testTranslatorConfiguration(profile, settings.targetLanguage);
      if (alive.current && version === testVersion.current)
        setTests((existing) => ({
          ...existing,
          [testedId]: { status: 'passed', text, latency: Math.round(performance.now() - started) },
        }));
    } catch (reason) {
      if (alive.current && version === testVersion.current)
        setTests((existing) => ({
          ...existing,
          [testedId]: { status: 'failed', message: getErrorMessage(reason) },
        }));
    } finally {
      if (version === testVersion.current) testing.current = false;
    }
  }
  function errorProps(field: keyof TranslationProfileValidationErrors) {
    return {
      id: `${idPrefix}-${field}`,
      'aria-invalid': Boolean(errors[field]),
      'aria-describedby': errors[field] ? `${idPrefix}-${field}-error` : undefined,
    };
  }
  function fieldError(field: keyof TranslationProfileValidationErrors) {
    return errors[field] ? (
      <small className="field-error" role="alert" id={`${idPrefix}-${field}-error`}>
        {renderMessage(errors[field])}
      </small>
    ) : null;
  }
  function blur(field: keyof TranslationProfileValidationErrors) {
    setTouched((existing) => ({
      ...existing,
      [selectedId]: { ...existing[selectedId], [field]: validation[field] },
    }));
  }

  if (!profile) return <p>{t('此配置已删除，请重新打开设置。')}</p>;
  return (
    <>
      {firstRun ? (
        <div className="onboarding">
          <span className="eyebrow">{t('开始使用')}</span>
          <h2>{t('连接你的第一个 AI')}</h2>
          <p>{t('填写接口和模型，测试连接后保存。也可以直接保存，稍后测试。')}</p>
          <ol>
            <li>
              <span>1</span>
              {t('填写配置')}
            </li>
            <li>
              <span>2</span>
              {t('测试连接')}
            </li>
            <li>
              <span>3</span>
              {t('保存并开始阅读')}
            </li>
          </ol>
        </div>
      ) : null}
      <div className="profile-header">
        <div className="profile-toolbar">
          <label className="profile-picker">
            <span>{t('正在编辑的配置')}</span>
            <select
              aria-label={t('正在编辑的配置')}
              value={selectedId}
              disabled={busy}
              onChange={(event) => select(event.target.value)}
            >
              {drafts.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name || t('未命名配置')}
                  {item.id === activeProfileId ? t(' · 当前使用') : ''}
                </option>
              ))}
            </select>
          </label>
          <button className="button" type="button" disabled={busy} onClick={add}>
            <Plus aria-hidden="true" />
            {t('新增配置')}
          </button>
        </div>
        <div className="profile-state">
          <span>
            {current ? (
              <>
                <Check aria-hidden="true" />
                {t('当前使用')}
              </>
            ) : (
              t('未启用')
            )}
            <span className="separator">·</span>
            {dirty ? t('未保存') : t('已保存')}
          </span>
          {!current ? (
            <button
              type="button"
              className="text-button"
              disabled={dirty || busy || Object.keys(validation).length > 0}
              onClick={() => {
                void save(
                  'ai',
                  {
                    type: 'SET_ACTIVE_TRANSLATOR',
                    translator: { kind: 'ai', profileId: selectedId },
                  },
                  onActivated,
                );
              }}
            >
              {t('设为当前使用')}
            </button>
          ) : null}
        </div>
      </div>
      <form onSubmit={submit} noValidate>
        <fieldset className="editor-section" aria-label={t('连接信息')}>
          <legend>{t('连接信息')}</legend>
          <p className="editor-section-description">{t('选择服务商，填写接口与模型。')}</p>
          <div className="form-section">
            <ProviderFields
              profile={profile}
              disabled={busy}
              onChange={edit}
              addressEdited={editedAddresses.current.has(selectedId)}
            />
            {fieldError('provider')}
            {fieldError('protocol')}
            <label className="field">
              <span>{t('配置名称')}</span>
              <input
                aria-label={t('配置名称')}
                dir="auto"
                {...errorProps('name')}
                value={profile.name}
                disabled={busy}
                onBlur={() => blur('name')}
                onChange={(event) => edit({ name: event.target.value })}
              />
              {fieldError('name')}
            </label>
            <label className="field">
              <span>{t('API 地址')}</span>
              <input
                aria-label={t('API 地址')}
                {...errorProps('apiUrl')}
                type="url"
                spellCheck={false}
                dir="ltr"
                placeholder="https://api.example.com/v1"
                value={profile.apiUrl}
                disabled={busy}
                onBlur={() => blur('apiUrl')}
                onChange={(event) => {
                  editedAddresses.current.add(selectedId);
                  edit({ apiUrl: event.target.value });
                }}
              />
              <small>{t('支持所选协议的基础地址或完整请求地址，保留自定义路径。')}</small>
              {fieldError('apiUrl')}
            </label>
            <div className="credential-grid">
              <label className="field">
                <span>API Key</span>
                <span className="secret-input">
                  <input
                    aria-label="API Key"
                    type={showKey ? 'text' : 'password'}
                    autoComplete="off"
                    spellCheck={false}
                    dir="ltr"
                    value={profile.apiKey}
                    placeholder={t('本地服务可留空')}
                    disabled={busy}
                    onChange={(event) => edit({ apiKey: event.target.value })}
                  />
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={showKey ? t('隐藏 API Key') : t('显示 API Key')}
                    onClick={() => setShowKey((value) => !value)}
                  >
                    {showKey ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
                  </button>
                </span>
              </label>
              <label className="field">
                <span>{t('模型')}</span>
                <input
                  aria-label={t('模型')}
                  list={`${idPrefix}-models`}
                  {...errorProps('model')}
                  value={profile.model}
                  spellCheck={false}
                  dir="ltr"
                  placeholder={t('服务商提供的模型名称')}
                  disabled={busy}
                  onBlur={() => blur('model')}
                  onChange={(event) => {
                    const capability = getModelCapability(
                      profile.provider,
                      event.target.value,
                      profile.protocol ?? 'openai',
                    );
                    edit({
                      model: event.target.value,
                      reasoningEffort: 'default',
                      ...(capability?.capability === 'always' ? { thinkingEnabled: true } : {}),
                    });
                  }}
                />
                <datalist id={`${idPrefix}-models`}>
                  <ModelSuggestions provider={profile.provider} />
                </datalist>
                {fieldError('model')}
              </label>
            </div>
          </div>
        </fieldset>
        <fieldset className="editor-section behavior-section" aria-label={t('模型行为')}>
          <legend>{t('模型行为')}</legend>
          <ImageInputFields profile={profile} disabled={busy} onChange={edit} />
          <ThinkingFields profile={profile} disabled={busy} onChange={edit} />
          {fieldError('thinkingControl')}
          <details className="prompt-details">
            <summary>
              {t('高级设置')}
              <span>{t('自定义翻译 Prompt')}</span>
            </summary>
            <div className="prompt-editor">
              <div className="prompt-heading">
                <label htmlFor={`${idPrefix}-translationPrompt`}>{t('翻译 Prompt')}</label>
                <button
                  type="button"
                  className="text-button"
                  disabled={busy}
                  onClick={() => edit({ translationPrompt: DEFAULT_TRANSLATION_PROMPT })}
                >
                  {t('恢复默认 Prompt')}
                </button>
              </div>
              <textarea
                aria-label={t('自定义翻译 Prompt')}
                {...errorProps('translationPrompt')}
                rows={6}
                maxLength={MAX_TRANSLATION_PROMPT_CHARACTERS}
                dir="auto"
                value={profile.translationPrompt}
                disabled={busy}
                onBlur={() => blur('translationPrompt')}
                onChange={(event) => edit({ translationPrompt: event.target.value })}
              />
              <div className="prompt-hint">
                <small>{t('用 {{p0}} 表示目标语言。', { p0: '{{targetLanguage}}' })}</small>
                <small>
                  {profile.translationPrompt.length} / {MAX_TRANSLATION_PROMPT_CHARACTERS}
                </small>
              </div>
              {fieldError('translationPrompt')}
            </div>
          </details>
        </fieldset>
        <div className="connection-check">
          <div
            className={`connection-result test-${state.status}`}
            role={state.status === 'failed' ? 'alert' : 'status'}
          >
            <div className="connection-heading">
              <span className="status-dot" />
              {state.status === 'testing'
                ? t('测试中')
                : state.status === 'passed'
                  ? t('测试通过')
                  : state.status === 'failed'
                    ? t('测试失败')
                    : t('未测试')}
              {state.status === 'passed' ? (
                <span className="latency">{state.latency} ms</span>
              ) : null}
            </div>
            {state.status === 'passed' ? (
              <>
                <p className="test-translation">{state.text}</p>
                <small>{t('接口响应有效，请根据测试译文确认翻译质量。')}</small>
              </>
            ) : state.status === 'failed' ? (
              <p>{renderMessage(state.message)}</p>
            ) : (
              <p>
                {state.status === 'testing'
                  ? t('正在请求你的 API…')
                  : t('测试会直接请求你的 API，不会保存或启用配置。')}
              </p>
            )}
          </div>
        </div>
        <div className="ai-actions">
          <div className="action-state" role="status">
            {dirty ? t('有未保存的修改') : feedback.ai ? null : t('配置已保存')}
            <SaveFeedback state={feedback.ai} />
          </div>
          <div className="action-buttons">
            <button className="button button-primary" type="submit" disabled={busy}>
              {busy ? <LoaderCircle className="spin" aria-hidden="true" /> : null}
              {t('保存配置')}
            </button>
            <button
              className="button"
              type="button"
              disabled={busy || state.status === 'testing'}
              onClick={() => void testConnection()}
            >
              {state.status === 'testing' ? t('测试中…') : t('测试连接')}
            </button>
            {dirty ? (
              <button className="text-button" type="button" disabled={busy} onClick={discard}>
                {t('放弃修改')}
              </button>
            ) : null}
          </div>
        </div>
      </form>
      <div className="configuration-footer">
        <p>{current ? t('当前正在使用此配置') : t('此配置尚未启用')}</p>
        <button
          ref={deleteTrigger}
          className="text-button danger-text"
          type="button"
          disabled={busy || current || drafts.length <= 1}
          onClick={() => setConfirmDelete(true)}
        >
          <Trash2 aria-hidden="true" />
          {t('删除配置')}
        </button>
        {current ? <small>{t('删除前请先启用其他配置。')}</small> : null}
      </div>
      {confirmDelete ? (
        <dialog
          ref={dialog}
          role="dialog"
          aria-labelledby={`${idPrefix}-delete-title`}
          onCancel={() => setConfirmDelete(false)}
        >
          <h2 id={`${idPrefix}-delete-title`}>{t('删除“{{p0}}”？', { p0: profile.name })}</h2>
          <p>{t('配置和未保存的修改会一并移除。')}</p>
          <div className="dialog-actions">
            <button className="button" disabled={busy} onClick={() => setConfirmDelete(false)}>
              {t('取消')}
            </button>
            <button
              className="button button-danger"
              disabled={busy}
              onClick={() => {
                if (!persisted) {
                  discard();
                  setConfirmDelete(false);
                  return;
                }
                void save(
                  'ai',
                  { type: 'DELETE_TRANSLATION_PROFILE', profileId: selectedId },
                  (result) => {
                    onDeleted(selectedId, result);
                    setDrafts((existing) => existing.filter((item) => item.id !== selectedId));
                    select(defaultProfileId);
                  },
                );
              }}
            >
              {t('确认删除')}
            </button>
          </div>
          <SaveFeedback state={feedback.ai} />
        </dialog>
      ) : null}
    </>
  );
}
