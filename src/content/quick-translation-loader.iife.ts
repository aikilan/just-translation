import type * as QuickTranslationEntry from './quick-translation-entry';
import type { Result } from '../shared/messages';

declare global {
  interface Window {
    __justTranslateOpenQuickTranslation: (moduleUrl: string) => Promise<Result<void>>;
  }
}

// CRX builds this tiny loader as an IIFE. Its native import keeps all runtime dependencies
// in the injected file; Vite's popup preload helpers cannot leak into a serialized function.
// This property belongs to the extension's isolated world, not the webpage's Window.
window.__justTranslateOpenQuickTranslation = async (moduleUrl) => {
  let retired = false;
  const onPageHide = () => {
    retired = true;
  };
  window.addEventListener('pagehide', onPageHide, { once: true });
  try {
    const entry = (await import(/* @vite-ignore */ moduleUrl)) as typeof QuickTranslationEntry;
    if (retired) return { ok: false, error: { key: '当前网页已变化，请重新打开翻译' } };
    return entry.openQuickTranslation();
  } catch (error) {
    return { ok: false, error: { text: error instanceof Error ? error.message : String(error) } };
  } finally {
    window.removeEventListener('pagehide', onPageHide);
  }
};
