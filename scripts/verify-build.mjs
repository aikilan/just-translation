import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const distDirectory = path.join(projectRoot, 'dist');
const manifest = JSON.parse(await readFile(path.join(distDirectory, 'manifest.json'), 'utf8'));

const serviceWorkerPath = manifest.background?.service_worker;
if (typeof serviceWorkerPath !== 'string') {
  throw new Error('构建校验失败：manifest 缺少后台 Service Worker');
}

const loaderPath = path.join(distDirectory, serviceWorkerPath);
const loaderSource = await readFile(loaderPath, 'utf8');
const bundleImport = loaderSource.match(/import\s+['"]([^'"]+)['"]/u)?.[1];
if (!bundleImport) {
  throw new Error('构建校验失败：Service Worker loader 没有导入后台 bundle');
}

const backgroundBundle = await readFile(
  path.resolve(path.dirname(loaderPath), bundleImport),
  'utf8',
);
const requiredBackgroundMarkers = [
  'GET_PUBLIC_SETTINGS',
  'BEGIN_TRANSLATION_SESSION',
  'RESOLVE_TRANSLATION_CANDIDATES',
  'TRANSLATE_BATCH',
  'TRANSLATION_BATCH_PROGRESS',
  'UPDATE_TRANSLATION_PRIORITIES',
  'CANCEL_TRANSLATION_BATCH',
  'webNavigation',
  'END_TRANSLATION_SESSION',
  'SAVE_TRANSLATION_PROFILE',
  'DELETE_TRANSLATION_PROFILE',
  'UPDATE_READING_PREFERENCES',
  'UPDATE_UI_LANGUAGE',
  'UPDATE_SITE_RULE',
  'SET_ACTIVE_TRANSLATOR',
  'SET_SITE_AUTO_TRANSLATE',
  'contextMenus',
];
const missingMarkers = requiredBackgroundMarkers.filter(
  (marker) => !backgroundBundle.includes(marker),
);

if (missingMarkers.length > 0) {
  throw new Error(`构建校验失败：Service Worker 错接了其他入口，缺少 ${missingMarkers.join(', ')}`);
}

stdout.write(`构建校验通过：${serviceWorkerPath} 已连接后台 bundle\n`);

// Chrome serializes executeScript.func without the popup's closure. Exercise the emitted
// function, because source tests cannot catch helpers introduced by Vite/minification.
const popupHtml = await readFile(path.join(distDirectory, manifest.action.default_popup), 'utf8');
const popupScript = popupHtml.match(/<script[^>]+src="([^"]+)"/u)?.[1];
if (!popupScript) throw new Error('构建校验失败：popup 缺少脚本');
const popupSource = await readFile(path.join(distDirectory, popupScript), 'utf8');
const popupAst = ts.createSourceFile('popup.js', popupSource, ts.ScriptTarget.Latest, true);
const nodes = [];
function visit(node) {
  nodes.push(node);
  ts.forEachChild(node, visit);
}
visit(popupAst);
const injection = nodes.find(
  (node) =>
    ts.isCallExpression(node) &&
    node.expression.getText(popupAst) === 'chrome.scripting.executeScript' &&
    ts.isObjectLiteralExpression(node.arguments[0]) &&
    node.arguments[0].properties.some((property) => property.name?.getText(popupAst) === 'func'),
);
const functionName = injection?.arguments[0].properties
  .find((property) => property.name?.getText(popupAst) === 'func')
  ?.initializer?.getText(popupAst);
const injectedFunction = nodes.find(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === functionName,
);
if (!injectedFunction) throw new Error('构建校验失败：找不到快捷翻译注入函数');
const browserWindow = new globalThis.EventTarget();
const quickLoader = await readFile(
  path.join(distDirectory, 'src/content/quick-translation-loader.iife.js'),
  'utf8',
);
new Function('window', quickLoader)(browserWindow);
const isolatedOpen = new Function('window', `return (${injectedFunction.getText(popupAst)});`)(
  browserWindow,
);
const testModule = `data:text/javascript,${encodeURIComponent(
  'export function openQuickTranslation() { return { ok: true }; }',
)}`;
const opened = await isolatedOpen(testModule);
if (opened?.ok !== true)
  throw new Error(`构建校验失败：快捷翻译注入函数无法独立运行 ${JSON.stringify(opened)}`);
stdout.write('构建校验通过：快捷翻译注入函数可独立运行\n');

// The YouTube caption hook runs in the page world as a classic script, so it must carry no
// imports. Run the emitted file against a stand-in page and observe one caption response.
const captionHookPath = 'src/content/youtube/caption-hook.iife.js';
if (!backgroundBundle.includes(captionHookPath))
  throw new Error('构建校验失败：后台没有注册 YouTube 字幕脚本');
const captionHook = await readFile(path.join(distDirectory, captionHookPath), 'utf8');
const pageDocument = new globalThis.EventTarget();
const pageWindow = { fetch: () => Promise.resolve(new globalThis.Response('{"events":[]}')) };
class PageRequest extends globalThis.EventTarget {
  open() {}
}
new Function('window', 'document', 'XMLHttpRequest', 'location', captionHook)(
  pageWindow,
  pageDocument,
  PageRequest,
  new globalThis.URL('https://www.youtube.com/watch?v=abcdefghijk'),
);
const captionEvent = new Promise((resolve) =>
  pageDocument.addEventListener('justtranslate-youtube-captions', (event) => resolve(event.detail)),
);
await pageWindow.fetch('https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=en&fmt=json3');
const captionDetail = await Promise.race([
  captionEvent,
  new Promise((resolve) => globalThis.setTimeout(resolve, 1_000)),
]);
if (JSON.parse(captionDetail ?? '{}').body !== '{"events":[]}')
  throw new Error('构建校验失败：YouTube 字幕脚本无法独立运行');
stdout.write('构建校验通过：YouTube 字幕脚本可独立运行\n');

// Every browser-owned metadata reference must resolve in every shipped locale.
if (manifest.default_locale !== 'en') throw new Error('Invalid default locale');
for (const locale of ['zh_CN', 'zh_TW', 'en', 'fr', 'de', 'ar']) {
  const messages = JSON.parse(
    await readFile(path.join(distDirectory, '_locales', locale, 'messages.json'), 'utf8'),
  );
  for (const value of [
    manifest.name,
    manifest.description,
    manifest.action?.default_title,
    manifest.commands?.['translate-page']?.description,
  ]) {
    const key = value?.match(/^__MSG_(\w+)__$/u)?.[1];
    if (!key || !messages[key]?.message)
      throw new Error(`Missing native locale message: ${locale} ${value}`);
  }
}
