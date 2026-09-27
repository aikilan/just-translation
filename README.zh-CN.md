# 只是翻译

[English](README.md) | **简体中文** | [日本語](README.ja.md) | [한국어](README.ko.md) | [العربية](README.ar.md)

一个本地优先的 Chrome / Edge 网页双语翻译扩展。译文直接显示在每个段落下方，原文和译文对照阅读，也可以切换为仅显示译文。

不用注册，不用登录，也没有订阅。装上就能用 Google 或 Microsoft 免费通道翻译，也可以接入自己的 OpenAI Chat Completions 或 Anthropic Messages API。请求从扩展直接发往你选择的服务，不经过开发者的服务器。

![一篇日文文章被翻译成英文，每段译文显示在原文下方](docs/images/bilingual.png)

## 为什么做这个

翻译网页本来是件很简单的事，可大多数双语翻译插件都要先注册账号、登录才能用。只是翻译去掉了这一步：装上就能开始阅读。

## 功能

- **双语阅读**：译文显示在原文段落下方，沿用网页原有排版；可在「原文 + 译文」和「仅译文」之间切换。
- **免费通道，零配置**：默认使用 Google 翻译，也可切换 Microsoft 翻译，都不需要账号、API Key 或浏览器 Cookie。
- **接入自己的 AI**：支持 OpenAI、Anthropic、Gemini、Grok、Kimi、GLM、小米 MiMo、DeepSeek、Qwen，以及任何兼容接口（包括 `localhost` 上的本地服务）。每个配置可单独设置 Prompt 和思考选项。
- **全文完整翻译**（仅 AI）：把当前已加载的正文一次发给 AI，跨段落的术语和指代保持一致。
- **划选翻译**：选中文字后右键，结果显示在选区旁的浮窗里，支持 iframe 和可编辑区域。
- **快捷翻译**：粘贴文字即可翻译；使用支持图片输入的 AI 模型时还能翻译图片。
- **可视区优先**：先翻译屏幕上的内容，再翻译下一屏和其余部分；动态加载的内容会增量补译。
- **站点规则**：为指定域名开启自动翻译，或用精确域名、`*.example.com` 通配规则排除站点。
- **本地缓存**：译文以 SHA-256 为键缓存在 IndexedDB，保留 72 小时。
- **不会悄悄换引擎**：某个引擎翻译失败时，不会自动把网页文本改发给其他服务，由你决定重试或切换。
- `Alt + T` 快捷键，浅色 / 深色外观；界面支持简体中文、英文、法语、德语和阿拉伯语。

## 截图

| 工具栏弹窗                                       | 划选翻译                                   |
| ------------------------------------------------ | ------------------------------------------ |
| ![工具栏弹窗](docs/images/popup.png)             | ![划选翻译浮窗](docs/images/selection.png) |
| **快捷翻译**                                     | **AI 配置**                                |
| ![快捷翻译弹窗](docs/images/quick-translate.png) | ![AI 配置页](docs/images/settings-ai.png)  |

> 推荐：如果使用 AI 引擎，小米 MiMo `mimo-v2.5` 便宜又快，日常阅读够用。它是内置供应商，只需填入 API Key。

## 隐私

- 不经过任何开发者服务器。请求由扩展后台直接发往 Google、Microsoft 或你配置的 AI 接口。
- API Key 保存在 `chrome.storage.local`，仅限扩展受信任的环境访问，网页内容脚本读不到。
- 缓存中不保存 API Key，也不保存明文原文。
- 段落中的代码和标记为 `translate="no"` 的片段会替换为本地占位符，不会发给翻译服务。

免费通道使用的是 Google / Bing 的消费端网页接口（`translate.googleapis.com` 和 Bing Translator），而不是官方的 Google Cloud Translation 或 Azure Translator API，可能被限流、变更或失效。请不要在敏感网站上启用翻译，或将它们加入排除列表。

详见 [PRIVACY.md](PRIVACY.md)。

## 安装

从源码构建（需要 Node.js 22.12+）：

```bash
npx -y pnpm@10.34.5 install
npx -y pnpm@10.34.5 build
```

然后：

1. 打开 Chrome 的 `chrome://extensions` 或 Edge 的 `edge://extensions`。
2. 打开「开发者模式」。
3. 点击「加载已解压的扩展程序」，选择 `dist` 目录。
4. 打开任意 HTTP/HTTPS 网页，点击工具栏图标，或右键选择「立即翻译」。

如需使用 AI 引擎，打开扩展设置 →「AI 配置」，选择供应商并填入 API Key。

实现细节、设计取舍和验收记录见 [详细说明](docs/details.zh-CN.md)。

## 许可证

本项目基于 [GNU Affero General Public License v3.0](LICENSE) 发布。

你可以在 AGPL-3.0 条款下使用、修改和分发本项目；衍生作品（包括以网络服务形式提供的）须以相同协议开源。如需在闭源或商业产品中使用而不承担上述义务，可申请单独的商业授权，请通过 [GitHub Issues](https://github.com/aikilan/just-translation/issues) 联系。
