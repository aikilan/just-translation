import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { stdout } from 'node:process';
import { fileURLToPath } from 'node:url';

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
  'SET_ACTIVE_PROFILE',
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
