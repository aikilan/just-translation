import { createInstance } from 'i18next';
import { resources, UI_LOCALES, type UiLanguage, type UiLocale, type MessageKey } from './locales';
export type { UiLanguage, UiLocale, MessageKey } from './locales';

type Placeholders<S extends string> = S extends `${string}{{${infer P}}}${infer Rest}`
  ? P | Placeholders<Rest>
  : never;
type Params<K extends MessageKey> = Record<
  Placeholders<(typeof resources)['zh-CN'][K]>,
  string | number | UiMessage
>;
type Arguments<K extends MessageKey> = [Placeholders<(typeof resources)['zh-CN'][K]>] extends [
  never,
]
  ? [params?: never]
  : [params: Params<K>];
/** JSON-safe display data. External diagnostics remain separate from product-owned messages. */
export type UiMessage =
  { key: MessageKey; params?: Record<string, string | number | UiMessage> } | { text: string };

export function isUiLanguage(value: unknown): value is UiLanguage {
  return value === 'system' || UI_LOCALES.some((locale) => locale === value);
}
export function browserUiLanguage(): string {
  return globalThis.chrome?.i18n?.getUILanguage() ?? globalThis.navigator?.language ?? 'en';
}
/** Chinese variants share the simplified catalog; other supported regional variants share their base. */
export function resolveUiLocale(preference: UiLanguage, browser = browserUiLanguage()): UiLocale {
  if (preference !== 'system') return preference;
  const base = browser.replaceAll('_', '-').toLowerCase().split('-')[0];
  return base === 'zh' ? 'zh-CN' : base === 'fr' || base === 'de' || base === 'ar' ? base : 'en';
}
export const i18n = createInstance();
void i18n.init({
  lng: resolveUiLocale('system'),
  resources: Object.fromEntries(
    UI_LOCALES.map((locale) => [locale, { translation: resources[locale] }]),
  ),
  initAsync: false,
  fallbackLng: false,
  keySeparator: false,
  nsSeparator: false,
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});
export function getUiLocale(): UiLocale {
  return i18n.language as UiLocale;
}
/** Bundled resources make switching synchronous, with no network request or translation API call. */
export function setUiLanguage(preference: UiLanguage): void {
  const locale = resolveUiLocale(preference);
  if (locale !== getUiLocale()) void i18n.changeLanguage(locale);
}
export function subscribeUiLanguage(listener: () => void): () => void {
  i18n.on('languageChanged', listener);
  return () => {
    i18n.off('languageChanged', listener);
  };
}
export function message<K extends MessageKey>(key: K, ...args: Arguments<K>): UiMessage {
  return { key, ...(args[0] ? { params: args[0] } : {}) };
}
/** Only the display boundary resolves message keys, so already-visible failures can change language. */
export function renderMessage(value: UiMessage | undefined | ''): string {
  if (!value) return '';
  if ('text' in value) return value.text;
  const params = Object.fromEntries(
    Object.entries(value.params ?? {}).map(([key, item]) => {
      const rendered = typeof item === 'object' ? renderMessage(item) : item;
      // Isolate mixed-script insertions without changing raw diagnostics or numeric plural operands.
      return [
        key,
        getUiLocale() === 'ar' && typeof rendered === 'string'
          ? `\u2068${rendered}\u2069`
          : rendered,
      ];
    }),
  );
  return String(i18n.t(value.key, params));
}
export function t<K extends MessageKey>(key: K, ...args: Arguments<K>): string {
  return renderMessage(message(key, ...args));
}
/** Keeps native Error stacks while preserving translatable metadata across runtime boundaries. */
export class LocalizedError extends Error {
  readonly uiMessage: UiMessage;
  constructor(value: UiMessage | string) {
    const uiMessage = typeof value === 'string' ? { text: value } : value;
    super(renderMessage(uiMessage));
    this.uiMessage = uiMessage;
  }
}
export function toUiMessage(error: unknown): UiMessage {
  return error instanceof LocalizedError
    ? error.uiMessage
    : error instanceof Error
      ? { text: error.message }
      : message('发生未知错误');
}

/** Validates the new wire format; strings from older extension builds are deliberately rejected. */
export function isUiMessage(value: unknown, depth = 0): value is UiMessage {
  if (depth > 8 || !value || typeof value !== 'object') return false;
  if ('text' in value) return typeof value.text === 'string';
  if (
    !('key' in value) ||
    typeof value.key !== 'string' ||
    !Object.hasOwn(resources['zh-CN'], value.key)
  )
    return false;
  if (!('params' in value) || value.params === undefined) return true;
  return Boolean(
    value.params &&
    typeof value.params === 'object' &&
    !Array.isArray(value.params) &&
    Object.values(value.params).every(
      (item) =>
        typeof item === 'string' || typeof item === 'number' || isUiMessage(item, depth + 1),
    ),
  );
}
