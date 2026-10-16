import { describe, expect, it, vi } from 'vitest';

import { registerYouTubeCaptionHook, YOUTUBE_CAPTION_HOOK_ID } from './youtube-caption-hook';

function fakeScripting(registered: chrome.scripting.RegisteredContentScript[]) {
  return {
    getRegisteredContentScripts: vi.fn(() => Promise.resolve(registered)),
    registerContentScripts: vi.fn(() => Promise.resolve()),
    updateContentScripts: vi.fn(() => Promise.resolve()),
  };
}

describe('YouTube caption hook registration', () => {
  it('registers a page-world script for youtube.com before page scripts run', async () => {
    const scripting = fakeScripting([]);
    await registerYouTubeCaptionHook(scripting);
    expect(scripting.getRegisteredContentScripts).toHaveBeenCalledWith({
      ids: [YOUTUBE_CAPTION_HOOK_ID],
    });
    expect(scripting.registerContentScripts).toHaveBeenCalledWith([
      expect.objectContaining({
        id: YOUTUBE_CAPTION_HOOK_ID,
        matches: ['https://www.youtube.com/*'],
        js: [expect.stringMatching(/caption-hook/)],
        runAt: 'document_start',
        world: 'MAIN',
        allFrames: false,
        persistAcrossSessions: true,
      }),
    ]);
    expect(scripting.updateContentScripts).not.toHaveBeenCalled();
  });

  it('updates the kept registration so an extension update points at the new bundle', async () => {
    const scripting = fakeScripting([{ id: YOUTUBE_CAPTION_HOOK_ID, js: ['old.js'] }]);
    await registerYouTubeCaptionHook(scripting);
    expect(scripting.updateContentScripts).toHaveBeenCalledWith([
      expect.objectContaining({ id: YOUTUBE_CAPTION_HOOK_ID, world: 'MAIN' }),
    ]);
    expect(scripting.registerContentScripts).not.toHaveBeenCalled();
  });
});
