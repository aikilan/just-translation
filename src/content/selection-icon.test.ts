// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PublicTranslatorSettings, Result } from '../shared/messages';
import { SelectionIcon, isFrameExcluded, type SelectionIconRequest } from './selection-icon';

const GOOGLE = { kind: 'builtin', engine: 'google-free' } as const;

function settings(patch: Partial<PublicTranslatorSettings> = {}): Result<PublicTranslatorSettings> {
  return {
    ok: true,
    data: {
      selectionIcon: true,
      excludedSites: [],
      activeTranslator: GOOGLE,
      profiles: [],
      ...patch,
    } as unknown as PublicTranslatorSettings,
  };
}

let icon: SelectionIcon | undefined;
let readSettings: ReturnType<typeof vi.fn<() => Promise<Result<PublicTranslatorSettings>>>>;
let onTranslate: ReturnType<typeof vi.fn<(request: SelectionIconRequest) => void>>;

function select(element: Element): void {
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}

async function release(target: Element = document.body): Promise<void> {
  target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, composed: true }));
  await vi.advanceTimersByTimeAsync(200);
}

function button(): HTMLButtonElement | null | undefined {
  return document
    .querySelector('[data-justranslate-selection-icon]')
    ?.shadowRoot?.querySelector('button');
}

describe('selection translate button', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    HTMLElement.prototype.showPopover = vi.fn();
    HTMLElement.prototype.hidePopover = vi.fn();
    const rect = { left: 10, right: 120, top: 20, bottom: 40, width: 110, height: 20 } as DOMRect;
    Range.prototype.getBoundingClientRect = () => rect;
    Range.prototype.getClientRects = () => [rect] as unknown as DOMRectList;
    document.body.innerHTML =
      '<main><p id="text">Selected words to translate.</p><textarea id="editor">Draft text</textarea></main>';
    readSettings = vi.fn(() => Promise.resolve(settings()));
    onTranslate = vi.fn();
    icon = new SelectionIcon(readSettings, onTranslate);
  });

  afterEach(() => {
    icon?.destroy();
    window.getSelection()?.removeAllRanges();
    vi.useRealTimers();
  });

  it('shows a button naming the recipient without sending the selection', async () => {
    select(document.querySelector('#text')!);
    await release(document.querySelector('#text')!);
    expect(button()?.getAttribute('aria-label')).toContain('Google');
    expect(onTranslate).not.toHaveBeenCalled();
  });

  it('starts selection translation only when clicked, then removes the button', async () => {
    select(document.querySelector('#text')!);
    await release(document.querySelector('#text')!);
    button()!.click();
    expect(onTranslate).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Selected words to translate.', translator: GOOGLE }),
    );
    expect(button()).toBeUndefined();
  });

  it('respects the setting and the excluded-site list', async () => {
    readSettings.mockResolvedValueOnce(settings({ selectionIcon: false }));
    select(document.querySelector('#text')!);
    await release(document.querySelector('#text')!);
    expect(button()).toBeUndefined();

    // Returning to the page drops cached settings, so a change made in the popup applies.
    window.dispatchEvent(new Event('focus'));
    readSettings.mockResolvedValueOnce(settings({ excludedSites: [location.hostname] }));
    await release(document.querySelector('#text')!);
    expect(button()).toBeUndefined();
    expect(readSettings).toHaveBeenCalledTimes(2);
  });

  it('reuses settings across nearby selections', async () => {
    select(document.querySelector('#text')!);
    await release(document.querySelector('#text')!);
    await release(document.querySelector('#text')!);
    expect(button()).toBeTruthy();
    expect(readSettings).toHaveBeenCalledOnce();
  });

  it('checks every ancestor frame against the excluded sites', () => {
    expect(
      isFrameExcluded(
        ['bank.example.com'],
        ['https://widget.example.net/', 'https://bank.example.com'],
      ),
    ).toBe(true);
    expect(isFrameExcluded(['bank.example.com'], ['https://widget.example.net/'])).toBe(false);
  });

  it('hides when the document or the selection container scrolls, not other panes', async () => {
    document.body.insertAdjacentHTML('beforeend', '<div id="ticker"><span>News</span></div>');
    select(document.querySelector('#text')!);
    await release(document.querySelector('#text')!);
    document.querySelector('#ticker')!.dispatchEvent(new Event('scroll'));
    expect(button()).toBeTruthy();
    document.querySelector('main')!.dispatchEvent(new Event('scroll'));
    expect(button()).toBeUndefined();

    await release(document.querySelector('#text')!);
    expect(button()).toBeTruthy();
    document.dispatchEvent(new Event('scroll'));
    expect(button()).toBeUndefined();
  });

  it('stays out of editors and ignores selections without letters', async () => {
    const editor = document.querySelector<HTMLTextAreaElement>('#editor')!;
    editor.focus();
    select(document.querySelector('#text')!);
    await release(editor);
    expect(button()).toBeUndefined();
    editor.blur();

    document.querySelector('#text')!.textContent = '2026-10-23 ...';
    select(document.querySelector('#text')!);
    await release(document.querySelector('#text')!);
    expect(button()).toBeUndefined();
    expect(readSettings).not.toHaveBeenCalled();
  });

  it('hides on outside pointer down and Escape', async () => {
    select(document.querySelector('#text')!);
    await release(document.querySelector('#text')!);
    expect(button()).toBeTruthy();
    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, composed: true }));
    expect(button()).toBeUndefined();

    await release(document.querySelector('#text')!);
    expect(button()).toBeTruthy();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(button()).toBeUndefined();
  });

  it('drops an evaluation when a newer selection starts before settings arrive', async () => {
    let resolve!: (value: Result<PublicTranslatorSettings>) => void;
    readSettings.mockReturnValueOnce(new Promise((done) => (resolve = done)));
    select(document.querySelector('#text')!);
    await release(document.querySelector('#text')!);
    document.body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    resolve(settings());
    await vi.advanceTimersByTimeAsync(0);
    expect(readSettings).toHaveBeenCalledTimes(1);
    expect(button()).toBeUndefined();
  });
});
