# 其他样式边界分析

2026-09-17，使用当前 DOM 模块及 `src/content/styles.css`，在独立 Chromium about:blank 页面执行 17 个提取场景、3 个渲染场景和 2 个补充检查。先编写浏览器测试用例，再执行。未修改生产代码，未调用模型。结果见 `style-boundaries.results.json`，测试见 `style-boundaries.browser-test.js.txt`。

## 已复现

| 场景 | 当前结果 | 影响 |
| --- | --- | --- |
| display: contents 祖先 | 段落正常可见，但未选中 | 漏译或祖先吞并 |
| visibility: hidden 祖先，子段落 visibility: visible | 可见段落未选中 | 父级隐藏不能推出所有后代隐藏 |
| p 使用 display: flex/grid 且直接承载文本 | 可见段落未选中 | hasLayoutRisk 拒绝整个单元；没有子单元可接管 |
| flex 容器内 em 承载正文 | 未选中；span 对照正常 | 额外的 flex 子文本支持只覆盖 span |
| visibility: collapse | 不可见段落被选中，标记 visible 优先级 | 只过滤 hidden，没有覆盖 collapse |
| content-visibility: hidden | 不可见正文被选中，标记 visible 优先级 | 布局矩形存在不代表内容绘制 |
| opacity: 0 祖先 | 透明段落被选中，标记 visible 优先级 | 需要区分持久隐藏与动画过渡；不宜直接永久排除 |
| 固定 height + overflow: hidden | 插入译文全部位于源节点裁剪边界之外 | 识别成功但看不到译文 |
| -webkit-line-clamp: 1 + overflow: hidden | 插入译文全部位于源节点裁剪边界之外 | 行数限制与原文共享，译文被裁掉 |
| contents + overflow: hidden | 即使诊断中放开遍历，视口识别仍失败 | viewport.ts 用没有盒子的祖先边界进行裁剪 |
| p > .emphasis 直接子选择器 | 原文 font-weight 从 700 变 400 | 插入 source-content 包装层改变 DOM 选择器匹配；display: contents 不使 DOM 层级透明 |
| 关闭的 details | 隐藏内容仍被选中 | 非 CSS 属性，但说明盒矩形不是充分判据 |

固定高度/截断测试：源段落 bottom 为 28px，译文 top 为 35.21875px，overflow 为 hidden。普通段落对照会扩展到 47.21875px，译文处于源段落范围内。

这些是隔离测试确认的通用问题，不表示 Substack 页面同时触发了所有场景。该页面目前确认的触发因素仍是 display: contents。

## 正常或需要保留的行为

- display: none：隐藏子树未选中。
- visibility: hidden 且没有恢复可见的后代：未选中。
- flex 内 span：可以正常识别，不能笼统认定所有 flex 内容均失败。
- 零尺寸父级 + overflow: visible + 可见绝对定位子段落：可以识别；不要新增 width/height 为零就跳过子树的判断。
- transform 将段落移出屏幕：仍进入全文发现，但没有被分入当前视口，符合阅读优先级分工。
- content-visibility: auto 屏外正文：当前仍发现正文且归为非当前视口。不能把 auto 当 hidden 永久排除；读取几何信息是否抵消渲染优化还需性能测量。

## 代码中另一个需要验收的边界

动态观察器只监听 class/style/hidden/aria-hidden/lang/translate 等属性。`data-state`、details 的 open、祖先 html 属性及 CSS 动画引起的显隐不保证触发动态扫描；滚动、resize 和已发现元素的 IntersectionObserver 可覆盖其中部分情况。此处是源码确认的观察范围，尚未对无任何其他事件的控制器全过程做动态复现，不能报告成所有此类内容都会永久漏译。

## 修复设计判断

应分别回答：是否允许遍历后代、哪些文本组成一个翻译单元、当前视口优先级、译文应如何插入并显示。不要再用一个“元素可见”布尔值同时决定以上行为。

第一批优先修正文发现及优先级：contents 透明遍历、恢复可见的后代、隐藏内容排除、flex/grid 文本归属、无盒祖先不参与裁剪。读取片段的 analyzeFragments 也有 visibility:hidden 剪枝，需要同步评估。不能直接解除 flex/grid 限制后照旧插入块级译文，否则可能改变宿主布局。

第二批处理译文呈现：被裁剪的源节点、截断限制、直接子选择器受包装层影响。不要全局去掉宿主 overflow 或强制 height:auto，需要按可验证的插入策略处理。

最后补充动态显隐观察与真实浏览器回归；opacity 过渡和 content-visibility:auto 应维持可恢复、可重新扫描的语义。

参考：MDN visibility 文档明确说明后代可以通过 visibility:visible 恢复绘制；Element.getClientRects 文档描述的是边框盒集合，而不是用户可读性的完整判断。

- https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/visibility
- https://developer.mozilla.org/en-US/docs/Web/API/Element/getClientRects
- https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/content-visibility
