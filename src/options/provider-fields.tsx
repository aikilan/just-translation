import { t } from '../shared/i18n';
import { useId } from 'react';
import type { TranslationProfile } from '../shared/settings';
import {
  PROVIDERS,
  MODELS,
  allowedThinkingControls,
  getModelCapability,
  resolveProviderOptions,
  type ApiProtocol,
  type ProviderId,
  type ThinkingControl,
  type ReasoningEffort,
} from '../shared/providers';
import { SettingRow, Switch } from '../ui/controls';

interface Props {
  profile: TranslationProfile;
  disabled: boolean;
  onChange: (patch: Partial<TranslationProfile>) => void;
}
/** Provider/protocol selection only changes the draft; no endpoint probing or secret transmission. */
export function ProviderFields({
  profile,
  disabled,
  onChange,
  addressEdited,
}: Props & { addressEdited: boolean }) {
  const definition = PROVIDERS.find((p) => p.id === profile.provider);
  const change = (provider: ProviderId, protocol: ApiProtocol) => {
    const previous = profile.protocol ? definition?.endpoints[profile.protocol] : undefined;
    const next = PROVIDERS.find((p) => p.id === provider)?.endpoints[protocol] ?? '';
    const replaceAddress = !addressEdited && (!profile.apiUrl || profile.apiUrl === previous);
    const changed = profile.provider !== null && profile.provider !== provider;
    const mandatory =
      getModelCapability(provider, changed ? '' : profile.model, protocol)?.capability === 'always';
    onChange({
      provider,
      protocol,
      ...(replaceAddress ? { apiUrl: next } : {}),
      ...(changed ? { apiKey: '', model: '', thinkingEnabled: false } : {}),
      ...(mandatory ? { thinkingEnabled: true } : {}),
      thinkingControl: 'auto',
      reasoningEffort: 'default',
    });
  };
  return (
    <>
      <div className="credential-grid">
        <label className="field">
          <span>{t('供应商')}</span>
          <select
            aria-label={t('供应商')}
            value={profile.provider ?? ''}
            disabled={disabled}
            onChange={(e) => change(e.target.value as ProviderId, profile.protocol ?? 'openai')}
          >
            <option value="" disabled>
              {t('请选择供应商')}
            </option>
            {PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.id === 'kimi'
                  ? t('月之暗面 Kimi')
                  : p.id === 'glm'
                    ? t('智谱 GLM')
                    : p.id === 'mimo'
                      ? t('小米 MiMo')
                      : p.id === 'qwen'
                        ? t('阿里云 Qwen')
                        : p.id === 'custom'
                          ? t('自定义供应商')
                          : p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t('接入协议')}</span>
          <select
            aria-label={t('接入协议')}
            value={profile.protocol ?? ''}
            disabled={disabled || !profile.provider}
            onChange={(e) => change(profile.provider!, e.target.value as ApiProtocol)}
          >
            <option value="" disabled>
              {t('请选择接入协议')}
            </option>
            <option value="openai">OpenAI Chat Completions</option>
            <option value="anthropic">Anthropic Messages</option>
          </select>
        </label>
      </div>
      {!profile.provider || !profile.protocol ? (
        <p className="field-error">{t('待补全供应商与协议，保存后才能翻译。')}</p>
      ) : !definition?.endpoints[profile.protocol] ? (
        <p>{t('此组合未提供可用的官方接口，请填写兼容此协议的中转地址。')}</p>
      ) : null}
    </>
  );
}
export function ModelSuggestions({ provider }: { provider: ProviderId | null }) {
  return (
    <>
      {MODELS.filter((m) => m.provider === provider).map((m) => (
        <option value={m.id} key={m.id} />
      ))}
    </>
  );
}
const controlLabels = (): Record<ThinkingControl, string> => ({
  auto: t('自动识别'),
  default: t('接口默认（不发送思考参数）'),
  thinking: 'thinking.type',
  reasoning_effort: 'reasoning_effort',
  enable_thinking: 'enable_thinking',
  'anthropic-adaptive': t('Anthropic 自适应 thinking.type'),
  'anthropic-budget': t('Anthropic 预算 thinking.budget_tokens'),
});
/** Presentation uses valid neutral values so invalid numeric drafts remain editable and visible. */
export function ThinkingFields({ profile, disabled, onChange }: Props) {
  const id = useId();
  const invalidControl = !allowedThinkingControls(profile.protocol).includes(
    profile.thinkingControl,
  );
  const resolved = resolveProviderOptions({
    ...profile,
    thinkingControl: invalidControl ? 'default' : profile.thinkingControl,
    provider: profile.provider ?? 'custom',
    protocol: profile.protocol ?? 'openai',
    thinkingEnabled: true,
    reasoningEffort: 'default',
    thinkingBudgetTokens: 2048,
    maxOutputTokens: null,
  });
  const unavailable = resolved.capability === 'none' || resolved.capability === 'unknown';
  const description =
    resolved.capability === 'always'
      ? t('此模型始终开启思考，无法关闭。')
      : resolved.capability === 'none'
        ? t('此模型不支持思考。')
        : resolved.capability === 'unknown'
          ? t('思考能力未识别或选择了接口默认；可在高级设置手动指定参数方式。')
          : t('开启思考翻译时间较慢');
  const active = profile.thinkingEnabled && !unavailable;
  return (
    <>
      <SettingRow label={t('开启思考')} description={description}>
        <Switch
          label={t('开启思考')}
          checked={resolved.capability === 'always' || (!unavailable && profile.thinkingEnabled)}
          disabled={disabled || !profile.provider || resolved.capability !== 'toggle'}
          onChange={(thinkingEnabled) => onChange({ thinkingEnabled })}
        />
      </SettingRow>
      {resolved.efforts.length > 0 ? (
        <label className="field">
          <span>{t('思考强度')}</span>
          <select
            aria-label={t('思考强度')}
            disabled={disabled || !active}
            value={profile.reasoningEffort}
            onChange={(e) => onChange({ reasoningEffort: e.target.value as ReasoningEffort })}
          >
            <option value="default">{t('服务商默认')}</option>
            {resolved.efforts.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <details className="prompt-details">
        <summary>{t('思考与输出高级设置')}</summary>
        <div className="prompt-editor">
          <label className="field">
            <span>{t('思考控制方式')}</span>
            <select
              aria-label={t('思考控制方式')}
              disabled={disabled || !profile.protocol}
              value={profile.thinkingControl}
              onChange={(e) => {
                const thinkingControl = e.target.value as ThinkingControl;
                // Returning to automatic control must persist the same mandatory state the switch displays.
                const mandatory =
                  thinkingControl === 'auto' &&
                  profile.provider &&
                  profile.protocol &&
                  getModelCapability(profile.provider, profile.model, profile.protocol)
                    ?.capability === 'always';
                onChange({
                  thinkingControl,
                  reasoningEffort: 'default',
                  ...(mandatory ? { thinkingEnabled: true } : {}),
                });
              }}
            >
              {invalidControl ? (
                <option value={profile.thinkingControl} disabled>
                  {t('此方式不适用当前协议，请重新选择')}
                </option>
              ) : null}
              {allowedThinkingControls(profile.protocol).map((c) => (
                <option value={c} key={c}>
                  {controlLabels()[c]}
                </option>
              ))}
            </select>
            <small>{t('手动方式用于新模型和中转别名；由接口验证参数支持情况，不自动降级。')}</small>
          </label>
          {resolved.control === 'anthropic-budget' ? (
            <label className="field">
              <span>{t('思考预算（tokens）')}</span>
              <input
                id={`${id}-budget`}
                aria-label={t('思考预算')}
                type="number"
                min={1024}
                step={1}
                value={profile.thinkingBudgetTokens}
                disabled={disabled || !active}
                onChange={(e) => onChange({ thinkingBudgetTokens: Number(e.target.value) })}
              />
              <small>{t('至少 1024，必须小于实际输出上限。')}</small>
            </label>
          ) : null}
          <label className="field">
            <span>{t('输出上限（tokens）')}</span>
            <input
              aria-label={t('输出上限')}
              type="number"
              min={1}
              step={1}
              placeholder={t('使用默认上限')}
              value={profile.maxOutputTokens ?? ''}
              disabled={disabled}
              onChange={(e) =>
                onChange({ maxOutputTokens: e.target.value === '' ? null : Number(e.target.value) })
              }
            />
            <small>
              {t('Anthropic 默认：普通翻译 8192，全文最高 65536，受模型上限约束；未知模型 8192。')}
            </small>
          </label>
        </div>
      </details>
    </>
  );
}
