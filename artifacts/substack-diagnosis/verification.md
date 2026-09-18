# 修复与验收

2026-09-17。保留工作区原有修改，未提交 Git，未修改模型配置。生产构建输出已更新到 `dist`。

## 改动

- 将子树能否遍历与元素自身是否可读分离：穿过 `display: contents` 和隐藏但允许后代恢复可见的容器；过滤 display:none、content-visibility:hidden、opacity:0 和关闭 details 的隐藏内容。visibility:collapse 的自身文字也排除。
- 优先正文范围检查祖先，避免隐藏 main 抢占其他可见 article。
- flex/grid 直接文字、独立行内元素及混排文字均有归属；语义段落里的链接、强调和周围文字仍构成同一个句子。
- 视口优先级不再使用 display:contents 祖先的空矩形裁剪。
- 原有元素不再全部搬入包装 span，保持直接子选择器及事件节点；仅直接 Text 节点需要可恢复的隐藏锚点。原有 hidden 值及内联 SVG 也正确隐藏/恢复。
- 只对已经选中的正文单元解除自身高度、overflow、行数截断，给 flex/grid 译文提供换行位置，保留外围布局与滚动限制。恢复时保留网页在翻译期间自行做出的样式修改。
- 原文读取、同步提交校验及显示模式切换同步使用新的内容结构。
- 动态发现覆盖自定义属性、details open、transitionend、animationend、toggle；原文子元素样式导致文字变化时重新翻译。过滤扩展自身属性，避免把渲染当成新业务内容。

## 自动检查

先编写失败回归再实现。新增 `style-boundaries.test.ts` 26 个测试，并在控制器测试中增加 5 个动态样式测试；更新全文翻译测试中已过时的“grid 必须丢失阅读资格”假设及包装节点数量断言。

最终 `pnpm check` 全部通过：

- ESLint。
- Vitest：49 文件，582 测试。
- TypeScript `tsc --noEmit`。
- Vite 生产构建。
- 后台 bundle 连接校验。
- `git diff --check` 通过。

原有样式读取次数回归仍通过，没有放宽性能断言。

## 真实浏览器

目标页面 DOM 模块验收使用固定测试译文，不调用真实模型：

- 页面 21 个正文段落全部独立识别，未把整篇文章合成外层单元。
- 双语模式插入 21 个独立、可见的段落译文。
- 只看译文模式下 21 个译文仍可见，原文提取保持完整。
- 恢复原文后 `.body.markup.innerHTML` 与操作前完全一致，链接节点及其父节点身份保持一致。
- 结果见 `substack.fixed.results.json`。

隔离 Chromium 样式测试：17 个发现场景、7 个渲染场景及 2 个额外检查。固定高度/截断和 flex/grid 的译文均位于原文下方且处在展开后的正文单元内；直接子选择器的字重保持 700；contents+overflow 场景正确识别为当前视口。结果见 `style-boundaries.fixed.results.json`。

## 范围

这次验证覆盖当前源码、构建产物及浏览器 DOM 行为，没有验证用户已安装扩展的重新加载状态或真实模型服务。需在浏览器中重新加载扩展并刷新目标页面后使用新构建。

局部展开针对已确认的正文单元自身裁剪，不会全局撤销宿主祖先容器的布局/滚动约束；CSS 生成内容、任意祖先 clip-path/paint containment 等未列入本次验收。
