/* global self */
import { TranslationTaskService } from '../../src/background/translation-task.ts';
import { toPublicSettings } from '../../src/background/configuration-service.ts';
import { DEFAULT_SETTINGS } from '../../src/shared/settings.ts';
import { setUiLanguage, toUiMessage } from '../../src/shared/i18n.ts';

setUiLanguage('zh-CN');
const profile = {
  ...DEFAULT_SETTINGS.profiles[0],
  provider: 'custom',
  protocol: 'openai',
  model: 'fixture-vision',
  apiKey: '',
  apiUrl: `${self.location.origin}/image-api`,
  imageInputEnabled: true,
};
const settings = {
  ...DEFAULT_SETTINGS,
  profiles: [
    { ...profile, id: 'openai', name: 'OpenAI 图片验收' },
    { ...profile, id: 'anthropic', name: 'Anthropic 图片验收', protocol: 'anthropic' },
    { ...profile, id: 'text', name: '仅文字模型', imageInputEnabled: false },
    { ...profile, id: 'empty', name: '无文字结果', model: 'fixture-empty' },
    { ...profile, id: 'slow', name: '取消请求验收', model: 'fixture-slow' },
    { ...profile, id: 'error', name: '错误响应验收', model: 'fixture-error' },
  ],
  activeTranslator: { kind: 'ai', profileId: 'openai' },
};
const sender = { tab: { id: 1 }, frameId: 0, documentId: 'fixture', url: self.location.origin };
const service = new TranslationTaskService(
  () => Promise.resolve(settings),
  () => Promise.resolve({ documentId: 'fixture' }),
);
// JSON serialization intentionally matches Chrome runtime messages; image bytes are decoded again here.
self.onmessage = async ({ data: wire }) => {
  const { id, request } = JSON.parse(wire);
  try {
    let data;
    if (request.type === 'GET_PUBLIC_SETTINGS') data = toPublicSettings(settings);
    else if (request.type === 'CANCEL_QUICK_TRANSLATION')
      service.cancel(sender, request.requestId, 'quick');
    else if (request.type === 'TRANSLATE_QUICK_IMAGE')
      data = await service.translateQuickImage(
        sender,
        request.requestId,
        request.text,
        request.image,
        request.translator,
        request.targetLanguage,
      );
    else throw new Error('This fixture accepts image tasks only');
    self.postMessage(JSON.stringify({ id, result: { ok: true, data } }));
  } catch (error) {
    self.postMessage(JSON.stringify({ id, result: { ok: false, error: toUiMessage(error) } }));
  }
};
