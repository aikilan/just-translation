import { sendRuntimeMessage } from '../shared/chrome-api';
import { LocalizedError, message, type UiMessage } from '../shared/i18n';
import {
  getErrorMessage,
  isTextTranslationResult,
  isImageTranslationResult,
  type PublicTranslatorSettings,
  type Result,
  type RuntimeRequest,
  type TextTranslationResult,
  type ImageTranslationResult,
} from '../shared/messages';
import { prepareImageInput, type ImageInput } from '../shared/image-input';
import {
  activeTranslatorEquals,
  isActiveTranslator,
  resolveBuiltinTargetLanguage,
  type ActiveTranslator,
} from '../shared/translation-engines';

type Sender = (request: RuntimeRequest) => Promise<Result<unknown>>;
// The background scopes IDs by document and feature. Share a sequence across controller instances
// in this content-script module so HTTP pages need no secure-context API to identify requests.
let requestSequence = 0;
type QuickSettings = Pick<
  PublicTranslatorSettings,
  'profiles' | 'activeTranslator' | 'targetLanguage'
>;
export interface QuickTranslationState {
  open: boolean;
  source: string;
  targetLanguage: string;
  translator?: ActiveTranslator;
  settings?: QuickSettings;
  settingsLoading: boolean;
  settingsError?: UiMessage;
  phase: 'idle' | 'loading' | 'success' | 'error';
  result?: TextTranslationResult | ImageTranslationResult;
  image?: ImageInput;
  imageLoading: boolean;
  imageError?: UiMessage;
  error?: UiMessage;
  pasting: boolean;
  copying: boolean;
  feedback?: UiMessage;
}

/** One document-local draft; request and clipboard identities retire all late completions. */
export class QuickTranslationController {
  private state: QuickTranslationState = {
    open: false,
    source: '',
    targetLanguage: '',
    settingsLoading: false,
    phase: 'idle',
    imageLoading: false,
    pasting: false,
    copying: false,
  };
  private readonly listeners = new Set<() => void>();
  private active?: { requestId: string };
  private settingsRevision = 0;
  private clipboardRevision = 0;
  private imageRevision = 0;

  constructor(
    private readonly send: Sender = sendRuntimeMessage,
    private readonly clipboard: Pick<Clipboard, 'readText' | 'writeText'> = {
      readText: () => navigator.clipboard.readText(),
      writeText: (text) => navigator.clipboard.writeText(text),
    },
    private readonly prepareImage: (file: Blob) => Promise<ImageInput> = prepareImageInput,
  ) {}

  getSnapshot = (): QuickTranslationState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  get canTranslate(): boolean {
    const {
      source,
      image,
      imageLoading,
      translator,
      targetLanguage,
      settings,
      settingsLoading,
      pasting,
      open,
    } = this.state;
    if (
      !open ||
      (!source.trim() && !image) ||
      imageLoading ||
      !translator ||
      !settings ||
      settingsLoading ||
      pasting ||
      (image && !this.supportsImageInput)
    )
      return false;
    return translator.kind === 'builtin'
      ? Boolean(resolveBuiltinTargetLanguage(translator.engine, targetLanguage))
      : Boolean(
          targetLanguage.trim() &&
          settings.profiles.some(
            (profile) => profile.id === translator.profileId && profile.configured,
          ),
        );
  }

  get supportsImageInput(): boolean {
    const { translator, settings } = this.state;
    return (
      translator?.kind === 'ai' &&
      Boolean(
        settings?.profiles.some(
          (profile) =>
            profile.id === translator.profileId && profile.configured && profile.supportsImageInput,
        ),
      )
    );
  }

  async open(): Promise<void> {
    if (this.state.open) return;
    this.update({ open: true, feedback: undefined });
    await this.reloadSettings();
  }

  /** Refresh only the available profiles after reopening; keep the user's existing draft choices. */
  async reloadSettings(): Promise<void> {
    if (!this.state.open) return;
    const revision = ++this.settingsRevision;
    this.update({ settingsLoading: true, settingsError: undefined });
    try {
      const result = await this.send({ type: 'GET_PUBLIC_SETTINGS' });
      if (revision !== this.settingsRevision || !this.state.open) return;
      if (!result.ok) throw new LocalizedError(result.error);
      if (!isQuickSettings(result.data)) throw new LocalizedError(message('无法读取插件状态'));
      this.update({
        settings: result.data,
        ...(!this.state.translator
          ? {
              translator: result.data.activeTranslator,
              targetLanguage: result.data.targetLanguage,
            }
          : {}),
      });
    } catch (error) {
      if (revision === this.settingsRevision && this.state.open)
        this.update({ settingsError: getErrorMessage(error) });
    } finally {
      if (revision === this.settingsRevision && this.state.open)
        this.update({ settingsLoading: false });
    }
  }

  close(): void {
    this.settingsRevision += 1;
    this.clipboardRevision += 1;
    this.imageRevision += 1;
    this.stop();
    this.update({
      open: false,
      settingsLoading: false,
      pasting: false,
      copying: false,
      imageLoading: false,
      feedback: undefined,
    });
  }

  setSource(source: string): void {
    if (source === this.state.source) return;
    this.invalidateResult();
    this.update({ source });
  }
  setTargetLanguage(targetLanguage: string): void {
    if (targetLanguage === this.state.targetLanguage) return;
    this.invalidateResult();
    this.update({ targetLanguage });
  }
  setTranslator(translator: ActiveTranslator): void {
    if (this.state.translator && activeTranslatorEquals(translator, this.state.translator)) return;
    this.invalidateResult();
    this.imageRevision += 1;
    this.update({ translator, imageLoading: false });
  }

  /** Decode and preview locally. Only translate() can send the prepared bytes to the background. */
  async setImage(file: Blob): Promise<void> {
    if (!this.state.open || !this.supportsImageInput || this.active) return;
    this.invalidateResult();
    const revision = ++this.imageRevision;
    this.update({ image: undefined, imageLoading: true, imageError: undefined });
    try {
      const image = await this.prepareImage(file);
      if (revision === this.imageRevision && this.state.open) this.update({ image });
    } catch (error) {
      if (revision === this.imageRevision && this.state.open)
        this.update({ imageError: getErrorMessage(error) });
    } finally {
      if (revision === this.imageRevision && this.state.open) this.update({ imageLoading: false });
    }
  }

  removeImage(): void {
    this.imageRevision += 1;
    this.invalidateResult();
    this.update({ image: undefined, imageLoading: false, imageError: undefined });
  }

  /** Lock before the first await; this task never starts or stops a page-translation session. */
  async translate(): Promise<void> {
    if (this.active || !this.canTranslate) return;
    const task = { requestId: String(++requestSequence) };
    const { source, image, translator, targetLanguage } = this.state;
    this.active = task;
    this.clipboardRevision += 1;
    this.update({
      phase: 'loading',
      result: undefined,
      error: undefined,
      feedback: undefined,
      copying: false,
    });
    try {
      const result = await this.send({
        ...(image
          ? ({ type: 'TRANSLATE_QUICK_IMAGE', image } as const)
          : ({ type: 'TRANSLATE_QUICK_TEXT' } as const)),
        requestId: task.requestId,
        text: source,
        translator: translator!,
        targetLanguage,
      });
      if (this.active !== task || !this.state.open) return;
      if (!result.ok) throw new LocalizedError(result.error);
      const data = result.data;
      if (image) {
        if (!isImageTranslationResult(data))
          throw new LocalizedError(message('后台未返回有效译文，请重试'));
      } else if (!isTextTranslationResult(data)) {
        throw new LocalizedError(message('后台未返回有效译文，请重试'));
      }
      this.update({ phase: 'success', result: data });
    } catch (error) {
      if (this.active === task && this.state.open)
        this.update({ phase: 'error', error: getErrorMessage(error) });
    } finally {
      if (this.active === task) this.active = undefined;
    }
  }

  stop(): void {
    const task = this.active;
    if (!task) return;
    this.active = undefined;
    this.update({ phase: 'idle', error: undefined });
    void this.send({ type: 'CANCEL_QUICK_TRANSLATION', requestId: task.requestId }).catch(() => {});
  }

  async paste(): Promise<void> {
    if (!this.state.open || this.state.pasting || this.state.copying || this.active) return;
    const revision = ++this.clipboardRevision;
    this.update({ pasting: true, feedback: undefined });
    try {
      const source = await this.clipboard.readText();
      if (revision !== this.clipboardRevision || !this.state.open) return;
      if (!source) this.update({ feedback: message('剪贴板中没有文字') });
      else this.setSource(source);
    } catch {
      if (revision === this.clipboardRevision && this.state.open)
        this.update({ feedback: message('无法读取剪贴板，请在输入框中手动粘贴。') });
    } finally {
      if (revision === this.clipboardRevision) this.update({ pasting: false });
    }
  }

  async copy(): Promise<void> {
    const result = this.state.result;
    if (!this.state.open || !result?.text || this.state.copying || this.state.pasting) return;
    const revision = ++this.clipboardRevision;
    this.update({ copying: true, feedback: undefined });
    try {
      await this.clipboard.writeText(result.text);
      if (revision === this.clipboardRevision && this.state.open)
        this.update({ feedback: message('已复制译文') });
    } catch {
      if (revision === this.clipboardRevision && this.state.open)
        this.update({ feedback: message('复制失败，请手动选择复制译文') });
    } finally {
      if (revision === this.clipboardRevision) this.update({ copying: false });
    }
  }

  private invalidateResult(): void {
    this.stop();
    this.clipboardRevision += 1;
    this.update({
      phase: 'idle',
      result: undefined,
      error: undefined,
      feedback: undefined,
      pasting: false,
      copying: false,
    });
  }
  private update(patch: Partial<QuickTranslationState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}

function isQuickSettings(value: unknown): value is QuickSettings {
  return (
    typeof value === 'object' &&
    value !== null &&
    'activeTranslator' in value &&
    isActiveTranslator(value.activeTranslator) &&
    'targetLanguage' in value &&
    typeof value.targetLanguage === 'string' &&
    'profiles' in value &&
    Array.isArray(value.profiles) &&
    value.profiles.every(
      (profile: unknown) =>
        typeof profile === 'object' &&
        profile !== null &&
        'id' in profile &&
        typeof profile.id === 'string' &&
        'name' in profile &&
        typeof profile.name === 'string' &&
        'configured' in profile &&
        typeof profile.configured === 'boolean' &&
        'supportsImageInput' in profile &&
        typeof profile.supportsImageInput === 'boolean',
    )
  );
}
