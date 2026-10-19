import { defineConfig } from 'vitest/config';
/** Full source-root discovery, with this lane's cache kept inside its write boundary. */
export default defineConfig({ root: new URL('../../', import.meta.url).pathname, cacheDir: import.meta.dirname + '/.cache/root', test: {testTimeout:30000, fileParallelism:false} });
