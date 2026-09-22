import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { crx } from '@crxjs/vite-plugin';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

import manifest from './manifest.config.ts';
import { nativeLocaleMessages } from './src/shared/native-locales.ts';

const rootDirectory = path.dirname(fileURLToPath(import.meta.url));

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
  ],
  resolve: {
    alias: {
      '@': path.resolve(rootDirectory, 'src'),
    },
  },
  build: {
    sourcemap: true,
  },
});
