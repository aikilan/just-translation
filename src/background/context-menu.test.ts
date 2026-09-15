import { describe, expect, it, vi } from 'vitest';

import {
  PAGE_TRANSLATION_MENU_ID,
  FULL_DOCUMENT_TRANSLATION_MENU_ID,
  ensurePageTranslationMenu,
  handlePageTranslationMenuClick,
} from './context-menu';

describe('page translation context menu', () => {
  it('routes the independent full-document action to the clicked page', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    expect(await handlePageTranslationMenuClick(FULL_DOCUMENT_TRANSLATION_MENU_ID, 42, send)).toBe(
      true,
    );
    expect(send).toHaveBeenCalledWith(42, { type: 'START_FULL_DOCUMENT_TRANSLATION' });
  });
  it('starts translation for the clicked tab without toggling an existing translation off', async () => {
    const sendTabMessage = vi.fn().mockResolvedValue(undefined);

    const handled = await handlePageTranslationMenuClick(
      PAGE_TRANSLATION_MENU_ID,
      42,
      sendTabMessage,
    );

    expect(handled).toBe(true);
    expect(sendTabMessage).toHaveBeenCalledWith(42, { type: 'START_TRANSLATION' });
  });

  it('self-heals a missing menu whenever the service worker starts', async () => {
    const update = vi.fn().mockRejectedValue(new Error('menu not found'));
    const create = vi.fn().mockReturnValue(PAGE_TRANSLATION_MENU_ID);

    await ensurePageTranslationMenu({ update, create });

    expect(update).toHaveBeenCalledWith(
      PAGE_TRANSLATION_MENU_ID,
      expect.objectContaining({
        title: '使用「只是翻译」翻译此网页',
        contexts: ['all'],
      }),
    );
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ id: PAGE_TRANSLATION_MENU_ID }));
  });

  it('updates an existing menu without creating a duplicate', async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    const create = vi.fn();

    await ensurePageTranslationMenu({ update, create });

    expect(update).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenCalledWith(
      FULL_DOCUMENT_TRANSLATION_MENU_ID,
      expect.objectContaining({ title: '全文完整翻译（保留上下文）' }),
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('ignores unrelated menu items and tabs without an id', async () => {
    const sendTabMessage = vi.fn().mockResolvedValue(undefined);

    await expect(
      handlePageTranslationMenuClick('other-extension-command', 42, sendTabMessage),
    ).resolves.toBe(false);
    await expect(
      handlePageTranslationMenuClick(PAGE_TRANSLATION_MENU_ID, undefined, sendTabMessage),
    ).resolves.toBe(false);
    expect(sendTabMessage).not.toHaveBeenCalled();
  });

  it('contains tab messaging failures so the service worker has no unhandled rejection', async () => {
    const sendTabMessage = vi.fn().mockRejectedValue(new Error('content script unavailable'));

    await expect(
      handlePageTranslationMenuClick(PAGE_TRANSLATION_MENU_ID, 42, sendTabMessage),
    ).resolves.toBe(false);
  });
});
