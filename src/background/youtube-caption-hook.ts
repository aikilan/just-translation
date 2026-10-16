import captionHookScript from '../content/youtube/caption-hook.iife.ts?script&iife';

export const YOUTUBE_CAPTION_HOOK_ID = 'youtube-caption-hook';

/**
 * The YouTube player requests captions with its own tokens. Reading those responses needs a
 * page-world script, which the manifest cannot declare through the bundler, so the worker keeps
 * one registered: on youtube.com only, before page scripts run, in the top frame.
 */
export async function registerYouTubeCaptionHook(
  scripting: Pick<
    typeof chrome.scripting,
    'getRegisteredContentScripts' | 'registerContentScripts' | 'updateContentScripts'
  > = chrome.scripting,
): Promise<void> {
  const script: chrome.scripting.RegisteredContentScript = {
    id: YOUTUBE_CAPTION_HOOK_ID,
    matches: ['https://www.youtube.com/*'],
    js: [captionHookScript],
    runAt: 'document_start',
    world: 'MAIN',
    allFrames: false,
    persistAcrossSessions: true,
  };
  const registered = await scripting.getRegisteredContentScripts({ ids: [script.id] });
  // Updating keeps the file path current after an extension update renames the bundle.
  if (registered.length) await scripting.updateContentScripts([script]);
  else await scripting.registerContentScripts([script]);
}
