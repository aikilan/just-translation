# 可视区优先调度 Review

> 后续状态：以下两处问题已修复，见 [修复验证](fix-verification.md)。本文保留修复前的审查证据。

日期：2026-09-15。审查对象：`main` / `5ffcee5` 之上的当前未提交实现。未修改产品实现。

## 结论

确认两处 P1 回归，会让翻译无法继续，并使完成等待陷入没有任务切换的微任务循环。现有 355 项测试和先前 100 段浏览器验收未覆盖这两类输入。

### P1：屏外同文副本被纳入可视区完成条件

位置：`src/content/controller.ts:1441-1450`。

最小 DOM 顺序：

1. 屏外独立段落 A。
2. 屏外段落 B。
3. 可视段落 B，与第二段原文相同。

B 去重后共用一个 `visible` 翻译组。B 返回后，可视副本正常显示；屏外副本在 background 渲染队列中等待 A，仍处于 `pending`。`canDispatchBackground` 检查整个可视组的所有成员，因此要求屏外 B 先渲染才允许 A 解析/请求；B 又必须等 A 才能渲染，形成循环等待。

实测：当前版本只请求 B，状态停在 `translated=1,total=3,phase=translating`；同一回归用例在基线版本请求 A 和 B，并完成三处渲染。

修复方向：区分翻译请求组的优先级与具体 DOM 节点的渲染完成条件，只让当前可视成员阻塞屏外放行，保留组内长文本分片完整性和在途请求的等待语义。

### P1：原文在候选解析期间变化，留下永远不能完成的 queued 记录

位置：`src/content/controller.ts:806-815`；相关条件在 `1432-1450`，失效分支在 `1281-1284`。

可视原文在 `RESOLVE_TRANSLATION_CANDIDATES` 未返回时被网页改写。解析返回后，`applyCandidateResolution` 只标记 render slot 为 skipped 并标记 stale，没有终结对应 `queued` 记录。新屏外放行条件始终将这个记录视作未完成可视任务。

此时没有 scheduler 工作，但仍有 deferredGroups。完成循环反复等待已经空闲的 scheduler/render queue，所有 Promise 都立即完成，无法退出到 stale 重扫，也不给动态内容的 800ms 定时器执行机会。

实测：动态翻译开、关两种设置均复现，屏外请求数为零。基线版本能完成屏外翻译并退出；基线对变化原文本身已有漏翻，因此本次回归结论仅针对新增的全局阻塞与忙循环，不把旧漏翻归因于本次改动。

修复方向：失效候选必须终结或移除旧记录，让 stale 重扫能开始；控制层仍有延期任务时，不能仅用 scheduler 空闲作为立即重试完成循环的依据。

## 回归证据

- [复现用例](reproductions.test.ts.txt)
- [当前实现结果](current-results.txt)：3 项失败，全部触发循环保护。
- [基线结果](baseline-results.txt)：同样 3 项回归断言通过。

为避免真正的微任务死循环卡住测试进程，用例只在第 50 次 `waitForIdle()` 时主动停止控制器。保护触发前没有改变调度结果；基线分别只等待 4、4、2 次，不触发保护。

复跑：将复现文件临时复制为 `src/content/viewport-review.test.ts`，运行 `pnpm exec vitest run src/content/viewport-review.test.ts --reporter=verbose`。审查结束后已将临时测试移回证据目录，不改变正式测试集。
