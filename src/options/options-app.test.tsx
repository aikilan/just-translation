// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OptionsApp } from './options-app';
import { DEFAULT_SETTINGS, DEFAULT_TRANSLATION_PROMPT } from '../shared/settings';
import type { RuntimeRequest } from '../shared/messages';
import { button, click, input, mount, mockExtension, READY_SETTINGS } from '../test-utils/ui';
import { testTranslatorConfiguration } from './test-configuration';
vi.mock('./test-configuration', () => ({ testTranslatorConfiguration: vi.fn() }));
let view: Awaited<ReturnType<typeof mount>>;
afterEach(() => {
  view?.unmount();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.mocked(testTranslatorConfiguration).mockReset();
});
describe('settings workspace', () => {
  it('puts the connection editor before independently saved translation preferences', async () => {
    mockExtension();
    view = await mount(<OptionsApp />);
    const editor = view.container.querySelector('[aria-label="配置编辑器"]')!;
    const preferences = view.container.querySelector('aside[aria-label="翻译偏好"]')!;
    expect(editor).not.toBeNull();
    expect(preferences).not.toBeNull();
    expect(
      editor.compareDocumentPosition(preferences) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(editor.querySelector('[aria-label="API 地址"]')).not.toBeNull();
    expect(preferences.querySelector('[aria-label="单页翻译并发数"]')).not.toBeNull();
    expect(preferences.querySelector('[aria-label="翻译失败重试次数"]')).not.toBeNull();
    expect(preferences.textContent).toContain('自动保存');
    expect(editor.querySelector('fieldset')?.textContent).toContain('连接信息');
    expect(editor.querySelector('fieldset[aria-label="模型行为"]')).not.toBeNull();
  });
  it('keeps draft state next to save actions and restores it when switching sections', async () => {
    mockExtension();
    view = await mount(<OptionsApp />);
    await input(view.container, '模型', 'draft-model');
    expect(view.container.querySelector('.ai-actions')?.textContent).toContain('有未保存的修改');
    await click(view.container, '阅读偏好');
    await click(view.container, 'AI 配置');
    expect(view.container.querySelector<HTMLInputElement>('[aria-label="模型"]')?.value).toBe(
      'draft-model',
    );
    await click(view.container, '放弃修改');
    expect(view.container.querySelector('.ai-actions')?.textContent).not.toContain(
      '有未保存的修改',
    );
  });
  it('defaults thinking off, saves it with the profile and retains a failed draft', async () => {
    const { send } = mockExtension();
    view = await mount(<OptionsApp />);
    await input(view.container, '供应商', 'mimo');
    await input(view.container, '模型', 'mimo-v2.5');
    const toggle = () => view.container.querySelector<HTMLInputElement>('[aria-label="开启思考"]')!;
    expect(toggle()?.checked).toBe(false);
    expect(view.container.textContent).toContain('开启思考翻译时间较慢');
    await act(async () => {
      toggle().click();
      await Promise.resolve();
    });
    expect(toggle().checked).toBe(true);
    expect(send).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'SAVE_TRANSLATION_PROFILE' }),
    );
    send.mockRejectedValueOnce(new Error('写入失败'));
    await click(view.container, '保存配置');
    expect(toggle().checked).toBe(true);
    expect(view.container.textContent).toContain('写入失败');
    await click(view.container, '保存配置');
    expect(send.mock.calls.at(-1)?.[0]).toMatchObject({
      type: 'SAVE_TRANSLATION_PROFILE',
      profile: { thinkingEnabled: true },
    });
    view.unmount();
    view = await mount(<OptionsApp />);
    expect(toggle().checked).toBe(true);
    await input(view.container, '正在编辑的配置', 'second');
    expect(toggle().checked).toBe(false);
    expect(toggle().disabled).toBe(true);
    await click(view.container, '新增配置');
    await input(view.container, '供应商', 'mimo');
    await input(view.container, '模型', 'mimo-v2.5');
    expect(toggle().checked).toBe(false);
    expect(toggle().disabled).toBe(false);
  });
  it('autosaves retry count in AI settings without saving the AI draft and retains it on reopen', async () => {
    const { send } = mockExtension();
    view = await mount(<OptionsApp />);
    const select =
      view.container.querySelector<HTMLSelectElement>('[aria-label="翻译失败重试次数"]');
    expect(select?.closest('section')?.getAttribute('aria-label')).toBe('AI 配置');
    expect(select?.value).toBe('1');
    expect(Array.from(select?.options ?? [], (option) => option.value)).toEqual([
      '0',
      '1',
      '2',
      '3',
      '4',
      '5',
    ]);
    await input(view.container, '模型', 'unsaved-model');
    await input(view.container, '翻译失败重试次数', '0');
    expect(send).toHaveBeenCalledWith({
      type: 'UPDATE_READING_PREFERENCES',
      patch: { translationRetryCount: 0 },
    });
    expect(send).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'SAVE_TRANSLATION_PROFILE' }),
    );
    expect(view.container.querySelector<HTMLInputElement>('[aria-label="模型"]')?.value).toBe(
      'unsaved-model',
    );
    view.unmount();
    view = await mount(<OptionsApp />);
    expect(
      view.container.querySelector<HTMLSelectElement>('[aria-label="翻译失败重试次数"]')?.value,
    ).toBe('0');
  });
  it('retains a failed retry count selection and allows retrying its save', async () => {
    const { send } = mockExtension();
    view = await mount(<OptionsApp />);
    send.mockRejectedValueOnce(new Error('写入失败'));
    await input(view.container, '翻译失败重试次数', '5');
    expect(view.container.textContent).toContain('写入失败');
    expect(
      view.container.querySelector<HTMLSelectElement>('[aria-label="翻译失败重试次数"]')?.value,
    ).toBe('5');
    await click(view.container, '重试保存');
    view.unmount();
    view = await mount(<OptionsApp />);
    expect(
      view.container.querySelector<HTMLSelectElement>('[aria-label="翻译失败重试次数"]')?.value,
    ).toBe('5');
  });
  it('places concurrency only in AI settings and retains its saved value after reopening', async () => {
    const { send } = mockExtension();
    view = await mount(<OptionsApp />);
    await click(view.container, 'AI 配置');
    const control = view.container.querySelector('[aria-label="单页翻译并发数"]');
    expect(control?.closest('section[aria-label]')?.getAttribute('aria-label')).toBe('AI 配置');
    expect(
      view.container.querySelector('section[aria-label="阅读偏好"] [aria-label="单页翻译并发数"]'),
    ).toBeNull();
    await input(view.container, '模型', 'unsaved-model');
    await input(view.container, '单页翻译并发数', '2');
    expect(view.container.querySelector<HTMLInputElement>('[aria-label="模型"]')?.value).toBe(
      'unsaved-model',
    );
    expect(send).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'SAVE_TRANSLATION_PROFILE' }),
    );
    expect(send).toHaveBeenCalledWith({
      type: 'UPDATE_READING_PREFERENCES',
      patch: { translationConcurrency: 2 },
    });
    view.unmount();
    view = await mount(<OptionsApp />);
    expect(
      view.container.querySelector<HTMLSelectElement>('[aria-label="单页翻译并发数"]')?.value,
    ).toBe('2');
  });
  it('retains a failed concurrency selection for retry in AI settings', async () => {
    mockExtension();
    view = await mount(<OptionsApp />);
    await click(view.container, 'AI 配置');
    vi.mocked<(request: RuntimeRequest) => Promise<unknown>>(
      chrome.runtime.sendMessage,
    ).mockResolvedValueOnce({ ok: false, error: '保存失败' });
    await input(view.container, '单页翻译并发数', '1');
    expect(
      view.container.querySelector('section[aria-label="AI 配置"] [role="alert"]')?.textContent,
    ).toContain('保存失败');
    expect(
      view.container.querySelector<HTMLSelectElement>('[aria-label="单页翻译并发数"]')?.value,
    ).toBe('1');
    await click(view.container, '重试保存');
    view.unmount();
    view = await mount(<OptionsApp />);
    expect(
      view.container.querySelector<HTMLSelectElement>('[aria-label="单页翻译并发数"]')?.value,
    ).toBe('1');
  });
  it('retains the AI draft and gives reload guidance when the background returns null', async () => {
    const { storageSet } = mockExtension();
    view = await mount(<OptionsApp />);
    await input(view.container, '模型', 'unsaved-model');
    vi.mocked<(request: RuntimeRequest) => Promise<unknown>>(
      chrome.runtime.sendMessage,
    ).mockResolvedValueOnce(null);
    await click(view.container, '保存配置');
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(
      '扩展后台未返回有效响应',
    );
    expect(view.container.textContent).toContain('保留未保存的配置');
    expect(view.container.textContent).not.toContain("reading 'ok'");
    expect(view.container.querySelector<HTMLInputElement>('[aria-label="模型"]')?.value).toBe(
      'unsaved-model',
    );
    expect(view.container.textContent).toContain('未保存');
    expect(storageSet).not.toHaveBeenCalled();
    await click(view.container, '重试保存');
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
    expect(view.container.textContent).not.toContain('未保存');
  });
  it('separates editing from activation and preserves per-profile drafts across navigation', async () => {
    const { send } = mockExtension();
    view = await mount(<OptionsApp />);
    await input(view.container, '配置名称', '未保存的草稿');
    await input(view.container, '正在编辑的配置', 'second');
    expect(send).not.toHaveBeenCalled();
    await click(view.container, '阅读偏好');
    await click(view.container, 'AI 配置');
    await input(view.container, '正在编辑的配置', DEFAULT_SETTINGS.activeProfileId);
    expect(view.container.querySelector<HTMLInputElement>('[aria-label="配置名称"]')?.value).toBe(
      '未保存的草稿',
    );
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    await click(view.container, '放弃修改');
    expect(view.container.querySelector<HTMLInputElement>('[aria-label="配置名称"]')?.value).toBe(
      '默认配置',
    );
  });
  it('saves only the edited profile without testing or activating it', async () => {
    const { send, storageSet } = mockExtension();
    view = await mount(<OptionsApp />);
    await input(view.container, '正在编辑的配置', 'second');
    await input(view.container, '模型', 'new-model');
    await click(view.container, '保存配置');
    expect(
      send.mock.calls.find(([request]) => request.type === 'SAVE_TRANSLATION_PROFILE')?.[0],
    ).toMatchObject({
      type: 'SAVE_TRANSLATION_PROFILE',
      profile: { id: 'second', model: 'new-model' },
    });
    expect(storageSet).not.toHaveBeenCalled();
    expect(testTranslatorConfiguration).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'SET_ACTIVE_PROFILE' }));
    await click(view.container, '设为当前使用');
    expect(send).toHaveBeenCalledWith({ type: 'SET_ACTIVE_PROFILE', profileId: 'second' });
  });
  it('does not let a late connection response overwrite edited values or duplicate tests', async () => {
    mockExtension();
    let finish!: (value: string) => void;
    vi.mocked(testTranslatorConfiguration).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    view = await mount(<OptionsApp />);
    await click(view.container, '测试连接');
    expect(button(view.container, '测试中…').disabled).toBe(true);
    await input(view.container, '模型', 'changed-during-test');
    await act(async () => {
      await Promise.resolve();
      finish('旧测试译文');
    });
    expect(view.container.textContent).not.toContain('旧测试译文');
    expect(view.container.textContent).toContain('未测试');
    expect(testTranslatorConfiguration).toHaveBeenCalledOnce();
  });
  it('shows the actual test result without implying saved state', async () => {
    mockExtension();
    vi.mocked(testTranslatorConfiguration).mockResolvedValue('早上好。');
    view = await mount(<OptionsApp />);
    await input(view.container, '模型', 'edited');
    await click(view.container, '测试连接');
    expect(view.container.textContent).toContain('测试通过');
    expect(view.container.textContent).toContain('早上好。');
    expect(view.container.textContent).toContain('未保存');
  });
  it('supports first-run guidance, deferred validation, secret visibility and default prompt', async () => {
    mockExtension(DEFAULT_SETTINGS);
    view = await mount(<OptionsApp />);
    expect(view.container.textContent).toContain('连接你的第一个 AI');
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
    expect(view.container.querySelector('details')?.open).toBe(false);
    await click(view.container, '保存配置');
    expect(view.container.textContent).toContain('请填写模型名称');
    await click(view.container, '显示 API Key');
    expect(view.container.querySelector<HTMLInputElement>('[aria-label="API Key"]')?.type).toBe(
      'text',
    );
    await input(view.container, '自定义翻译 Prompt', 'Custom');
    await click(view.container, '恢复默认 Prompt');
    expect(
      view.container.querySelector<HTMLTextAreaElement>('[aria-label="自定义翻译 Prompt"]')?.value,
    ).toBe(DEFAULT_TRANSLATION_PROMPT);
  });
  it('autosaves preferences with an incomplete AI draft and retains failed input for retry', async () => {
    const { send } = mockExtension(DEFAULT_SETTINGS);
    view = await mount(<OptionsApp />);
    await input(view.container, '模型', 'unfinished-draft');
    await click(view.container, '阅读偏好');
    send.mockRejectedValueOnce(new Error('写入失败'));
    await input(view.container, '目标语言', 'Japanese');
    expect(view.container.textContent).toContain('写入失败');
    expect(view.container.querySelector<HTMLSelectElement>('[aria-label="目标语言"]')?.value).toBe(
      'Japanese',
    );
    await click(view.container, '重试保存');
    expect(send).toHaveBeenCalledWith({
      type: 'UPDATE_READING_PREFERENCES',
      patch: { targetLanguage: 'Japanese' },
    });
    expect(send).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'SAVE_TRANSLATION_PROFILE' }),
    );
    await click(view.container, '仅译文');
    expect(view.container.querySelector('[data-reading-preview]')?.textContent).not.toContain(
      'Reading opens',
    );
    await click(view.container, 'AI 配置');
    expect(view.container.querySelector<HTMLInputElement>('[aria-label="模型"]')?.value).toBe(
      'unfinished-draft',
    );
  });
  it('adds and removes site rules with conflict explanations', async () => {
    const { send } = mockExtension({ ...READY_SETTINGS, excludedSites: ['*.example.com'] });
    view = await mount(<OptionsApp />);
    await click(view.container, '站点规则');
    await input(view.container, '自动翻译域名', 'news.example.com');
    await click(view.container, '添加自动翻译站点');
    expect(send).toHaveBeenCalledWith({
      type: 'UPDATE_SITE_RULE',
      rule: { list: 'autoTranslateSites', hostname: 'news.example.com', enabled: true },
    });
    expect(view.container.textContent).toContain('不翻译优先');
    await click(view.container, '删除自动翻译站点 news.example.com');
    expect(send).toHaveBeenCalledWith({
      type: 'UPDATE_SITE_RULE',
      rule: { list: 'autoTranslateSites', hostname: 'news.example.com', enabled: false },
    });
  });
  it('requires confirmation for deleting an inactive profile', async () => {
    const { send } = mockExtension();
    view = await mount(<OptionsApp />);
    expect(button(view.container, '删除配置').disabled).toBe(true);
    await input(view.container, '正在编辑的配置', 'second');
    await click(view.container, '删除配置');
    expect(view.container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(send).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'DELETE_TRANSLATION_PROFILE' }),
    );
    await click(view.container, '确认删除');
    expect(send).toHaveBeenCalledWith({ type: 'DELETE_TRANSLATION_PROFILE', profileId: 'second' });
  });
});
