import { useRef } from 'react';
import { ImagePlus, LoaderCircle, X } from 'lucide-react';
import { imageDataUrl } from '../shared/image-input';
import { renderMessage, t } from '../shared/i18n';
import type {
  QuickTranslationController,
  QuickTranslationState,
} from './quick-translation-controller';

/** The attachment remains in this document's draft; picking a file never submits it. */
export function QuickImageInput({
  model,
  state,
}: {
  model: QuickTranslationController;
  state: QuickTranslationState;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const disabled = state.phase === 'loading' || state.settingsLoading;
  const supported = model.supportsImageInput;
  return (
    <div className="quick-image-input">
      {state.image ? (
        <div className="quick-attachment">
          <img src={imageDataUrl(state.image)} alt={t('待翻译图片预览')} />
          <small>
            {state.image.width} × {state.image.height}
          </small>
          <button
            className="icon-button"
            type="button"
            disabled={disabled}
            aria-label={t('移除图片')}
            onClick={() => model.removeImage()}
          >
            <X aria-hidden="true" />
          </button>
        </div>
      ) : null}
      {supported ? (
        <>
          <input
            ref={picker}
            type="file"
            hidden
            accept="image/png,image/jpeg,image/webp"
            aria-label={t('选择图片')}
            disabled={disabled}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void model.setImage(file);
            }}
          />
          <button
            className="text-button"
            type="button"
            disabled={disabled}
            onClick={() => picker.current?.click()}
          >
            <ImagePlus aria-hidden="true" />
            {state.image ? t('更换图片') : t('上传图片')}
          </button>
          <small className="quick-image-hint">
            {t('单张 PNG、JPEG 或 WebP，最大 4 MiB；点击翻译后发送。')}
          </small>
        </>
      ) : state.image ? (
        <p className="field-error" role="alert">
          {t('当前模型不支持图片，请移除图片或更换模型')}
        </p>
      ) : null}
      {state.imageLoading ? (
        <div className="quick-pending" role="status">
          <LoaderCircle className="spin" aria-hidden="true" />
          {t('正在读取图片…')}
        </div>
      ) : null}
      {state.imageError ? (
        <p className="field-error" role="alert">
          {renderMessage(state.imageError)}
        </p>
      ) : null}
    </div>
  );
}
