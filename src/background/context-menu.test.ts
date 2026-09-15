import { describe, expect, it, vi } from 'vitest';

import {
  PAGE_TRANSLATION_MENU_ID,
  ensurePageTranslationMenu,
  handlePageTranslationMenuClick,
} from './context-menu';

describe('page translation context menu', () => {
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

  it('replaces persisted menus with exactly one direct action for pages, links and selections', async () => {
    const menus = new Map<string, chrome.contextMenus.CreateProperties>([
      ['previous-action', { id: 'previous-action', title: 'Previous action' }],
    ]);
    const removeAll = vi.fn(() => {
      menus.clear();
      return Promise.resolve();
    });
    const create = vi.fn((properties: chrome.contextMenus.CreateProperties) => {
      menus.set(properties.id!, properties);
      return Promise.resolve();
    });

    await ensurePageTranslationMenu({ removeAll, create });
    await ensurePageTranslationMenu({ removeAll, create });

    expect([...menus.values()]).toEqual([
      {
        id: PAGE_TRANSLATION_MENU_ID,
        title: '使用「只是翻译」翻译此网页',
        contexts: ['all'],
        documentUrlPatterns: ['http://*/*', 'https://*/*'],
      },
    ]);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('waits for old menu removal before registering the single action', async () => {
    let finish!: () => void;
    const removeAll = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const create = vi.fn().mockResolvedValue(undefined);
    const registration = ensurePageTranslationMenu({ removeAll, create });
    expect(create).not.toHaveBeenCalled();
    finish();
    await registration;
    expect(create).toHaveBeenCalledOnce();
  });

  it('propagates registration failures instead of adding another action after failed removal', async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    await expect(
      ensurePageTranslationMenu({
        removeAll: vi.fn().mockRejectedValue(new Error('removal failed')),
        create,
      }),
    ).rejects.toThrow('removal failed');
    expect(create).not.toHaveBeenCalled();
    create.mockRejectedValueOnce(new Error('creation failed'));
    await expect(
      ensurePageTranslationMenu({
        removeAll: vi.fn().mockResolvedValue(undefined),
        create,
      }),
    ).rejects.toThrow('creation failed');
  });

  it('ignores unrelated menu items and tabs without an id', async () => {
    const sendTabMessage = vi.fn().mockResolvedValue(undefined);

    await expect(
      handlePageTranslationMenuClick('other-extension-command', 42, sendTabMessage),
    ).resolves.toBe(false);
    await expect(
      handlePageTranslationMenuClick('just-translate-full-document', 42, sendTabMessage),
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
