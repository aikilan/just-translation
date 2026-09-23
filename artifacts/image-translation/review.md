图片翻译深度审查，2026-09-23

更新：下列两项问题已修复，并通过新增回归及实际扩展验收。修复结果与证据见 [fixes.md](./fixes.md)。下文保留修复前的审查记录。

审查对象：基于 `bcf0f718da44037ce08c7a4150551987eab39a09` 的当前工作区图片翻译变更，包括新增文件。审查未修改业务代码。

发现 2 项应修复的问题。

1. **P1：新增本地图片向宿主网页暴露完整内容。** `src/content/quick-image-input.tsx:25` 把完整 Base64 写入预览图片的 `src`；承载弹窗的 `src/content/quick-translation-dialog.tsx:33` 使用开放 Shadow DOM。宿主网页主世界脚本可以在用户点击翻译前读取这个属性，获得本地文件内容，关闭弹窗后保留的草稿仍可读取。扩展隔离世界只隔离 JavaScript 全局变量，并不隔离共享 DOM；参见 [Chrome 官方说明](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts#communication_with_the_embedding_page)。应先补充网页主世界无法读取附件内容的回归测试，再调整图片选择与预览的隔离边界，避免在宿主可访问的节点或属性中保留文件字节。仅替换为宿主仍可读取的 Blob URL 或 canvas 不能建立该边界。

   复现使用独立临时 Chrome for Testing 配置加载实际 `dist` 扩展，在 `ISOLATED` 世界调用生产快捷翻译入口。向生产文件输入框提供一张浏览器生成的 9944 字节 PNG 后，网页主世界观察到：扩展全局入口不可见（`undefined`），但 `document.querySelector('[data-justranslate-quick]').shadowRoot.querySelector('.quick-attachment img').src` 返回完整 Data URL，包含 13260 个 Base64 字符；当时翻译接口请求数为 0。未使用用户图片或向外部发送测试数据。

2. **P2：`gpt-5.6` 被错误标为未知，导致支持图片的内置模型没有入口。** `src/shared/image-capabilities.ts:53` 至 `:59` 将其列为 `unknown`。当前 [OpenAI 官方 GPT-5.6 Sol 文档](https://developers.openai.com/api/docs/models/gpt-5.6-sol) 明确说明 `gpt-5.6` 路由到 GPT-5.6 Sol，并列出图片输入支持。实测同一官方地址、同一协议下，`gpt-5.6` 返回 `mode: catalog, supported: false`，`gpt-5.6-sol` 返回 `true`；即使保存 `imageInputEnabled: true`，前者仍返回 `false`，且自动模式的设置开关不可手动覆盖。应增加此官方别名的能力回归测试，将其列为支持，并更新原验收记录中“无法确认”的结论。

审查覆盖了以下链路：

- 内置能力表、官方地址归一化、协议匹配、手动能力设置、编辑后重置、配置保存与公共元数据。
- 文件签名、大小、解码、尺寸、WebP 转换、后台再次校验、文件内容生命周期与网页隔离。
- 快捷翻译本地状态、模型切换、仅图片/附加文字输入、空结果、结果校验、异步解码失效处理。
- OpenAI/Anthropic 内容块、共享鉴权与思考参数、SSE 解析、HTTP 错误、重试、限流、超时。
- 请求身份注册、取消、导航、标签关闭、后台生命周期，以及共享文字/划选服务重构的回归范围。
- 设置类型、会话序列化、五种界面语言、打包入口和新增测试的覆盖边界。

重新执行 `pnpm check` 成功：81 个测试文件、968 项测试，ESLint、TypeScript、Vite 构建和扩展构建结构检查全部通过；`git diff --check` 通过。检查输出见 [review-check.txt](./review-check.txt)。现有测试没有覆盖上述图片隔离边界，也没有核对 GPT-5.6 别名的官方语义，因此通过结果不意味着这两项问题不存在。

本轮实际扩展验收使用生产内容脚本、Chrome runtime 消息和扩展 Service Worker，通过本地 HTTP 服务返回固定 SSE。观察结果：

| 场景 | 结果 |
| --- | --- |
| PNG / OpenAI | 完整生产链路返回文字结果 |
| JPEG / Anthropic | 完整生产链路返回文字结果 |
| WebP / OpenAI | 浏览器转为 PNG，后台实际解码并返回结果 |
| 切换到文字模型 | 文件入口隐藏、预览保留、提交禁用 |
| 关闭慢请求 | 服务器记录 1 次连接取消 |
| 宿主 `img-src 'self'` | 实际扩展预览正常，未发生 CSP 违规，不列为缺陷 |

本地服务共记录 4 次请求：OpenAI 3 次、Anthropic 1 次，媒体类型依次为 PNG、JPEG、PNG、PNG，取消 1 次。此前普通网页 fixture 下的 CSP 拦截不能直接代表扩展隔离世界，已用实际扩展反证并排除。

验证边界：未调用真实供应商 API，未验证实时账号可用性或实际识别、翻译质量。审查时两项问题尚未修复；后续修复状态见文首更新。
