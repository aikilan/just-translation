# 全文完整翻译：独立深度审查

> 本文记录修复前的问题与证据；已按后续授权完成修复，当前结果见 [修复与验收记录](../full-document-fixes/README.md)。

2026-09-14。审查对象为 `/Users/jintao.xu/Documents/只是翻译` 中，相对 `main` / `d7e5ef0801fdd54364da7d79bfff37cfdb96c7d6` 的未提交变更，包括新增全文模块和测试。没有修改业务实现；本目录保存本轮审查的复现与证据。

确认 3 个 P2 行为问题、1 个 P3 协议校验缺口。现有 `pnpm check` 全部通过，不能据此排除下面的失败边界。

## 1. [P2] 正文外的连续变化会使全文翻译失败

位置：`src/content/full-document-task.ts:202-215`。

`assertSnapshot()` 观察整个 `document.body`，除扩展译文节点外，任意 childList、characterData 或指定属性变化都会令 `changed=true`。即使重新采集到的正文数量、元素、顺序和文本全部一致，连续三次扫描碰到无关变化后仍抛出“正文已变化”。导航、广告或其他被采集规则排除的区域也会触发此路径。

本轮有两层复现：

- 行为测试：全文请求已经发出，保持 main 原文不变，仅在每次校验扫描期间更新外部 nav 的 class；本应完成，实际为 error，6 段全部作废。测试先排除扩展反馈节点，断言前后正文文本完全相同。
- 真实扩展：106 单元正文、导航每 4 ms 更新一次 class，只有 1 次 HTTP 请求，响应完整但结果被丢弃。改为正常 `requestAnimationFrame` 动画，606 单元正文也稳定失败；4 秒计得 240 帧。停止该动画后，重新全文翻译同一正文，一次请求完成 606 段。

影响：较长正文所在页面只要同时存在持续更新的导航/广告，就可能无法完成全文翻译，用户每次重试都重复发送和等待整篇请求。

建议：保留扫描期间插入正文的防护，但让失效判定对应实际阅读单元及其采集资格；无关排除区域的变化不应直接否决已验证一致的正文快照。补充“无关动画持续更新仍能完成”和“真实正文在已扫描分支插入仍失败”这对测试。

[失败截图](navigation-mutation-error.png)。

## 2. [P2] 迟到的自动翻译会覆盖用户选择的全文模式

位置：`src/content/controller.ts:245-247`；调用方 `src/content/auto-start.ts:18-22`。

`tryStartAutomaticTranslation()` 在启动时异步读取设置，响应返回后直接调用 `controller.start()`。新增的 `start()` 分支会无条件恢复并移除当前全文任务，然后启动分段翻译。它无法区分用户主动选择普通翻译与页面启动时迟到的自动行为。

复现顺序：精确域名已开启自动翻译 → 暂缓启动时的设置响应 → 用户启动全文翻译并发出全文请求 → 释放自动翻译设置响应。最终页面为 `mode=segmented, phase=complete, translated=6`，而不是 full-document。这由真实控制器和原有 auto-start 函数组成的行为测试复现，后台消息为模拟响应；没有把该项表述为自然浏览器操作的时序复现。

影响：用户明确选择“保留上下文”后，仍可能被静默切回分段请求；全文任务被取消，并可能重新开启普通模式的动态补译。

建议：自动启动在异步响应后再次确认它仍有启动资格，且期间没有更新的用户操作；显式“切回普通翻译”应继续允许替换全文任务。用可失效的启动意图或控制器状态守卫处理，不能简单禁止所有 full → segmented 切换。

## 3. [P2] 已标记正文跳过结构采集，可能按过时的段落边界回填

位置：`src/content/dom-translator.ts:209-215`；全文调用设置 `includeTranslatedSources: true`。

采集器遇到 `data-justranslate-source` 时直接返回这个元素并跳过子树。首个正文单元在显示加载提示时就带上该标记；回填准备阶段所有单元都会带上。快照随后只比较旧元素及平铺文本，因此无法发现这些单元内部新增的段落边界。

复现：开始时第一个 div 为 `First paragraph. Second paragraph.`，后面还有一个 p，共 2 单元。等待请求时，页面把该 div 改成 `<p>First paragraph. </p><p>Second paragraph.</p>`，没有改变平铺字符。实际正文已有 3 段，旧任务仍报告完成 2 单元，按旧边界回填，并在仅译文模式隐藏新的两个原文段落。

行为测试与真实扩展均复现。对照：恢复原文后重新全文采集，同一页面发出的请求含 3 个独立 ID，证明是带标记分支跳过采集造成的漏检。

影响：在请求期间进行 hydration、段落排版或块结构替换的页面上，译文可能合并本应独立的段落，破坏“正文增删变化后放弃旧结果”的承诺。

建议：忽略扩展自己的 wrapper/反馈，但仍重新检查真实原文子树的阅读单元边界与采集资格。不能把“此前是一个 source”当作“现在仍是同一个阅读单元”的证明。补充上述结构变化和“仅插入无意义 inline wrapper 不应失败”的对照测试。

[错误回填截图](structural-change-accepted.png)。

## 4. [P3] 重复 translations 字段可绕过全文最终完整性校验

位置：`src/shared/openai-client.ts:67-79`；复用解码器 `src/shared/openai-stream.ts:190-207`。

全文入口把流式回调累计的 ID 数量作为最终结果完整性的依据；解码器在根对象结束时只确认 `translations` 是数组，没有确认这一字段只出现过一次。

正常 SSE 结束的下面一份响应会被接受：

```json
{"translations":[{"id":"p","text":"译文"}],"translations":[]}
```

最终对象按常见 JSON 解析语义的 translations 是空数组，但早先回调已经留下 `{p: "译文"}`，全文入口直接成功。独立复现测试要求拒绝，实际 Promise resolved。另测两个串接根对象，当前实现正确拒绝；没有将其误报。

影响仅限这种异常、含歧义的模型输出，因此优先级低于前三项。这是既有流式解码器被新全文入口复用后暴露的校验缺口；本轮没有把整个解码器误称为新增实现。

建议：拒绝重复的根 translations 字段，保证用于全文提交的 ledger 与唯一的最终 translations 数组一致。继续复用现有 JSON 库，不修复或猜测异常 JSON。

## 检查范围与证据边界

审查链路包括右键入口、页面命令、两种模式的切换、正文采集/保护标记/恢复、快照复核、分帧回填、后台可信会话、队列/取消/超时、HTTP/SSE 限额和解析、弹窗状态以及本轮设置保存修正。

| 检查 | 本轮结果 |
| --- | --- |
| `pnpm check` | 37 个测试文件、313 项测试通过；ESLint、TypeScript、构建及入口校验通过 |
| `git diff --check` | 通过 |
| 新增审查复现 | 5 项断言：4 项暴露缺陷，1 项协议对照通过 |
| 隔离扩展 | Chromium 153.0.8010.12，独立目录 `/tmp/just-translate-review-20260914`，加载重新构建的 dist |
| 浏览器驱动方式 | 通过真实扩展消息驱动控制器；读取真实 DOM 与模拟 HTTP 服务统计；本轮未重复原生右键菜单验收 |
| 请求 | 仅访问本地模拟 SSE API，不读取用户配置、不调用真实 AI |
| 语义质量 | 没有验证实际模型的跨段指代或术语质量 |
| 清理 | 已关闭本轮隔离浏览器并停止本地模拟服务；复现测试从 src 移出，不改变正常测试集 |

本轮未发现新的配置保存缺陷。属性顺序修正比较的是同一标准化结构；现有测试同时覆盖键顺序不同但值一致，以及实际字段丢失/变更时仍报错。密钥留在后台、全文不走段落缓存、不自动重试、正常末尾到达前不提交的已有测试也随完整检查通过。这里的通过仅描述已检查范围，不代表上述四个边界已通过。

原始输出：[完整检查](check.txt)、[生命周期复现](reproductions.txt)、[协议复现](protocol-reproductions.txt)、[浏览器记录](browser-results.json)。

## 运行复现测试

复现文件以 `.txt` 保存，避免将预期失败的审查测试混入日常 `pnpm check`。以下临时目标文件本轮结束时均不存在。将文件复制回各自目录后，4 个缺陷用例在当前实现下应失败，两个根对象的对照应通过：

```sh
cp artifacts/full-document-review/reproductions.test.ts.txt src/content/full-document-review.test.ts
cp artifacts/full-document-review/protocol-reproductions.test.ts.txt src/shared/full-document-protocol-review.test.ts
pnpm exec vitest run src/content/full-document-review.test.ts src/shared/full-document-protocol-review.test.ts
```

检查后删除这两个临时副本即可恢复正常测试集。修复时再将对应用例整理进正式测试文件。
