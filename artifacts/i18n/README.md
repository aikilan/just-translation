# 五语言 UI 验收

支持简体中文、英文、法语、德语和阿拉伯语。默认跟随浏览器；设置页可单独选择界面语言。

## 自动化检查

- `pnpm check`：59 个文件、715 项测试通过，ESLint、TypeScript、Vite 构建与原生语言资源检查通过。
- `direction-red.txt`：新增测试先复现阿拉伯语状态控件的 RTL 残留到完成译文，修复后恢复 `dir="auto"`。
- `bidi-red.txt`：新增测试先复现阿拉伯语插值缺少方向隔离，修复后外部诊断文字使用 Unicode 方向隔离。
- `narrow-layout-red.txt`：浏览器断言先复现窄屏语言选择器不可见，修复后选择器保持可用。

## 实际扩展浏览器验收

将 `dist` 加载至独立临时 Chromium 配置，使用仓库本地 SSE 测试服务，没有调用真实 AI 服务商，也没有修改日常浏览器中的扩展配置。

- 后台重新启动时恢复已保存语言的单元测试通过。
- 五语言设置页与弹窗同步，标题和 `lang` / `dir` 正确；保存语言不覆盖模型草稿或翻译目标语言。
- 阿拉伯语 RTL、窄屏深色设置页、德语长按钮换行均检查截图；API 地址保持 LTR。
- 正在翻译时切换界面语言，不取消请求；译文完成后切换语言，不新增翻译请求或修改已有译文。
- 网页和 iframe 的宿主 `lang` / `dir` 保持原值；划词错误及按钮原地切换语言，原文不变。
- Chrome 原生右键菜单更新调用成功，新打开的设置页恢复已保存语言；Manifest 和快捷键说明消息占位符均正确解析。
- 页面运行时异常为零。浏览器原生名称与快捷键说明继续跟随浏览器语言，不受扩展内手动选择影响。

详细记录见 [browser-results.json](browser-results.json)，脚本见 [browser-acceptance.mjs.txt](browser-acceptance.mjs.txt)。脚本通过 `JT_FIXTURE_ORIGIN` 接收 `node scripts/browser-fixture-server.mjs` 输出的本地地址，Playwright 与 Chromium 路径为当前验收机器路径。

截图包括 `options-*.png`、`popup-*.png` 和 `selection-*-error.png`。本次更新了 `dist`，保持版本 0.3.33，未运行会自动升版打包的 `pnpm build`，未发布商店。
