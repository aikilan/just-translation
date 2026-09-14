import { describe, expect, it, vi } from 'vitest';

import type { PublicTranslatorSettings } from '../shared/messages';
import { tryStartAutomaticTranslation } from './auto-start';

const SETTINGS: PublicTranslatorSettings = {
  configured: true,
  activeProfileId: 'profile-one',
  profiles: [{ id: 'profile-one', name: '默认配置', configured: true }],
  targetLanguage: 'Simplified Chinese',
  displayMode: 'bilingual',
  translateDynamicContent: true,
  excludedSites: [],
  autoTranslateSites: ['news.ycombinator.com'],
};

describe('tryStartAutomaticTranslation', () => {
  it.each(['news.ycombinator.com', '*.ycombinator.com'])(
    'does not start when the auto-translated site also matches exclusion %s',
    async (rule) => {
      const start = vi.fn().mockResolvedValue(undefined);
      await tryStartAutomaticTranslation(
        { start },
        'https://news.ycombinator.com/news',
        vi.fn().mockResolvedValue({ ok: true, data: { ...SETTINGS, excludedSites: [rule] } }),
      );
      expect(start).not.toHaveBeenCalled();
    },
  );
  it('starts immediately when the loaded page hostname is marked for automatic translation', async () => {
    const start = vi.fn().mockResolvedValue(undefined);

    await tryStartAutomaticTranslation(
      { start },
      'https://news.ycombinator.com/news?p=2',
      vi.fn().mockResolvedValue({ ok: true, data: SETTINGS }),
    );

    expect(start).toHaveBeenCalledOnce();
  });

  it('does nothing for an unmarked site or a failed settings read', async () => {
    const start = vi.fn().mockResolvedValue(undefined);

    await tryStartAutomaticTranslation(
      { start },
      'https://example.com/',
      vi.fn().mockResolvedValue({ ok: true, data: SETTINGS }),
    );
    await tryStartAutomaticTranslation(
      { start },
      'https://news.ycombinator.com/news',
      vi.fn().mockResolvedValue({ ok: false, error: 'worker unavailable' }),
    );

    expect(start).not.toHaveBeenCalled();
  });
});
