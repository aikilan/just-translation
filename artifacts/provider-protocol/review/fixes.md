# Review 修复验收

日期：2026-09-17。仅修复本轮确认的五类问题；未提交、未发布。

- 自动思考：手动关闭后切回始终思考型号的自动模式，同步更新草稿，保存与重新打开保持开启；可关闭型号仍保留用户关闭状态。
- 地址草稿：放弃修改时清除该配置的地址编辑标记；恢复的官方预填地址可随协议切换，原有自定义地址继续保留。
- 预算请求：OpenAI 兼容协议启用预算时，明确发送用于预算校验的输出上限。关闭预算或切换控制方式后不再发送预算字段。
- 手动控制：手动 reasoning_effort 不再继承型号的默认开启假设；开启且未选强度时显式发送 low，自动模式保留官方默认规则。
- 型号上限：GPT-4.1、mini、nano 独立配置为 32768；GPT-4o 系列仍为 16384。来源：[GPT-4.1](https://developers.openai.com/api/docs/models/gpt-4.1)、[mini](https://developers.openai.com/api/docs/models/gpt-4.1-mini)、[nano](https://developers.openai.com/api/docs/models/gpt-4.1-nano)。

## 测试证据

先增加 17 个回归用例，覆盖上述问题及相邻边界。修改实现前，3 个目标测试文件为 9 失败、49 通过，失败覆盖全部五类问题；修复后 58 个用例通过。

`pnpm check`：48 个测试文件、550 个用例全部通过，ESLint、TypeScript、Vite 构建和后台 bundle 校验通过。`git diff --check` 通过。

隔离 Chromium 扩展浏览器使用新 profile 加载本次 dist，以下流程通过且没有 pageerror：

1. MiMo 保存官方 OpenAI 地址 → 编辑地址 → 放弃修改 → 切换 Anthropic → 保存 → 重新打开，地址与协议正确。
2. Grok 始终思考型号 → 手动 reasoning_effort → 关闭 → 自动 → 保存 → 重新打开，开关保持开启且禁用。
3. GPT-4.1 输出上限填 32768 → 保存 → 重新打开，保留正确数值。

本轮没有调用真实服务商 API。请求参数由自动测试验证，浏览器验收验证设置与持久化流程。
