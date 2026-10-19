import { defineConfig } from 'vitest/config';
export default defineConfig({
  root: import.meta.dirname,
  cacheDir: import.meta.dirname + '/.cache',
  test: { include: ['src/**/*.test.ts'], fileParallelism: false, testTimeout: 30000 },
});
