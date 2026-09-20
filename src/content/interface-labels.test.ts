// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import {
  collectTranslatableElements,
  collectOriginalReadingUnits,
  getElementSourceText,
  renderTranslation,
  renderTranslationError,
  renderTranslationPending,
  restoreDocument,
  setDocumentDisplayMode,
} from './dom-translator';
import { registerRetryInteractions } from './retry-interaction';

const collect = () => collectTranslatableElements(document.body, { isVisible: () => true });
afterEach(() => {
  restoreDocument();
  document.body.replaceChildren();
});

it('collects short labels, control text and form help while excluding protected regions', () => {
  document.body.innerHTML = `<nav><button>导航</button></nav><main>
    <div>班级管理</div><div><span>关联课程</span></div>
    <button><span>排课</span><svg><text>图标</text></svg><sup>2</sup></button>
    <button>OK</button><div role="menuitem">添加学员</div>
    <form><label>班级名称<input value="不翻译" placeholder="不翻译"></label><p>请选择班级</p></form>
    <p>正文 <a href="#">链接</a> 内容</p><code>代码</code><div translate="no">排除</div>
    </main><aside>侧栏</aside>`;
  expect(collect().map(getElementSourceText)).toEqual([
    '班级管理',
    '关联课程',
    '排课',
    'OK',
    '添加学员',
    '班级名称',
    '请选择班级',
    '正文 链接 内容',
  ]);
});

it('includes body portals beside main without admitting navigation menus', () => {
  document.body.innerHTML =
    '<main><p>正文内容</p></main><div role="dialog"><button>确定</button></div><div role="listbox"><div role="option">选项一</div></div><nav><div role="menu"><button>导航菜单</button></div></nav>';
  expect(collect().map(getElementSourceText)).toEqual(['正文内容', '确定', '选项一']);
});

it('shows only translated label text while preserving controls, icons, badges and focus', () => {
  document.body.innerHTML =
    '<main><button style="display:flex;height:32px;overflow:hidden"><span>创建班级</span><svg></svg><sup>2</sup></button><p>正文内容</p></main>';
  const button = document.querySelector('button')!;
  const icon = button.querySelector('svg')!;
  const badge = button.querySelector('sup')!;
  const click = vi.fn();
  button.addEventListener('click', click);
  button.focus();
  const original = button.outerHTML;
  const units = collect();
  expect(units.map(getElementSourceText)).toEqual(['创建班级', '正文内容']);
  renderTranslation(units[0], 'Create class');
  renderTranslation(units[1], 'Article');
  setDocumentDisplayMode('bilingual');
  expect(button.textContent).toBe('Create class2');
  expect(getElementSourceText(units[0])).toBe('创建班级');
  expect(units[1].querySelector('[data-justranslate-source-content]')?.hasAttribute('hidden')).toBe(
    false,
  );
  expect(icon.closest('[hidden]')).toBeNull();
  expect(badge.closest('[hidden]')).toBeNull();
  expect(button.style.cssText).toBe('display: flex; height: 32px; overflow: hidden;');
  expect(document.activeElement).toBe(button);
  button.click();
  expect(click).toHaveBeenCalledOnce();
  expect(collectOriginalReadingUnits(document.body, { isVisible: () => true })).toEqual(units);
  restoreDocument();
  expect(button.outerHTML).toBe(original);
});

it('keeps failed controls usable without nested retry interactions', () => {
  document.body.innerHTML = '<main><button>添加学员</button></main>';
  const [source] = collect();
  expect(source).toBeDefined();
  const button = document.querySelector('button')!;
  const businessClick = vi.fn();
  const retry = vi.fn();
  button.addEventListener('click', businessClick);
  const unregister = registerRetryInteractions(retry);
  try {
    renderTranslationPending(source, 'label');
    setDocumentDisplayMode('translation');
    expect(source.querySelector('[hidden]')).toBeNull();
    const error = renderTranslationError(source, 'label');
    expect(error.hasAttribute('tabindex')).toBe(false);
    expect(error.getAttribute('role')).not.toBe('button');
    error.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(retry).not.toHaveBeenCalled();
    expect(businessClick).toHaveBeenCalledOnce();
    expect(button.textContent).toBe('添加学员');
  } finally {
    unregister();
  }
});

it('keeps prose around embedded controls and direct form instructions', () => {
  document.body.innerHTML =
    '<main><p>先选择 <button>班级</button> 再提交。</p><form>填写说明<input value="保留"></form></main>';
  expect(collect().map(getElementSourceText)).toEqual(['先选择', '班级', '再提交。', '填写说明']);
});

it('does not hide a sibling icon or badge in a compact filter label', () => {
  document.body.innerHTML =
    '<main><div style="display:flex">关联课程<svg></svg><sup>2</sup></div></main>';
  const owner = document.querySelector('main > div')!;
  const [source] = collect();
  expect(getElementSourceText(source)).toBe('关联课程');
  renderTranslation(source, 'Course');
  setDocumentDisplayMode('bilingual');
  expect(owner.querySelector('svg')!.closest('[hidden]')).toBeNull();
  expect(owner.querySelector('sup')!.closest('[hidden]')).toBeNull();
  expect(owner.textContent).toBe('Course2');
});

it('allows React to remove conditional direct button text after translation', async () => {
  const { createElement, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('main');
  document.body.append(host);
  const errors: unknown[] = [];
  const root = createRoot(host, {
    onUncaughtError: (error) => {
      errors.push(error);
    },
  });
  const content = (show: boolean) =>
    createElement('button', null, show ? '创建班级' : null, createElement('svg', { key: 'icon' }));
  try {
    await act(async () => {
      await Promise.resolve();
      root.render(content(true));
    });
    const [source] = collect();
    renderTranslation(source, 'Create class');
    setDocumentDisplayMode('bilingual');
    await act(async () => {
      await Promise.resolve();
      root.render(content(false));
    });
    expect(errors).toEqual([]);
    expect(host.querySelector('button svg')).not.toBeNull();
  } finally {
    await act(async () => {
      await Promise.resolve();
      root.unmount();
    });
    vi.unstubAllGlobals();
  }
});

it('preserves disabled buttons while translating their labels', () => {
  document.body.innerHTML = '<main><button disabled>创建班级</button></main>';
  const button = document.querySelector('button')!;
  const click = vi.fn();
  button.addEventListener('click', click);
  const [source] = collect();
  renderTranslation(source, 'Create class');
  setDocumentDisplayMode('bilingual');
  expect(button.disabled).toBe(true);
  button.click();
  expect(click).not.toHaveBeenCalled();
  restoreDocument();
  expect(button.textContent).toBe('创建班级');
  expect(button.disabled).toBe(true);
});

it('applies the same content scope to initial and local scans, including approved portals', () => {
  document.body.innerHTML =
    '<div id="outside"><button>账号管理</button></div><main><button>创建班级</button></main><div role="menu"><button>选项</button></div>';
  const outside = document.querySelector<HTMLElement>('#outside')!;
  expect(collectTranslatableElements(outside, { isVisible: () => true })).toEqual([]);
  expect(
    collectTranslatableElements(document.querySelector('[role="menu"]')!, {
      isVisible: () => true,
    }).map(getElementSourceText),
  ).toEqual(['选项']);
});

it('keeps local scope fallback consistent when main contains no readable text', () => {
  document.body.innerHTML =
    '<main><input value="excluded"></main><article><p>文章内容</p></article><div id="outside"><button>账号管理</button></div>';
  expect(collect().map(getElementSourceText)).toEqual(['文章内容']);
  expect(
    collectTranslatableElements(document.querySelector('#outside')!, { isVisible: () => true }),
  ).toEqual([]);
});

it('keeps flex prose runs identical in read-only and materialized collection', () => {
  document.body.innerHTML =
    '<main><p style="display:flex">先选择 <button>班级</button> 再提交。</p></main>';
  const readOnly = collectOriginalReadingUnits(document.body, { isVisible: () => true }).map(
    (unit) =>
      unit instanceof HTMLElement
        ? getElementSourceText(unit)
        : unit.nodes
            .map((node) => node.textContent)
            .join('')
            .trim(),
  );
  expect(readOnly).toEqual(['先选择', '班级', '再提交。']);
  expect(collect().map(getElementSourceText)).toEqual(['先选择', '班级', '再提交。']);
});
