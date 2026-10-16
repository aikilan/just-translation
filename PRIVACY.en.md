# Just Translate Privacy Policy

[中文](PRIVACY.md) | **English**

Effective date: October 16, 2026

Just Translate is a local-first browser extension. It has no developer-operated translation relay, and contains no ads, behavioral analytics or telemetry.

## Data processed

- **AI configuration**: the API URL, API key, model name and custom translation prompt you enter are stored in your browser's local storage. The API key is only used to authenticate with the API provider you chose.
- **Web page content**: when you start a translation, or turn on auto-translation for the current exact domain, the extension reads the translatable text already loaded on the current page. Depending on the translation engine you explicitly selected, that text is sent directly to Google, Microsoft or the AI API you configured. Full-document context and custom translation prompts are only sent to the AI API you configured.
- **PDF documents**: the extension only reads a PDF in its own reader page after you click "Translate this PDF" on a PDF open in the browser, open it from the extension popup, or choose a local file in the reader. Online PDFs are downloaded by the extension directly from their original address (with that site's cookies, just like the browser's own PDF viewer); local files are read only on your device. Parsing and page rendering happen entirely on your device. When you start a translation, the extracted text is sent to the selected engine under the same rules as web page content above. The PDF file itself is never uploaded and is not saved to storage or the cache.
- **YouTube video captions**: on `www.youtube.com`, the extension reads the captions the YouTube player itself loads (`/api/timedtext` responses) within the page. It does not change those requests or responses and does not read other network requests. Only after you click the bilingual subtitles button in the player, or turn on the "YouTube bilingual subtitles" preference, is caption text sent to the selected engine under the same rules as web page content above, and only the lines near the playback position. Captions are not saved to storage; their translations are cached under the same rules.
- **Quick translation input**: text you type or paste into the Quick translate dialog, and an image you choose to upload there, are sent only when you click Translate, and only to the engine selected in that dialog. Images can only be sent to an AI configuration that supports image input. Drafts stay on the current page and are not saved to storage, the cache or logs.
- **Free translation channels**: the Google channel requests `translate.googleapis.com`. The Microsoft channel obtains a short-lived anti-abuse token from the Translator page on `www.bing.com` or `cn.bing.com`, then requests translations from the same Bing host. Both channels use consumer endpoints, not the official Google Cloud Translation or Azure Translator APIs, and may be rate-limited, changed or discontinued.
- **Current page information**: the extension processes the current tab's URL and domain locally to decide whether a page can be translated, to match auto-translate and exclusion rules, and to stop tasks of a previous page after navigation. The extension does not build or upload browsing history.
- **Preferences and cache**: preferences such as target language, display mode and site rules are stored in your browser. Translations are cached in the browser's IndexedDB; cache keys contain neither API keys nor plaintext source text.

## How data is used and shared

The data above is only used to provide the translation features you see. Page text is transmitted directly to the Google, Microsoft or AI API provider you explicitly selected in the interface; API keys are only transmitted to the corresponding AI provider. Each provider's handling of data is governed by its own terms and privacy policy. If one engine fails, the extension does not automatically resend the text to another engine.

The developer does not receive page content, API keys, translations, current page information or usage data, does not sell data, does not use data for advertising, creditworthiness or any purpose unrelated to translation, and does not allow humans to read this data.

## Retention and deletion

- AI configurations, reading preferences and site rules stay in your browser until you change or delete them, or uninstall the extension.
- Configuration snapshots of active translation sessions are kept temporarily in browser session storage and are cleared when the task ends, the tab closes or the page navigates.
- The Microsoft channel's short-lived token is only kept in the extension service worker's memory, never in persistent storage or the translation cache.
- Cached translations are kept for at most 72 hours from when they were first written; the extension periodically removes expired entries.
- Uninstalling the extension makes the browser delete its local data.

## Security

Remote APIs must use HTTPS when an API key is sent. Plain HTTP is only allowed for local addresses: `localhost`, `127.0.0.0/8` and `[::1]`. The extension prevents web page content scripts from reading keys in browser storage, and removes configured API keys from displayed error messages.

The free channels use fixed HTTPS hosts, send no browser cookies, do not read Google or Microsoft sign-ins, and never execute remote page scripts. The extension only parses translation responses and the necessary temporary parameters from the Microsoft Translator page. The broad HTTP/HTTPS host permission is used both to detect and display translations on the regular web pages you visit, and to reach the AI API URL you configured.

## Chrome Web Store Limited Use

Just Translate's use of user data complies with the Chrome Web Store User Data Policy, including the Limited Use requirements. Data is only accessed to provide or improve the extension's single, user-facing web page translation purpose.

## Changes to this policy

If the way the extension handles data changes materially, this policy will be updated and users will be informed as required.

## Contact

Questions about this policy: [open an issue on GitHub](https://github.com/aikilan/just-translation/issues).
