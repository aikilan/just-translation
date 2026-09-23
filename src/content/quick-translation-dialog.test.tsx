// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { QuickTranslationDialog } from './quick-translation-dialog';
import { QuickTranslationController } from './quick-translation-controller';
import { setUiLanguage } from '../shared/i18n';
import { DEFAULT_SETTINGS } from '../shared/settings';
import type { PublicTranslatorSettings, Result, RuntimeRequest } from '../shared/messages';

let dialog: QuickTranslationDialog;
let model: QuickTranslationController;
let send: ReturnType<typeof vi.fn<(request: RuntimeRequest) => Promise<Result<unknown>>>>;
const settings: PublicTranslatorSettings = {
  ...DEFAULT_SETTINGS,
  uiLanguage: 'zh-CN',
  profiles: [],
  ready: true,
  supportsFullDocument: false,
};
const shadow = () => document.querySelector('[data-justranslate-quick]')!.shadowRoot!;
const button = (name: string) =>
  [...shadow().querySelectorAll('button')].find(
    (node) => node.getAttribute('aria-label') === name || node.textContent?.trim() === name,
  )!;

async function editCustomLanguage(value: string): Promise<HTMLInputElement> {
  const field = shadow().querySelector<HTMLInputElement>('[aria-label="自定义目标语言"]')!;
  await act(async () => {
    await Promise.resolve();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  return field;
}

async function openWithCustomLanguage(): Promise<void> {
  send.mockResolvedValueOnce({
    ok: true,
    data: {
      ...settings,
      targetLanguage: 'Klingon',
      activeTranslator: { kind: 'ai', profileId: 'test-ai' },
      profiles: [{ id: 'test-ai', name: 'Test AI', configured: true }],
    },
  });
  await act(async () => {
    await model.open();
    model.setSource('Synthetic translation text');
  });
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  document.documentElement.lang = 'es';
  document.documentElement.dir = 'ltr';
  document.title = 'Host title';
  document.body.innerHTML = '<main>Original article</main>';
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.open = true;
      },
    },
    close: {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.open = false;
      },
    },
  });
  send = vi.fn((request) =>
    Promise.resolve({
      ok: true,
      data:
        request.type === 'GET_PUBLIC_SETTINGS'
          ? settings
          : {
              text: '<img src=x onerror=alert(1)>',
              targetLanguage: settings.targetLanguage,
              translatorName: 'Google',
            },
    }),
  );
  model = new QuickTranslationController(send);
  act(() => {
    dialog = new QuickTranslationDialog(model);
  });
});
afterEach(() => {
  act(() => dialog.destroy());
  setUiLanguage('zh-CN');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('renders an isolated native modal, focuses input, and does not change the host document metadata', async () => {
  await act(async () => {
    await Promise.resolve();
    dialog.open();
  });
  expect(shadow().querySelector('dialog')!.open).toBe(true);
  expect(shadow().activeElement).toBe(shadow().querySelector('textarea'));
  expect(button('翻译').disabled).toBe(true);
  expect(document.documentElement.lang).toBe('es');
  expect(document.title).toBe('Host title');
  expect(document.querySelector('main')!.textContent).toBe('Original article');
  await act(async () => {
    await Promise.resolve();
    setUiLanguage('ar');
  });
  expect(shadow().querySelector('dialog')!.dir).toBe('rtl');
  expect(document.documentElement.dir).toBe('ltr');
});

it('mounts the editor before showing the modal on its first lazy-created open', async () => {
  const contentAtOpen: boolean[] = [];
  vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function (
    this: HTMLDialogElement,
  ) {
    contentAtOpen.push(Boolean(this.querySelector('textarea')));
    this.open = true;
  });
  await act(async () => {
    dialog.destroy();
    dialog = new QuickTranslationDialog(model);
    dialog.open();
    await Promise.resolve();
  });
  expect(contentAtOpen).toEqual([true]);
});

it('renders only text results, submits with the keyboard, clears, and preserves drafts across close', async () => {
  await act(async () => {
    await Promise.resolve();
    dialog.open();
  });
  await act(async () => {
    await Promise.resolve();
    model.setSource('Source text');
    shadow()
      .querySelector('textarea')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
  });
  expect(shadow().querySelector('[data-quick-result]')!.textContent).toBe(
    '<img src=x onerror=alert(1)>',
  );
  expect(shadow().querySelector('[data-quick-result] img')).toBeNull();
  await act(async () => {
    await Promise.resolve();
    button('关闭快捷翻译').click();
  });
  expect(shadow().querySelector('dialog')!.open).toBe(false);
  await act(async () => {
    await Promise.resolve();
    dialog.open();
  });
  expect(shadow().querySelector('textarea')!.value).toBe('Source text');
  expect(button('复制译文').disabled).toBe(false);
  await act(async () => {
    await Promise.resolve();
    button('清空').click();
  });
  expect(shadow().querySelector('textarea')!.value).toBe('');
  expect(button('复制译文').disabled).toBe(true);
});

it('handles native Escape cancellation without discarding the input', async () => {
  await act(async () => {
    await Promise.resolve();
    dialog.open();
    model.setSource('Draft');
  });
  await act(async () => {
    await Promise.resolve();
    shadow()
      .querySelector('dialog')!
      .dispatchEvent(new Event('cancel', { cancelable: true }));
  });
  expect(model.getSnapshot()).toMatchObject({ open: false, source: 'Draft' });
});

it('keeps a deleted draft translator explicit until the user chooses an available engine', async () => {
  send.mockResolvedValueOnce({
    ok: true,
    data: { ...settings, profiles: [{ id: 'removed', name: 'My AI', configured: true }] },
  });
  await act(async () => {
    await model.open();
    model.setTranslator({ kind: 'ai', profileId: 'removed' });
    model.setSource('Retained draft');
  });
  await act(async () => {
    model.close();
    await model.open();
  });
  const select = shadow().querySelector<HTMLSelectElement>('select[aria-label="翻译引擎"]')!;
  expect(select.value).toBe('ai:removed');
  expect(select.selectedOptions[0].textContent).toBe('当前翻译配置不存在');
  expect(button('翻译').disabled).toBe(true);
  await model.translate();
  expect(send.mock.calls.some(([request]) => request.type === 'TRANSLATE_QUICK_TEXT')).toBe(false);
  act(() => {
    select.value = 'builtin:google-free';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(button('翻译').disabled).toBe(false);
  expect(shadow().querySelector('textarea')!.value).toBe('Retained draft');
});

it.each(['', '   '])(
  'blocks every submit path for an empty custom language draft %j',
  async (value) => {
    await openWithCustomLanguage();
    const field = await editCustomLanguage(value);
    await act(async () => {
      await Promise.resolve();
      field.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      button('翻译').click();
      field.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }),
      );
      await model.translate();
    });
    expect(send.mock.calls.some(([request]) => request.type === 'TRANSLATE_QUICK_TEXT')).toBe(
      false,
    );
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(shadow().textContent).toContain('请填写目标语言');
    expect(button('翻译').disabled).toBe(true);
    expect(model.getSnapshot().targetLanguage).toBe(value);
  },
);

it('invalidates results while editing a custom language and submits the visible draft with the shortcut', async () => {
  await openWithCustomLanguage();
  await act(async () => {
    await model.translate();
  });
  expect(button('复制译文').disabled).toBe(false);
  // A draft that happens to match a preset must not remove the input mid-edit.
  const field = await editCustomLanguage('French');
  expect(shadow().querySelector('[aria-label="自定义目标语言"]')).toBe(field);
  expect(field.value).toBe('French');
  expect(model.getSnapshot().targetLanguage).toBe('French');
  expect(button('复制译文').disabled).toBe(true);
  await editCustomLanguage('French Canadian');
  await act(async () => {
    await Promise.resolve();
    field.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }),
    );
  });
  expect(send).toHaveBeenLastCalledWith(
    expect.objectContaining({
      type: 'TRANSLATE_QUICK_TEXT',
      targetLanguage: 'French Canadian',
    }),
  );
  await act(async () => {
    model.close();
    await model.open();
  });
  expect(field.value).toBe('French Canadian');
});

it('recovers an invalid language draft by choosing a preset and submits that preset', async () => {
  await openWithCustomLanguage();
  const field = await editCustomLanguage('');
  await act(async () => {
    await Promise.resolve();
    field.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  });
  expect(button('翻译').disabled).toBe(true);
  await act(async () => {
    await Promise.resolve();
    const select = shadow().querySelector<HTMLSelectElement>('[aria-label="翻译为"]')!;
    select.value = 'Japanese';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(shadow().querySelector('[aria-label="自定义目标语言"]')).toBeNull();
  expect(shadow().textContent).not.toContain('请填写目标语言');
  await act(async () => {
    await Promise.resolve();
    button('翻译').click();
  });
  expect(send).toHaveBeenLastCalledWith(
    expect.objectContaining({
      type: 'TRANSLATE_QUICK_TEXT',
      targetLanguage: 'Japanese',
    }),
  );
});
