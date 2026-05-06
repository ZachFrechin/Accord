import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    exclude: ['**/node_modules/**', '**/dist/**', '**/coverage/**'],
  },
  resolve: {
    alias: {
      '@discord2/config': new URL('./packages/config/src/index.ts', import.meta.url).pathname,
      '@discord2/db': new URL('./packages/db/src/index.ts', import.meta.url).pathname,
      '@discord2/domain': new URL('./packages/domain/src/index.ts', import.meta.url).pathname,
      '@discord2/e2ee': new URL('./packages/e2ee/src/index.ts', import.meta.url).pathname,
      '@discord2/shared': new URL('./packages/shared/src/index.ts', import.meta.url).pathname,
    },
  },
});
