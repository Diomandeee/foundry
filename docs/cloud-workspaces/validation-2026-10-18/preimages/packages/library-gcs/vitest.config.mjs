// Native config loading avoids generated config bundles in shared node_modules.
export default {
  cacheDir: new URL('./.cache/', import.meta.url).pathname,
  test: {
    include: ['packages/library-gcs/src/index.test.ts'],
    cache: false,
    fsModuleCache: false,
    testTimeout: 5000,
  },
};
