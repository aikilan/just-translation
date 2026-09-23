// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { LanguagePicker } from './controls';
import { input, mount } from '../test-utils/ui';

let view: Awaited<ReturnType<typeof mount>>;
afterEach(() => view?.unmount());

it('commits settings language edits only after validation on blur or Enter', async () => {
  const save = vi.fn();
  view = await mount(
    <LanguagePicker value="Klingon" label="目标语言" allowCustom onChange={save} />,
  );
  await input(view.container, '自定义目标语言', '');
  const field = view.container.querySelector<HTMLInputElement>('input')!;
  await act(async () => {
    await Promise.resolve();
    field.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  });
  expect(save).not.toHaveBeenCalled();
  expect(field.getAttribute('aria-invalid')).toBe('true');
  await input(view.container, '自定义目标语言', ' French Canadian ');
  expect(field.value).toBe(' French Canadian ');
  expect(save).not.toHaveBeenCalled();
  await act(async () => {
    await Promise.resolve();
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  expect(save).toHaveBeenCalledExactlyOnceWith('French Canadian');
});
