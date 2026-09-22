import { message, LocalizedError } from './i18n';
import type { TranslationSegment } from './batching';

const CONNECTION_TEST_UNIT_ID = 'connection';

/** Uses a source language different from the target so an obvious echo can be rejected. */
export function createConnectionTestSegment(targetLanguage: string): TranslationSegment {
  const targetIsEnglish = /(^|\b)english\b|英语|英文/iu.test(targetLanguage.trim());
  return {
    requestId: `${CONNECTION_TEST_UNIT_ID}:0`,
    unitId: CONNECTION_TEST_UNIT_ID,
    partIndex: 0,
    text: targetIsEnglish ? '早上好。' : 'Good morning.',
  };
}

/** Rejects empty and echo responses; arbitrary target-language correctness remains user-visible. */
export function assertConnectionTestTranslation(sourceText: string, translatedText: string): void {
  if (!translatedText.trim()) {
    throw new LocalizedError(message('API 已连接，但模型未返回译文'));
  }
  if (canonicalize(sourceText) === canonicalize(translatedText)) {
    throw new LocalizedError(message('API 已连接，但模型原样返回了测试文本，无法确认翻译能力'));
  }
}

function canonicalize(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}\s]/gu, '');
}
