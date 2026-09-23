import { t } from '../shared/i18n';
import type { PublicTranslationProfile } from '../shared/messages';
import {
  activeTranslatorKey,
  builtinTranslatorLabel,
  parseActiveTranslatorKey,
  type ActiveTranslator,
} from '../shared/translation-engines';

interface Props {
  activeTranslator: ActiveTranslator;
  profiles: PublicTranslationProfile[];
  disabled?: boolean;
  onChange: (translator: ActiveTranslator) => void;
}

/** Keeps built-in channels and user-owned AI profiles explicit in one public selector. */
export function TranslatorSelect({ activeTranslator, profiles, disabled, onChange }: Props) {
  return (
    <select
      aria-label={t('翻译引擎')}
      value={activeTranslatorKey(activeTranslator)}
      disabled={disabled}
      onChange={(event) => {
        const translator = parseActiveTranslatorKey(event.target.value);
        if (translator) onChange(translator);
      }}
    >
      {activeTranslator.kind === 'ai' &&
      !profiles.some((profile) => profile.id === activeTranslator.profileId) ? (
        // A retained draft must not visually select a different recipient after profile deletion.
        <option value={activeTranslatorKey(activeTranslator)} disabled>
          {t('当前翻译配置不存在')}
        </option>
      ) : null}
      <option value="builtin:google-free">{builtinTranslatorLabel('google-free')}</option>
      <option value="builtin:microsoft-free">{builtinTranslatorLabel('microsoft-free')}</option>
      {profiles.map((profile) => (
        <option key={profile.id} value={`ai:${profile.id}`} disabled={!profile.configured}>
          {profile.name}
          {profile.configured ? '' : t('（待配置）')}
        </option>
      ))}
    </select>
  );
}

/** The selected recipient is repeated next to the control before any webpage text is sent. */
export function TranslatorDisclosure({ translator }: { translator: ActiveTranslator }) {
  if (translator.kind === 'ai') return <small>{t('网页文本会发送到你配置的 AI 服务。')}</small>;
  const service = translator.engine === 'google-free' ? 'Google' : 'Microsoft';
  return (
    <small>
      {t('网页文本会发送给 {{p0}}；这是非官方免费通道，可用性不受保证。', { p0: service })}
    </small>
  );
}
