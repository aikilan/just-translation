# 内容区翻译修复 Review

2026-09-20，针对当前未提交实现。未修改生产代码。复现使用 jsdom 与模拟扩展消息，不涉及真实翻译 API。

## 已复现问题

1. **P2：全文交接后的 body 补扫可被持续 DOM 更新无限推迟。** `controller.ts:313` 将整页加入 dynamicRoots；`addDynamicRoot` 对该根内任何新变化刷新时间。导航中的 100ms ticker 连续更新时，新增按钮等待 2200ms 仍无译文；只要间隔始终小于 800ms，就不会进入队列。应将交接补扫与普通去抖分开，或设置不会被无关变化刷新掉的调度期限。
2. **P2：失败补译重试需要重扫时会恢复整页并切换普通模式。** 全文成功后新增段落失败，停止后重试；重试期间原文改变，触发 requiresRescan。单项／批量重试仍调用 `start()`，其全文分支先 `restore()`，最终 mode 变为 segmented，已有全文结果也被清理。应使用保留全文上下文的增量重扫入口。
3. **P2：网页写回相同标签时，原文和译文同时出现。** 原始 Text 从扩展写入的空串改回同一中文后，`acceptLabelHostMutation` 清除 applied 状态；`handlePageMutations` 因源文本未变直接 continue，没有重新应用标签隐藏。复现显示“普通译文 创建班级创建班级”。应在同文复用分支同步外部 Text 的呈现状态。
4. **P2：恢复原文会覆盖网页主动写入的空串。** 标签成功后，页面把原始 Text 明确设为空串，立即恢复；或者关闭动态翻译后清空再恢复，都会恢复成旧的“创建班级”。恢复只比较值是否等于 applied 空串，未保留网页写入归属；停止时还会丢弃未处理的 mutation。恢复前应处理所有权变更，且正确性不能依赖自动补译开关。
5. **P2：flex 语义段落中控件前后的正文仍被漏掉。** `<p style="display:flex">先选择 <button>班级</button> 再提交。</p>` 仅收集“班级”。创建的正文 reading-run 被 semantic flex 分支跳过，父段落又因拥有已采集控件而跳过。HEAD 对照会收集“先选择 再提交。”，确认本次增加控件采集后出现正文回归。
6. **P2／范围契约缺口：首次与动态采集不使用相同 main 范围。** main 外普通 div 中的按钮首次被排除，向该 div 新增按钮却会翻译。局部根扫描原先已有这个范围选择机制，本次开放控件后将原先始终排除的外部按钮纳入。应把首次确定的内容区与获准弹层范围用于动态扫描，不能对任意变更根重新退化为全根采集。

## 证据与复现

`reproductions-output.txt`：8 个用例，7 个失败、1 个通过。7 个失败覆盖上述 6 类问题（恢复问题分别测试动态开关开／关）；通过的用例是修改前 flex 正文行为对照。

复现步骤：将 `reproductions.test.ts.txt` 复制为 `src/content/interface-review.repro.test.ts`，将 `baseline-dom-translator.ts.txt` 复制为 `src/content/interface-review.baseline.ts`，执行 `pnpm exec vitest run src/content/interface-review.repro.test.ts`，完成后删除这两个临时文件。baseline 文件取自本次工作区 HEAD 的 DOM 采集器。

复现文件只以文本形式留在 artifacts 中，不影响正常测试发现。现有测试套件的复跑结果在本次任务最终回复中列明。
