import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    envDir: resolve(__dirname, '../..'),
    plugins: [react()],
    resolve: {
      alias: {
        '@discord2/config': resolve(__dirname, '../../packages/config/src/index.ts'),
        '@discord2/e2ee': resolve(__dirname, '../../packages/e2ee/src/index.ts'),
        '@discord2/shared': resolve(__dirname, '../../packages/shared/src/index.ts'),
      },
    },
  },
});
