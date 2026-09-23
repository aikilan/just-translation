# 图片翻译审查修复

2026-09-23。修复 [review.md](./review.md) 确认的两项问题。

## 修复结果

- **本地图片向网页泄露：** 快捷弹窗改用封闭 Shadow DOM。根节点只由扩展隔离世界持有，网页不能通过 `host.shadowRoot`、宿主 HTML 或事件的 `composedPath()` 获得文件输入框和图片预览节点。没有增加生产调试接口；测试通过自身的 spy 或测试扩展权限检查内部 UI。保留原生文件选择、预览、关闭取消和重开草稿行为。
- **GPT-5.6 能力误判：** 将官方端点下 `gpt-5.6` 的图片能力改为支持，并记录 [GPT-5.6 Sol 官方别名说明](https://developers.openai.com/api/docs/models/gpt-5.6-sol)；基础 API 地址和完整 Chat Completions 地址都能自动匹配，设置保存后仍然有效。

封闭根节点解决的是普通宿主网页脚本的 DOM 读取路径，依赖现有内容脚本在 Chrome 的 `ISOLATED` 世界执行。浏览器验收同时检查了网页预先改写 `Element.prototype.attachShadow` 的情况，未取得扩展根节点引用。

## 测试先行与全量检查

先新增 5 项回归：弹窗打开和关闭时附件隔离各 1 项、两种官方地址的别名能力各 1 项、设置自动匹配并保存重开 1 项。修改生产代码前，这 5 项均按预期失败；修复后相关 3 个测试文件共 33 项通过。

- [修改前失败记录](./fixes-red.txt)
- [修复后定向测试](./fixes-green.txt)
- [最终全量检查](./fixes-check.txt)：`pnpm check` 通过 ESLint、81 个测试文件 / 973 项测试、TypeScript、Vite 构建及扩展构建结构检查。

首次全量检查中，已有视口调度测试 `continues old-order dispatch if another scroll invalidates a slow viewport lookup` 一次断言期望 7 批、实际 6 批；随后该测试单独运行和完整复跑均通过。本次未修改该调度链路，也未放宽断言。保留 [首次检查输出](./fixes-first-check.txt)，不将一次通过当作此前失败的根因结论。

## 实际扩展验收

使用独立临时 Chrome for Testing 配置加载 `dist`，通过生产注入入口、Chrome runtime 消息和扩展 Service Worker 请求本地 HTTP 服务。宿主页设置 `img-src 'self'`，并在打开弹窗前注册事件监听和 `attachShadow` 拦截。测试仅使用生成图片及仓库图标。

| 检查 | 修复前 | 修复后 |
| --- | --- | --- |
| 网页读取 `host.shadowRoot` | 返回根节点 | `null` |
| 网页读取同一生成 PNG 的 Base64 | 12320 个字符 | 无法取得图片节点，0 个字符 |
| 网页事件路径暴露文件输入框 | 是 | 否 |
| 网页预设 `attachShadow` 拦截取得根节点 | 否，原本在隔离世界执行 | 否 |
| 未提交时 HTTP 请求数 | 审查已确认 0 | 0 |
| 关闭后保留草稿的 DOM 隔离 | 存在读取路径 | 仍无法取得根节点或文件输入节点 |

修复后实际交互结果：

- 原生文件选择器成功读取 128×128 仓库图标并显示预览。
- 600×200 PNG / OpenAI、JPEG / Anthropic、WebP 转 PNG / OpenAI 均通过生产链路返回测试译文。
- 关闭慢请求后，服务器记录 1 次连接取消；重开保留草稿。
- 切换到仅文字模型隐藏上传入口、保留预览并禁用提交。
- 官方 `gpt-5.6` 配置保存 `imageInputEnabled: false` 时，仍自动显示图片入口并允许提交；没有向官方 API 发出测试请求。

最终本地服务共记录 4 次请求：OpenAI 3 次、Anthropic 1 次、取消 1 次。媒体类型依次是 PNG、JPEG、PNG、PNG。完整状态和脱敏计数见 [fixes-browser.json](./fixes-browser.json)；其中 `stats.bytes` 是 Base64 字符长度，不是解码后的文件大小。

`dist` 已更新，版本保持 0.3.34。用户日常浏览器中已安装的扩展没有自动重新加载，需要在扩展管理页重新加载后使用新实现。没有调用真实模型 API，实际图片识别与翻译质量不属于本次验收结论。
