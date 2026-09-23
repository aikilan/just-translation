// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OptionsApp } from './options-app';
import { DEFAULT_SETTINGS } from '../shared/settings';
import { mount, mockExtension, input, click, READY_SETTINGS } from '../test-utils/ui';
let view: Awaited<ReturnType<typeof mount>>;
it('automatically enables and locks image support for the official GPT-5.6 alias', async () => {
  mockExtension();
  view = await mount(<OptionsApp />);
  await input(view.container, '供应商', 'openai');
  await input(view.container, 'API 地址', 'https://api.openai.com/v1');
  await input(view.container, '模型', 'gpt-5.6');
  const toggle = view.container.querySelector<HTMLInputElement>('[aria-label="支持图片输入"]')!;
  expect(toggle.checked).toBe(true);
  expect(toggle.disabled).toBe(true);
  await click(view.container, '保存配置');
  view.unmount();
  view = await mount(<OptionsApp />);
  expect(
    view.container.querySelector<HTMLInputElement>('[aria-label="支持图片输入"]')!.checked,
  ).toBe(true);
});
it('saves custom image support, resets it for a different endpoint/model, and derives official capabilities', async () => {
  const { send } = mockExtension();
  view = await mount(<OptionsApp />);
  const toggle = () =>
    view.container.querySelector<HTMLInputElement>('[aria-label="支持图片输入"]')!;
  expect(toggle().checked).toBe(false);
  await act(async () => {
    await Promise.resolve();
    toggle().click();
  });
  await click(view.container, '保存配置');
  expect(send.mock.calls.at(-1)?.[0]).toMatchObject({
    type: 'SAVE_TRANSLATION_PROFILE',
    profile: { imageInputEnabled: true },
  });
  view.unmount();
  view = await mount(<OptionsApp />);
  expect(toggle().checked).toBe(true);
  await input(view.container, '接入协议', 'anthropic');
  expect(toggle().checked).toBe(false);
  await act(async () => {
    await Promise.resolve();
    toggle().click();
  });
  await input(view.container, '配置名称', 'Custom vision');
  expect(toggle().checked).toBe(true);
  await input(view.container, '接入协议', 'openai');
  await input(view.container, '模型', 'other-alias');
  expect(toggle().checked).toBe(false);
  await act(async () => {
    await Promise.resolve();
    toggle().click();
  });
  await input(view.container, 'API 地址', 'https://other.test/v1');
  expect(toggle().checked).toBe(false);
  await input(view.container, '供应商', 'mimo');
  await input(view.container, 'API 地址', 'https://api.xiaomimimo.com/v1');
  await input(view.container, '模型', 'mimo-v2.5');
  expect(toggle().checked).toBe(true);
  expect(toggle().disabled).toBe(true);
  await input(view.container, '模型', 'mimo-v2.5-pro');
  expect(toggle().checked).toBe(false);
  expect(toggle().disabled).toBe(true);
});
afterEach(() => {
  view?.unmount();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe('provider configuration flow', () => {
  it('requires provider first, defaults OpenAI and persists Anthropic options', async () => {
    const { send } = mockExtension(DEFAULT_SETTINGS);
    view = await mount(<OptionsApp />);
    expect(view.container.querySelector<HTMLSelectElement>('[aria-label="供应商"]')?.value).toBe(
      '',
    );
    await input(view.container, '供应商', 'mimo');
    expect(view.container.querySelector<HTMLSelectElement>('[aria-label="接入协议"]')?.value).toBe(
      'openai',
    );
    expect(view.container.querySelector<HTMLInputElement>('[aria-label="API 地址"]')?.value).toBe(
      'https://api.xiaomimimo.com/v1',
    );
    await input(view.container, '接入协议', 'anthropic');
    expect(view.container.querySelector<HTMLInputElement>('[aria-label="API 地址"]')?.value).toBe(
      'https://api.xiaomimimo.com/anthropic',
    );
    await input(view.container, '模型', 'mimo-v2.5');
    await click(view.container, '保存配置');
    expect(send.mock.calls.at(-1)?.[0]).toMatchObject({
      type: 'SAVE_TRANSLATION_PROFILE',
      profile: { provider: 'mimo', protocol: 'anthropic', thinkingEnabled: false },
    });
    view.unmount();
    view = await mount(<OptionsApp />);
    expect(view.container.querySelector<HTMLSelectElement>('[aria-label="接入协议"]')?.value).toBe(
      'anthropic',
    );
  });
  it('preserves a manual URL, clears credentials on provider change and advertises gateway requirements', async () => {
    mockExtension();
    view = await mount(<OptionsApp />);
    await input(view.container, 'API 地址', 'https://my.gateway.test/prefix');
    await input(view.container, '供应商', 'gemini');
    await input(view.container, '接入协议', 'anthropic');
    expect(view.container.querySelector<HTMLInputElement>('[aria-label="API 地址"]')?.value).toBe(
      'https://my.gateway.test/prefix',
    );
    expect(view.container.querySelector<HTMLInputElement>('[aria-label="API Key"]')?.value).toBe(
      '',
    );
    expect(view.container.textContent).toContain('中转');
  });
  it('shows immutable thinking and exact supported efforts, permits unknown-model overrides', async () => {
    mockExtension();
    view = await mount(<OptionsApp />);
    await input(view.container, '供应商', 'grok');
    await input(view.container, '模型', 'grok-4.6');
    const toggle = view.container.querySelector<HTMLInputElement>('[aria-label="开启思考"]')!;
    expect(toggle.checked).toBe(true);
    expect(toggle.disabled).toBe(true);
    expect(
      Array.from(
        view.container.querySelector<HTMLSelectElement>('[aria-label="思考强度"]')!.options,
        (o) => o.value,
      ),
    ).toEqual(['default', 'low', 'medium', 'high', 'xhigh']);
    await input(view.container, '模型', 'private-alias');
    expect(view.container.textContent).toContain('未识别');
    await input(view.container, '思考控制方式', 'enable_thinking');
    expect(
      view.container.querySelector<HTMLInputElement>('[aria-label="开启思考"]')?.disabled,
    ).toBe(false);
    await act(async () => {
      view.container.querySelector<HTMLInputElement>('[aria-label="开启思考"]')!.click();
      await Promise.resolve();
    });
    expect(view.container.querySelector<HTMLInputElement>('[aria-label="开启思考"]')?.checked).toBe(
      false,
    );
  });
});

it('keeps an invalid imported control editable rather than crashing the settings page', async () => {
  const { READY_SETTINGS } = await import('../test-utils/ui');
  mockExtension({
    ...READY_SETTINGS,
    profiles: READY_SETTINGS.profiles.map((p) => ({
      ...p,
      protocol: 'anthropic',
      thinkingControl: 'enable_thinking',
    })),
  });
  view = await mount(<OptionsApp />);
  expect(view.container.querySelector('[aria-label="思考控制方式"]')).not.toBeNull();
  await input(view.container, '思考控制方式', 'auto');
  expect(view.container.textContent).toContain('保存配置');
});

it('validates a budget against output cap, retains the draft on save failure and clears old strategy fields', async () => {
  const { send } = mockExtension();
  view = await mount(<OptionsApp />);
  await input(view.container, '接入协议', 'anthropic');
  await input(view.container, '思考控制方式', 'anthropic-budget');
  act(() => {
    view.container.querySelector<HTMLInputElement>('[aria-label="开启思考"]')!.click();
  });
  await input(view.container, '思考预算', '2048');
  await input(view.container, '输出上限', '2048');
  await click(view.container, '保存配置');
  expect(view.container.textContent).toContain('思考预算必须至少 1024 且小于输出上限');
  expect(send.mock.calls.some(([r]) => r.type === 'SAVE_TRANSLATION_PROFILE')).toBe(false);
  await input(view.container, '输出上限', '8192');
  send.mockResolvedValueOnce({ ok: false, error: { text: '保存失败' } } as never);
  await click(view.container, '保存配置');
  expect(view.container.querySelector<HTMLInputElement>('[aria-label="思考预算"]')?.value).toBe(
    '2048',
  );
  expect(view.container.textContent).toContain('保存失败');
  await input(view.container, '思考控制方式', 'thinking');
  expect(view.container.querySelector('[aria-label="思考预算"]')).toBeNull();
});

it('enables mandatory thinking when changing to a protocol that cannot disable it', async () => {
  mockExtension();
  view = await mount(<OptionsApp />);
  await input(view.container, '供应商', 'kimi');
  await input(view.container, '模型', 'kimi-k3');
  await input(view.container, '接入协议', 'anthropic');
  act(() => {
    view.container.querySelector<HTMLInputElement>('[aria-label="开启思考"]')!.click();
  });
  expect(view.container.querySelector<HTMLInputElement>('[aria-label="开启思考"]')?.checked).toBe(
    false,
  );
  await input(view.container, '接入协议', 'openai');
  await click(view.container, '保存配置');
  expect(view.container.textContent).not.toContain('此模型始终思考，无法关闭');
});

it.each([
  ['grok', 'grok-4.6', true],
  ['mimo', 'mimo-v2.5', false],
] as const)(
  'restores the actual %s thinking state when returning to auto',
  async (provider, model, mandatory) => {
    const { send } = mockExtension();
    view = await mount(<OptionsApp />);
    await input(view.container, '供应商', provider);
    await input(view.container, '模型', model);
    await input(view.container, '思考控制方式', 'reasoning_effort');
    act(() => {
      const toggle = view.container.querySelector<HTMLInputElement>('[aria-label="开启思考"]')!;
      if (toggle.checked) toggle.click();
    });
    await input(view.container, '思考控制方式', 'auto');
    const toggle = view.container.querySelector<HTMLInputElement>('[aria-label="开启思考"]')!;
    expect(toggle.checked).toBe(mandatory);
    expect(toggle.disabled).toBe(mandatory);
    await click(view.container, '保存配置');
    expect(view.container.textContent).not.toContain('此模型始终思考，无法关闭');
    expect(send.mock.calls.at(-1)?.[0]).toMatchObject({
      type: 'SAVE_TRANSLATION_PROFILE',
      profile: { thinkingEnabled: mandatory, thinkingControl: 'auto' },
    });
    view.unmount();
    view = await mount(<OptionsApp />);
    expect(view.container.querySelector<HTMLInputElement>('[aria-label="开启思考"]')!.checked).toBe(
      mandatory,
    );
  },
);

it.each([
  ['https://api.xiaomimimo.com/v1', 'https://api.xiaomimimo.com/anthropic'],
  ['https://saved-relay.test/prefix', 'https://saved-relay.test/prefix'],
])(
  'discards address edits without losing the saved URL behavior for %s',
  async (apiUrl, expected) => {
    mockExtension({
      ...READY_SETTINGS,
      profiles: [{ ...READY_SETTINGS.profiles[0], provider: 'mimo', apiUrl, model: 'mimo-v2.5' }],
    });
    view = await mount(<OptionsApp />);
    await input(view.container, 'API 地址', 'https://unsaved-relay.test/v1');
    await click(view.container, '放弃修改');
    await input(view.container, '接入协议', 'anthropic');
    expect(view.container.querySelector<HTMLInputElement>('[aria-label="API 地址"]')!.value).toBe(
      expected,
    );
  },
);
