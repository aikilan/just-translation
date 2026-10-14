import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { crx } from '@crxjs/vite-plugin';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

import manifest from './manifest.config.ts';
import { nativeLocaleMessages } from './src/shared/native-locales.ts';

const rootDirectory = path.dirname(fileURLToPath(import.meta.url));
const pdfjsDirectory = path.join(rootDirectory, 'node_modules/pdfjs-dist');
// Character maps decode CJK text, fonts/ICC profiles render faithfully, and WASM decodes
// JPEG 2000/JBIG2 scans. PDF scripting (QuickJS) and non-WASM fallbacks are never loaded.
const pdfjsAssets: Record<string, (file: string) => boolean> = {
  cmaps: () => true,
  standard_fonts: () => true,
  iccs: () => true,
  wasm: (file) => !file.startsWith('quickjs') && !file.includes('nowasm'),
};

export default defineConfig({
  test: { setupFiles: ['./src/test-utils/setup-i18n.ts'] },
  plugins: [
    react(),
    crx({ manifest }),
    {
      name: 'native-extension-locales',
      // Emit directly to the build; source catalogs stay the only editable source of native text.
      generateBundle() {
        for (const [locale, messages] of Object.entries(nativeLocaleMessages())) {
          this.emitFile({
            type: 'asset',
            fileName: `_locales/${locale}/messages.json`,
            source: JSON.stringify(messages, null, 2),
          });
        }
      },
    },
    {
      name: 'pdfjs-assets',
      // The PDF viewer loads these on demand from the extension package, never from a CDN.
      generateBundle() {
        // pdf.js is Apache-2.0; its notice ships with the code bundled into the viewer.
        this.emitFile({
          type: 'asset',
          fileName: 'pdfjs/LICENSE',
          source: readFileSync(path.join(pdfjsDirectory, 'LICENSE')),
        });
        for (const [directory, include] of Object.entries(pdfjsAssets)) {
          for (const file of readdirSync(path.join(pdfjsDirectory, directory))) {
            if (!include(file)) continue;
            this.emitFile({
              type: 'asset',
              fileName: `pdfjs/${directory}/${file}`,
              source: readFileSync(path.join(pdfjsDirectory, directory, file)),
            });
          }
        }
      },
    },
  ],
  resolve: {
    alias: {
      '@': path.resolve(rootDirectory, 'src'),
    },
  },
  build: {
    sourcemap: true,
    rollupOptions: {
      // Opened with chrome.tabs.update, so the page needs no web_accessible_resources entry.
      input: { pdf: path.resolve(rootDirectory, 'src/pdf/index.html') },
    },
  },
});
