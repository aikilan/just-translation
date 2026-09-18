import { defineManifest } from '@crxjs/vite-plugin';

import packageJson from './package.json' with { type: 'json' };

export default defineManifest({
  manifest_version: 3,
  name: '只是翻译',
  description: '使用你自己的 OpenAI 协议 API，在网页原文下方展示译文。',
  version: packageJson.version,
  minimum_chrome_version: '120',
  permissions: ['storage', 'activeTab', 'contextMenus', 'alarms', 'webNavigation'],
  host_permissions: ['http://*/*', 'https://*/*'],
  background: {
    service_worker: 'src/background/service-worker.ts',
    type: 'module',
  },
  action: {
    default_title: '只是翻译',
    default_popup: 'src/popup/index.html',
    default_icon: {
      16: 'icons/icon-16.png',
      32: 'icons/icon-32.png',
      48: 'icons/icon-48.png',
      128: 'icons/icon-128.png',
    },
  },
  icons: {
    16: 'icons/icon-16.png',
    32: 'icons/icon-32.png',
    48: 'icons/icon-48.png',
    128: 'icons/icon-128.png',
  },
  options_page: 'src/options/index.html',
  content_scripts: [
    {
      matches: ['http://*/*', 'https://*/*'],
      js: ['src/content/selection-content-script.ts'],
      all_frames: true,
      run_at: 'document_idle',
    },
    {
      matches: ['http://*/*', 'https://*/*'],
      js: ['src/content/content-script.ts'],
      run_at: 'document_idle',
    },
  ],
  commands: {
    'translate-page': {
      suggested_key: {
        default: 'Alt+T',
        mac: 'Alt+T',
      },
      description: '翻译或恢复当前网页',
    },
  },
});
