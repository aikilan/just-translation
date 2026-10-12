# Chrome Web Store listing: English (default)

## Name and summary

Taken from the package (`_locales/en/messages.json`), not typed in the dashboard.

- Name: Just Translate
- Summary: Bilingual web page translation with no account or login. Use free Google or Microsoft translation, or connect your own AI.

## Description

```text
Read any web page in two languages, with no account and no login.

Just Translate puts the translation right under each paragraph, so you read the original and the translation side by side. Switch to translation-only whenever you like. Install it and start reading: there is nothing to sign up for.

WHY JUST TRANSLATE
• No account, no login, no subscription.
• Works out of the box with free Google Translate or Microsoft Translator. No API key needed.
• No middleman: requests go straight from your browser to the service you picked, never through a developer server.
• Open source (AGPL-3.0), so anyone can check what is sent where.

FEATURES
• Bilingual reading: translations appear under the original paragraphs and keep the page's look.
• Viewport first: what you see is translated first, then the rest of the page. New content is translated as it loads.
• Selection translation: select text, right-click, and the result appears next to it.
• Quick translate: paste text and translate it in a popup.
• Bring your own AI: OpenAI, Anthropic, Gemini, Grok, Kimi, GLM, Xiaomi MiMo, DeepSeek, Qwen or any compatible endpoint, including local servers.
• Full-document translation with your AI keeps terminology consistent across the whole article.
• Site rules: auto-translate the sites you choose, or exclude sites you never want translated.
• Alt + T shortcut, light and dark themes. Interface in English, Arabic, Simplified Chinese, French and German.

PRIVACY
Your API keys and settings stay in your browser. Page text is only sent to the translation service you selected, and never silently resent to another one if it fails. The free Google and Microsoft options use consumer web endpoints rather than the official cloud APIs, so they may be rate-limited or change. Avoid translating sensitive pages, or add them to the exclusion list.

Source code: https://github.com/aikilan/just-translation
```

## Screenshot captions (optional, for your reference)

1. `1-bilingual.png`: A Japanese article with English translations under each paragraph.
2. `2-popup.png`: Translate, stop or restore from the toolbar popup.
3. `3-selection.png`: Translate selected text with a right-click.
4. `4-quick-translate.png`: Quick translate for pasted text.
5. `5-settings.png`: Connect your own AI, such as Xiaomi MiMo.

## Privacy practices tab

### Single purpose

```text
Translate the web page the user is reading with the translation service the user explicitly selected, and display the translation next to the original text.
```

### Permission justifications

- **storage**: `Saves the user's AI configurations, reading preferences, site rules, temporary session state and the local translation cache in the browser.`
- **activeTab**: `Communicates with the current tab and starts translation when the user clicks the toolbar button, the context menu or the keyboard shortcut.`
- **scripting**: `Injects the Quick translate dialog into the current page only when the user clicks Quick translate in the popup.`
- **contextMenus**: `Adds right-click entries to translate the page or the selected text, labeled with the engine that will receive the text.`
- **alarms**: `Periodically deletes cached translations older than 72 hours.`
- **webNavigation**: `Binds translation tasks to the current document and cancels them after navigation, so old translations are never written into a new page.`
- **Host permission (http://\*/\*, https://\*/\*)**: `Reads and displays translations on the regular web pages the user chooses to translate, calls the fixed Google and Bing translation endpoints, and calls the AI API URL the user configured.`

### Remote code

`No, I am not using remote code.` All executable code ships in the package; API responses are parsed as translation data only.

### Data usage

Check:

- **Authentication information**: user-supplied API keys are stored locally and only sent to the matching AI provider.
- **Website content**: page text the user chooses to translate is sent to the selected translation service.

Leave the others unchecked. Then tick all three certifications (no selling, no unrelated use, no creditworthiness use).

### Privacy policy URL

```text
https://github.com/aikilan/just-translation/blob/main/PRIVACY.en.md
```

## Other fields

- Category: Productivity → Tools (or "Workflow & Planning" if Tools is unavailable)
- Default language: English
- Homepage URL / Support URL: `https://github.com/aikilan/just-translation` and `https://github.com/aikilan/just-translation/issues`
- Distribution: Free, Public, all regions

## Notes for reviewers (Test instructions tab)

```text
No account or credentials are needed. Install the extension, open any regular HTTP/HTTPS article, click the toolbar icon and choose "Translate now". The default engine is the free Google channel; Microsoft can be selected in the popup. Full-document translation is only available with a user-supplied AI API, so its button is disabled by default. The free channels send no cookies and run no remote scripts.
```
