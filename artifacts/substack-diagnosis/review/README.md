# 样式修复复核

2026-09-17。仅审查上一轮样式修复，未修改生产代码，也未混入工作区已有的模型协议、设置、重试等变更。

## 结论

发现 4 个确定回归，均在真实 Chromium 中用当前与修复前 DOM 模块对照复现。修复前 DOM 模块取自 HEAD `677d44a`；相关依赖复用当前工作区，四个对照用例均不依赖本次 viewport 改动。

### P1：移动原文节点后无法恢复显示

位置：`src/content/source-presentation.ts:106-111`。

`prepareSourcePresentation` 对原有元素直接写入标记并保存 hidden 状态，translation-only 模式对这些原元素设置 hidden。网页随后将 em 移到另一个容器，restore 只查询当前 source 的直接子节点，因此不再能找到被移走的元素。浏览器实测恢复后仍为 `hidden=true`、不可见且保留 `data-justranslate-source-content`。

控制器集成复现让 MutationObserver 和动态重扫运行 1 秒后再 restore，仍失败。修复前隐藏的是原文包装容器，被移动的原元素本身没有 hidden，因此该场景正常。

建议：按源单元记录实际受控节点集合，节点离开原容器时清理自己施加的状态；恢复不能仅依赖当前 DOM 位置。

### P2：同文本原文元素被替换后，translation-only 仍显示原文

位置：`src/content/source-presentation.ts:85-88`，关联 `controller.ts:1811-1816`。

开始翻译 `<p><em>Visible original paragraph.</em></p>` 后，网页将 em 替换成同文本的 strong。新节点没有 source-content 标记，也没有 hiddenStates 记录。控制器看到原文字符串没变且译文仍在，会提前跳过更新；切换 translation-only 时没有任何逻辑隐藏新 strong。

真实浏览器结果为新原文节点仍可见。控制器处理动态更新后同样复现。修复前新 strong 仍在统一原文包装容器内，会随容器一起隐藏。

建议：正文文字相等不能代表渲染所有权没有变化，必须核对并同步当前原始子节点集合。

### P2：完全不可见的 main 抢占可见 article，导致整篇漏译

位置：`src/content/dom-translator.ts:230-232`，关联 `456-464`。

页面同时包含 `main style="visibility:hidden"`（没有恢复可见的后代）与外部可见 article 时，新代码用 canTraverseReadingSubtree 决定优先 main 范围。visibility:hidden 允许遍历，所以 main 被选中；遍历后没有任何可读单元，也不会扫描外面的 article。真实浏览器当前识别结果为空，旧版识别到可见正文。

建议：优先范围必须依据可读后代选择，不能用“允许遍历”的判据代替“确实包含可读正文”。

### P2：恢复时丢失 overflow 长写属性

位置：`src/content/source-presentation.ts:119-126`，关联 `47-55`。

原文内联样式为 `overflow-y:hidden;height:20px`。扩展写入 overflow 简写进行展开，但备份只记录 overflow 的字符串；仅指定一个长写属性时该字符串为空。网页在翻译期间设置 `color:red`，恢复便进入逐属性路径，删除 overflow，原来的 overflow-y 一并丢失。

Chrome 实测恢复后 `style.overflowY=""`、计算值 visible；旧版仍是 hidden，且两者均保留新 color。此用例在 jsdom 中通过，真实浏览器失败，说明 jsdom 的简写行为不足以覆盖该问题。

建议：按实际被覆盖的长写属性及优先级备份与恢复，同时保留网页后来修改的属性。

## 证据

- 当前 DOM 单元复现：4 用例，3 失败、1 通过（overflow 的 jsdom 行为未复现）。`current-results.txt`。
- 修复前 DOM 单元对照：4/4 通过。`baseline-results.txt`。
- 当前控制器集成复现：2/2 失败。`controller-results.txt`。
- Chromium 当前结果：四场景均失败。`browser-current.json`。
- Chromium 修复前对照：四场景均符合预期。`browser-baseline.json`。
- 浏览器脚本：`browser-repro.js.txt`。

测试与修复前模块保留为 `.ts.txt`，避免让 review 的预期失败用例进入默认测试集。复跑时在本目录复制成对应 `.ts` 文件，然后运行指定 Vitest 文件；用完移除临时 `.ts`。没有修改上一轮的生产实现。
