# 条件右键重试菜单验收

- 普通翻译有失败项时显示「重试全部失败」，失败清零、恢复原文、切换到无失败页或导航后隐藏。
- 点击处理会再次核对主文档状态，并用同一 documentId 发送重试命令；选中文字或在 iframe 右击不会改变重试范围。
- 先验证失败测试，再实现。最终 pnpm check：43 个文件、463 项测试通过，ESLint、TypeScript、生产构建和后台构建校验通过。
- 隔离 Chromium 加载本次 dist，使用本地 fixture，记录实际 chrome.contextMenus.update 成功回调。验证失败显示、切换健康页隐藏、切回显示、重试隐藏、恢复原文隐藏、导航隐藏。
- 重试仅请求两个失败段落，最终 3 段成功；原成功译文 DOM 保持不变，无页面错误。
- 原生右键菜单点击路由由单元测试验证；本次浏览器验证未通过原生菜单点击触发，而是发送相同的页面重试命令。
- Chrome 会将多个可见菜单项自动收进扩展子菜单：https://developer.chrome.com/docs/extensions/reference/api/contextMenus
- 用户已安装的扩展未被改动；本地 dist 已更新。

复跑 browser-acceptance.js.txt 前先启动 scripts/browser-fixture-server.mjs，更新 origin 端口，确保 fixture 从 normal 模式开始。
