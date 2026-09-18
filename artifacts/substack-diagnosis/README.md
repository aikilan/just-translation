# Substack 正文翻译识别诊断

修复已完成，见 [修复与验收](verification.md)。以下保留修复前的诊断证据。

- 页面：https://etymology.substack.com/p/lolcow-theory-of-the-internet
- 检查时间：2026-09-17（Asia/Shanghai）
- 源码：当前工作区，HEAD `677d44a`；保留已有未提交修改，未修改生产代码。

## 已确认的原因

正文祖先 `.pencraft.pc-display-contents.pc-reset.pubTheme-yiXxQA` 的计算样式为 `display: contents`，`getClientRects().length` 为 0，而内部文章和 21 个正文段落正常有布局矩形。

`src/content/dom-translator.ts:786` 的 `isElementVisible` 将该容器判为不可见。遍历器在第 255 行直接剪掉其子树，所以文章里的段落不会成为阅读单元。外层 `.single-post` 没有被子阅读单元占用，随后被误选为一个大阅读单元；文本提取使用另一套规则，能穿过 contents 容器，因此仍会提取整篇文字。这是段落边界丢失，不等同于完全没有提交任何正文文字。

渲染器将原节点放进 source-content，再把译文追加到该阅读单元末尾。结果是整篇译文/加载状态位于 `.single-post` 底部，而各正文段落旁没有对应翻译。

## 实际页面验证

将当前源码中的 DOM 模块独立打包，在 Playwright 打开的目标页面执行，不调用模型接口，不改用户扩展配置。

1. 只读提取：默认规则得到 1 个单元 `.single-post`，正文独立段落 0 个。
2. 对照：只通过诊断参数让 `display: contents` 容器继续遍历，得到 51 个页面阅读单元，其中 21 个正文段落全部识别，文章内部共 27 个单元。
3. 执行实际 `discoverTranslatableElements`：得到 1 个 `.single-post`，提取文字长度 7092，包含 21 个正文段落。
4. 在该单元调用 `renderTranslationPending` 后立即 `restoreDocument`：状态节点位于文章之后，正文段落内状态/译文节点数为 0。初始视口高度 1228px，节点 top 约 4068px。

这确认了当前源码对真实页面的提取与插入位置缺陷。没有检查用户已安装扩展版本，也没有实际调用用户模型，不能据此认定其 API 请求成功或失败。

## 测试证据

先添加最小复现测试，再运行诊断。用 `getClientRects` mock 模拟真实浏览器测得的盒模型事实，断言应该选中段落而非外层容器：

- `display: block`：通过。
- `display: none`：通过，仍跳过隐藏内容。
- `display: contents`：失败，期望 `<p>`，实际错误选择外层 `<div role="main">`。
- 现有 `src/content/dom-translator.test.ts`：30/30 通过。大量已有用例注入 `isVisible: () => true`，未覆盖此处浏览器布局判断。

测试保存在 `display-contents.repro.test.ts.txt`，避免分析任务遗留一个默认测试集自动执行的失败用例。需要复跑时，在此目录复制为 `.test.ts` 后执行 `pnpm exec vitest run artifacts/substack-diagnosis/display-contents.repro.test.ts`，完成后删除临时 `.test.ts`。

## 修复方向

修复通用遍历规则：不能因为容器自身没有布局盒就剪掉可见后代；允许穿过 `display: contents`，由后代承担正文单元。保留隐藏节点、控件、代码和禁止翻译区域的过滤，并验证普通模式与全文模式使用的共同提取规则。无需为 Substack 域名增加专用选择器。

正式修复需要将复现加入正常测试集，并覆盖 contents 嵌套、隐藏后代、可见段落独立渲染及无重复祖先单元，再做真实浏览器验证。
