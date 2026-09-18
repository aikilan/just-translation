# 多供应商、双协议与思考设置验收

日期：2026-09-17。工作区原有修改保留；未提交、未发布扩展。

## 实现范围

- 9 个供应商及自定义；先选供应商，再选协议。新增配置默认 OpenAI Chat Completions，可选 Anthropic Messages。
- 官方地址预填、保留手填路径及查询参数、协议端点匹配检查、供应商变化清除旧密钥；本地型号建议与手填。
- 按供应商、协议、精确型号解析思考开关、强度及预算。未知型号不猜参数；手动策略只发送当前策略的参数。
- 共同翻译客户端负责映射、JSON 校验、重试、取消和发布，协议请求构造与 SSE 生命周期负责各自的 wire 差异；复用已有 eventsource-parser 和 @streamparser/json，没有引入 SDK 或另一套调度器。
- 普通、全文、选区、连接测试共用配置；缓存与配置指纹区分协议、最终端点、有效思考参数。会话冻结完整配置；旧会话缺少契约即失效。
- 旧配置不推断供应商，不迁移、不删除密钥、模型和 Prompt；标记待补全，补选保存后再开始新翻译。

## 自动验证

`pnpm check`：48 个测试文件、533 个用例通过；ESLint、TypeScript、Vite 构建、后台 bundle 连接校验通过。

`git diff --check`：通过。

新增用例覆盖供应商/协议/型号表、未知型号控制、始终思考、默认开启、强度/预算/输出上限、端点与鉴权、旧配置、保存失败保留、协议切换、UTF-8 单字节分块、思考后多个文本块、流内错误、块生命周期、提前断流、取消、只重试未完成段落、全文截断原子失败、缓存隔离与不可变会话。既有缓存优先渲染、批量重试、popup、选区和调度器测试纳入全套回归。

## 隔离扩展浏览器：模拟接口

使用独立的 Chromium 测试配置目录加载当前 `dist`，API 为本地 HTTP fixture。没有写入用户 Chrome 配置，没有使用真实 API Key。

| 流程 | OpenAI | Anthropic |
| --- | --- | --- |
| 选择供应商/协议、填写模型、测试连接、保存、重新打开 | 通过 | 通过 |
| 普通翻译 | 3/3 完成，0 失败 | 3/3 完成，0 失败 |
| 全文翻译、原子提交 | 3/3 完成，0 失败 | 3/3 完成，0 失败 |
| 选区翻译浮窗 | 通过 | 通过 |
| popup 读取当前页 | 最终状态在 Anthropic 流程检查 | 正常显示“翻译完成”，3/3 段落 |

未捕获页面脚本异常。`browser-results.json` 保存最终状态。`browser-acceptance.txt` 为 Playwright 工具函数，`fixture-server.py` 为本地模拟服务器；先运行服务器，再使用 browser_run_code_unsafe 执行函数。浏览器函数在 finally 中关闭自己的测试上下文。

截图：`options-anthropic.png`、`translated-anthropic.png`、`popup.png`。模拟响应仅验证功能链路，不用于评估翻译质量或真实接口延迟。

## 真实供应商 API 验收状态

本次隔离验收没有装载真实凭据，以下项目均未进行真实 API 调用；文档核对、请求体测试和模拟 SSE 通过不能视为服务商实测通过。先前 MiMo 性能测试也不替代本次新协议实现验收。

| 供应商 | OpenAI 官方接口预填 | Anthropic 官方接口预填 | 本次真实 API |
| --- | --- | --- | --- |
| Gemini | 有 | 无，需自填兼容中转 | 未执行 |
| Grok | 有 | 无，已废弃组合需自填中转 | 未执行 |
| OpenAI | 有 | 无，需自填兼容中转 | 未执行 |
| Anthropic | 有，官方兼容层 | 有 | 未执行 |
| Kimi | 有 | 有 | 未执行 |
| GLM | 有 | 有 | 未执行 |
| MiMo | 有 | 有 | 未执行 |
| DeepSeek | 有 | 有 | 未执行 |
| Qwen | 有 | 有 | 未执行 |
| 自定义 | 自填 | 自填 | 本地模拟通过，无商业中转实测 |

## 规则来源和边界

能力与型号建议共享 `src/shared/providers.ts`；新增型号必须明确加入精确 ID，不使用型号前缀或域名推断思考方式。目录包含代表型号，未收录的型号可手填并使用手动控制。

- [Gemini OpenAI 兼容](https://ai.google.dev/gemini-api/docs/openai)：保留 v1beta/openai 路径，型号差异决定是否允许关闭及强度。
- [Grok 推理](https://docs.x.ai/developers/model-capabilities/text/reasoning)、[旧接口](https://docs.x.ai/developers/rest-api-reference/inference/legacy)：始终思考型号不把低强度当关闭，不预填已废弃 Anthropic 接口。
- [OpenAI 型号](https://developers.openai.com/api/docs/models)：按具体型号配置 reasoning_effort；GPT-5.1 不提供 xhigh。
- [Claude 思考](https://platform.claude.com/docs/en/build-with-claude/thinking)、[强度](https://platform.claude.com/docs/en/build-with-claude/effort)、[兼容层](https://platform.claude.com/docs/en/cli-sdks-libraries/libraries/openai-sdk)、[事件规范](https://platform.claude.com/docs/en/build-with-claude/streaming)：Messages 使用 output_config.effort；OpenAI 兼容层文档不承诺该字段且明确忽略 reasoning_effort，自动模式不展示该组合的强度选项。
- [Kimi 思考](https://platform.kimi.ai/docs/guide/use-thinking-models)、[Anthropic 接入](https://platform.kimi.ai/docs/guide/claude-code-kimi)：K3 的 Anthropic 开关规则单列；K2.7 Code 始终思考。
- [GLM 思考](https://docs.bigmodel.cn/cn/guide/capabilities/thinking)、[输出上限](https://docs.bigmodel.cn/cn/guide/start/concept-param)：4.5/4.5 Air 最大 98304，后续型号分别维护。
- [MiMo OpenAI](https://mimo.mi.com/docs/en-US/api/chat/openai-api)、[MiMo Anthropic](https://mimo.mi.com/docs/en-US/api/chat/anthropic-api)：两种协议均显式控制 thinking.type。
- [DeepSeek](https://api-docs.deepseek.com/guides/thinking_mode/)、[Anthropic](https://api-docs.deepseek.com/guides/anthropic_api/)：按协议映射强度。
- [Qwen Anthropic](https://www.alibabacloud.com/help/zh/model-studio/anthropic-api-messages)、[Qwen Plus 上限](https://help.aliyun.com/zh/model-studio/qwen-plus)、[Qwen Flash 上限](https://help.aliyun.com/en/model-studio/qwen-flash)：使用 thinking.type 和 output_config.effort，不自动附加已废弃预算；Plus/Flash 输出上限为 32768。

自定义中转是否遵循官方参数由该服务决定；服务商拒绝参数时显示原始错误，不自动换协议、换模型或降低强度。未接入 Responses、Gemini 原生协议、工具调用或多模态。
