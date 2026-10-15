# Chrome 应用店上架材料

适用版本：v0.3.41（`just-translate-v0.3.41.zip`，在项目根目录，由 `pnpm build` 生成）。

Chrome 不允许扩展脚本操作开发者后台，以下步骤需要在 [Chrome 应用店开发者后台](https://chrome.google.com/webstore/devconsole) 手动完成。

## 文件清单

| 用途                          | 文件                                                                  |
| ----------------------------- | --------------------------------------------------------------------- |
| 上架包                        | 项目根目录 `just-translate-v0.3.41.zip`                               |
| 商店图标 128×128              | `store-icon-128.png`                                                  |
| 英文截图 1280×800             | `screenshots/en/1-5*.png`                                             |
| 阿拉伯语截图 1280×800         | `screenshots/ar/1-5*.png`                                             |
| 小型宣传图块 440×280（必填）  | `promo/small-440x280-en.png`、`promo/small-440x280-ar.png`            |
| 横幅宣传图块 1400×560（选填） | `promo/marquee-1400x560-en.png`、`promo/marquee-1400x560-ar.png`      |
| 英文文案与隐私表单            | `listing.en.md`                                                       |
| 阿拉伯语文案                  | `listing.ar.md`                                                       |
| 隐私政策 URL                  | `https://github.com/aikilan/just-translation/blob/main/PRIVACY.en.md` |

## 文案注意事项

描述中不要罗列服务商、品牌或语言名称。2026-10-13 的 0.3.39 草稿因描述中列出 OpenAI、Anthropic、Gemini 等 AI 服务商，被以「垃圾内容和商店中的排名：说明中有过多关键字」拒绝（参考 ID：Yellow Argon）。

## 操作步骤

1. **首次使用**需注册开发者账号并支付一次性注册费，验证联系邮箱。
2. **新建或更新商品**：首次上架点「New item」上传 zip；已有商品进入「Package」上传新版 zip。
3. **Store listing（默认语言 English）**：
   - Description 粘贴 `listing.en.md` 中的英文描述；名称和摘要来自安装包，无需填写。
   - Category、Language、图标、英文截图、宣传图块按上表上传。
   - Homepage / Support URL 见 `listing.en.md`。
4. **添加阿拉伯语**：在 Store listing 顶部语言下拉中选择「Arabic - العربية」，粘贴 `listing.ar.md` 中的描述，并上传 `screenshots/ar` 截图和 `promo/*-ar.png` 图块。安装包已内置阿拉伯语名称和摘要。
5. **Privacy practices**：单一用途、各权限说明、远程代码、数据使用勾选项和隐私政策 URL，全部照抄 `listing.en.md`。
6. **Distribution**：Free、Public、所有地区。
7. **Test instructions**：粘贴 `listing.en.md` 末尾的审核说明。
8. 点击「Submit for review」。审核通常需要几天，`<all_urls>` 级别的主机权限可能延长审核时间。

## 截图生成方式

截图由 Playwright 加载 `dist` 的真实扩展拍摄：阿拉伯语版界面为阿拉伯语，将英文文章翻译为阿拉伯语；英文版将日文文章翻译为英文。译文来自真实的 Google 免费通道，文章内容为原创示例，设置页中的 API Key 为占位值。
