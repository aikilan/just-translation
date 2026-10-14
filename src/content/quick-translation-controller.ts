import { sendRuntimeMessage } from '../shared/chrome-api';
import { LocalizedError, message, type UiMessage } from '../shared/i18n';
import {
  getErrorMessage,
  isImageTranslationResult,
  isSliceTranslationResult,
  type PublicTranslatorSettings,
  type QuickTranslationProgress,
  type Result,
  type RuntimeRequest,
  type TextTranslationResult,
  type ImageTranslationResult,
} from '../shared/messages';
import { joinSlices, sliceText, type SlicedText, type TextSlice } from '../shared/text-slices';
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
  /** Translated text in reading order while slices are still arriving. */
  partial?: string;
  progress?: { done: number; total: number };
  /** Slices that kept their original wording; they can be retried on their own. */
  incomplete?: { failed: number; error: UiMessage };
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
  private active?: { requestId: string; slices?: readonly TextSlice[] };
  /** Slicing of the text behind the current result and the slices translated so far. */
  private sliced?: SlicedText;
  private translatedSlices = new Map<string, string>();
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
    if (this.state.image) {
      await this.translateImage();
      return;
    }
    const sliced = sliceText(this.state.source);
    this.sliced = sliced;
    this.translatedSlices = new Map();
    await this.translateSlices(sliced, sliced.slices);
  }

  /** Sends only the slices that still show their original wording. */
  async retryFailed(): Promise<void> {
    const sliced = this.sliced;
    if (this.active || !this.canTranslate || !sliced || !this.state.incomplete) return;
    const failed = sliced.slices.filter((slice) => !this.translatedSlices.has(slice.id));
    if (failed.length > 0) await this.translateSlices(sliced, failed);
  }

  /** Progress for the running request; slices of any other request are ignored. */
  receiveProgress(event: QuickTranslationProgress): void {
    const task = this.active;
    if (!task?.slices || event.requestId !== task.requestId || !this.sliced) return;
    const requested = new Set(task.slices.map((slice) => slice.id));
    for (const [id, text] of Object.entries(event.translations))
      if (requested.has(id)) this.translatedSlices.set(id, text);
    this.update(this.progressState(this.sliced));
  }

  private async translateSlices(
    sliced: SlicedText,
    requested: readonly TextSlice[],
  ): Promise<void> {
    const task = { requestId: String(++requestSequence), slices: requested };
    const { translator, targetLanguage } = this.state;
    this.active = task;
    this.clipboardRevision += 1;
    this.update({
      phase: 'loading',
      error: undefined,
      feedback: undefined,
      copying: false,
      incomplete: undefined,
      ...this.progressState(sliced),
    });
    let failure: UiMessage | undefined;
    let names: Pick<TextTranslationResult, 'targetLanguage' | 'translatorName'> | undefined;
    try {
      const result = await this.send({
        type: 'TRANSLATE_QUICK_TEXT',
        requestId: task.requestId,
        slices: [...requested],
        translator: translator!,
        targetLanguage,
      });
      if (this.active !== task || !this.state.open) return;
      if (!result.ok) throw new LocalizedError(result.error);
      if (!isSliceTranslationResult(result.data))
        throw new LocalizedError(message('后台未返回有效译文，请重试'));
      for (const slice of requested) {
        const translated = result.data.translations[slice.id];
        if (translated !== undefined) this.translatedSlices.set(slice.id, translated);
        else failure ??= result.data.failures[slice.id];
      }
      names = result.data;
    } catch (error) {
      if (this.active !== task || !this.state.open) return;
      failure = getErrorMessage(error);
    } finally {
      if (this.active === task) this.active = undefined;
    }
    this.settle(sliced, failure, names);
  }

  /** Any translated slice is a usable result; untranslated slices keep their original text. */
  private settle(
    sliced: SlicedText,
    failure: UiMessage | undefined,
    names: Pick<TextTranslationResult, 'targetLanguage' | 'translatorName'> | undefined,
  ): void {
    const failed = sliced.slices.filter((slice) => !this.translatedSlices.has(slice.id)).length;
    const error = failure ?? message('翻译通道未返回译文，请重试');
    const previous = this.state.result;
    if (this.translatedSlices.size === 0) {
      this.update({ phase: 'error', error, partial: undefined, progress: undefined });
      return;
    }
    this.update({
      phase: 'success',
      result: {
        text: joinSlices(sliced, (slice) => this.translatedSlices.get(slice.id)),
        targetLanguage:
          names?.targetLanguage ?? previous?.targetLanguage ?? this.state.targetLanguage,
        translatorName: names?.translatorName ?? previous?.translatorName ?? '',
      },
      partial: undefined,
      progress: undefined,
      incomplete: failed > 0 ? { failed, error } : undefined,
    });
  }

  /** Shows translations in reading order, stopping at the first slice still in flight. */
  private progressState(sliced: SlicedText): Pick<QuickTranslationState, 'partial' | 'progress'> {
    let partial = '';
    for (const part of sliced.parts) {
      if ('raw' in part) {
        partial += part.raw;
        continue;
      }
      const translated = this.translatedSlices.get(sliced.slices[part.slice].id);
      if (translated === undefined) break;
      partial += translated;
    }
    return {
      partial: partial.trim() ? partial : undefined,
      progress: { done: this.translatedSlices.size, total: sliced.slices.length },
    };
  }

  private async translateImage(): Promise<void> {
    const task = { requestId: String(++requestSequence) };
    const { source, image, translator, targetLanguage } = this.state;
    this.active = task;
    this.sliced = undefined;
    this.clipboardRevision += 1;
    this.update({
      phase: 'loading',
      result: undefined,
      error: undefined,
      feedback: undefined,
      copying: false,
      incomplete: undefined,
      partial: undefined,
      progress: undefined,
    });
    try {
      const result = await this.send({
        type: 'TRANSLATE_QUICK_IMAGE',
        image: image!,
        requestId: task.requestId,
        text: source,
        translator: translator!,
        targetLanguage,
      });
      if (this.active !== task || !this.state.open) return;
      if (!result.ok) throw new LocalizedError(result.error);
      if (!isImageTranslationResult(result.data))
        throw new LocalizedError(message('后台未返回有效译文，请重试'));
      this.update({ phase: 'success', result: result.data });
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
    // Slices finished before stopping stay usable, exactly like a partially failed request.
    if (task.slices && this.sliced && this.translatedSlices.size > 0)
      this.settle(this.sliced, message('翻译已停止'), undefined);
    else this.update({ phase: 'idle', error: undefined, partial: undefined, progress: undefined });
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
    this.sliced = undefined;
    this.translatedSlices = new Map();
    this.update({
      phase: 'idle',
      result: undefined,
      partial: undefined,
      progress: undefined,
      incomplete: undefined,
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
