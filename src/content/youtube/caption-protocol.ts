/** Shared by the page-world caption hook and the isolated content script; keep it dependency-free. */
export const CAPTION_EVENT = 'justtranslate-youtube-captions';
export const CAPTION_REPLAY_EVENT = 'justtranslate-youtube-captions-replay';
export const MAX_CAPTION_BODY_LENGTH = 4 * 1024 * 1024;

export function isTimedTextUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      (parsed.hostname === 'youtube.com' || parsed.hostname.endsWith('.youtube.com')) &&
      parsed.pathname === '/api/timedtext'
    );
  } catch {
    return false;
  }
}
