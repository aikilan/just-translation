import { describe, expect, it, vi } from 'vitest';

import {
  PAGE_TRANSLATION_MENU_ID,
  SELECTION_TRANSLATION_MENU_ID,
  RETRY_FAILED_MENU_ID,
  ensurePageTranslationMenu,
  handlePageTranslationMenuClick,
} from './context-menu';

describe('page translation context menu', () => {
  it('starts translation for the clicked tab without toggling an existing translation off', async () => {
    const sendTabMessage = vi.fn().mockResolvedValue(undefined);

    const handled = await handlePageTranslationMenuClick(
      { menuItemId: PAGE_TRANSLATION_MENU_ID },
      42,
      sendTabMessage,
      vi.fn(),
    );

    expect(handled).toBe(true);
    expect(sendTabMessage).toHaveBeenCalledWith(42, { type: 'START_TRANSLATION' }, { frameId: 0 });
  });

  it('replaces persisted menus with context-specific directly clickable translation actions', async () => {
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
        title: '立即翻译',
        contexts: ['page'],
        documentUrlPatterns: ['http://*/*', 'https://*/*'],
      },
      {
        id: SELECTION_TRANSLATION_MENU_ID,
        title: '翻译已选内容',
        contexts: ['selection'],
        documentUrlPatterns: ['http://*/*', 'https://*/*'],
      },
    ]);
    expect(create).toHaveBeenCalledTimes(4);
  });

  it('waits for old menu removal before registering context-specific actions', async () => {
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
    expect(create).toHaveBeenCalledTimes(2);
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
      handlePageTranslationMenuClick(
        { menuItemId: 'other-extension-command' },
        42,
        sendTabMessage,
        vi.fn(),
      ),
    ).resolves.toBe(false);
    await expect(
      handlePageTranslationMenuClick(
        { menuItemId: 'just-translate-full-document' },
        42,
        sendTabMessage,
        vi.fn(),
      ),
    ).resolves.toBe(false);
    await expect(
      handlePageTranslationMenuClick(
        { menuItemId: PAGE_TRANSLATION_MENU_ID },
        undefined,
        sendTabMessage,
        vi.fn(),
      ),
    ).resolves.toBe(false);
    expect(sendTabMessage).not.toHaveBeenCalled();
  });

  it('contains tab messaging failures so the service worker has no unhandled rejection', async () => {
    const sendTabMessage = vi.fn().mockRejectedValue(new Error('content script unavailable'));

    await expect(
      handlePageTranslationMenuClick(
        { menuItemId: PAGE_TRANSLATION_MENU_ID },
        42,
        sendTabMessage,
        vi.fn(),
      ),
    ).resolves.toBe(false);
  });
});

it('routes selected text to its exact document and ignores whitespace selections', async () => {
  const send = vi.fn().mockResolvedValue(undefined);
  const resolve = vi.fn().mockResolvedValue('child-document');
  await handlePageTranslationMenuClick(
    { menuItemId: SELECTION_TRANSLATION_MENU_ID, selectionText: '  selected\ntext  ', frameId: 5 },
    42,
    send,
    resolve,
  );
  expect(resolve).toHaveBeenCalledWith(42, 5);
  expect(send).toHaveBeenCalledWith(
    42,
    { type: 'START_SELECTION_TRANSLATION', text: '  selected\ntext  ' },
    { documentId: 'child-document' },
  );
  send.mockClear();
  await handlePageTranslationMenuClick(
    { menuItemId: SELECTION_TRANSLATION_MENU_ID, selectionText: '   ' },
    42,
    send,
    resolve,
  );
  expect(send).not.toHaveBeenCalled();
});

it('retries failed page paragraphs in the exact top document even when selecting text in an iframe', async () => {
  const send = vi
    .fn()
    .mockResolvedValueOnce({ mode: 'segmented', failed: 2 })
    .mockResolvedValue(undefined);
  const resolve = vi.fn().mockResolvedValue('top-document');
  expect(
    await handlePageTranslationMenuClick(
      { menuItemId: RETRY_FAILED_MENU_ID, frameId: 7, selectionText: 'Selected text' },
      42,
      send,
      resolve,
    ),
  ).toBe(true);
  expect(resolve).toHaveBeenCalledWith(42, 0);
  expect(send.mock.calls).toEqual([
    [42, { type: 'GET_PAGE_STATUS' }, { documentId: 'top-document' }],
    [42, { type: 'RETRY_FAILED_TRANSLATIONS' }, { documentId: 'top-document' }],
  ]);
});

it.each([undefined, { mode: 'segmented', failed: 0 }, { mode: 'full-document', failed: 2 }])(
  'does not retry when the menu click reaches an ineligible document: %j',
  async (status) => {
    const send = vi.fn().mockResolvedValue(status);
    expect(
      await handlePageTranslationMenuClick(
        { menuItemId: RETRY_FAILED_MENU_ID },
        42,
        send,
        vi.fn().mockResolvedValue('doc'),
      ),
    ).toBe(false);
    expect(send).not.toHaveBeenCalledWith(
      42,
      { type: 'RETRY_FAILED_TRANSLATIONS' },
      expect.anything(),
    );
  },
);

it('never starts page translation from a selection action without selected text', async () => {
  const send = vi.fn().mockResolvedValue(undefined);
  const resolve = vi.fn();
  expect(
    await handlePageTranslationMenuClick(
      { menuItemId: SELECTION_TRANSLATION_MENU_ID },
      42,
      send,
      resolve,
    ),
  ).toBe(false);
  expect(send).not.toHaveBeenCalled();
  expect(resolve).not.toHaveBeenCalled();
});
