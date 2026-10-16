import { describe, expect, it } from 'vitest';

import { isPageTranslationStatus, type PageTranslationStatus } from './messages';

const STATUS: PageTranslationStatus = {
  mode: 'segmented',
  phase: 'idle',
  translated: 0,
  failed: 0,
  total: 0,
  displayMode: 'bilingual',
};

describe('page status validation', () => {
  it('accepts video subtitle state from a YouTube page', () => {
    expect(
      isPageTranslationStatus({ ...STATUS, videoSubtitles: { enabled: true, phase: 'on' } }),
    ).toBe(true);
    expect(
      isPageTranslationStatus({
        ...STATUS,
        videoSubtitles: { enabled: true, phase: 'error', error: { text: '失败' } },
      }),
    ).toBe(true);
  });

  it.each([
    null,
    { enabled: 'yes', phase: 'on' },
    { enabled: true, phase: 'playing' },
    { enabled: true, phase: 'error', error: 'failed' },
  ])('rejects malformed video subtitle state %j', (videoSubtitles) => {
    expect(isPageTranslationStatus({ ...STATUS, videoSubtitles })).toBe(false);
  });
});
