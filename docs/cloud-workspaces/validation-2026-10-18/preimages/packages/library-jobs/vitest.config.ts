/** Standalone checks stay inside this package; aggregate Foundry discovery also works. */
export default {
  cacheDir: './.cache',
  test: { include: ['src/**/*.test.ts'], cache: false, fsModuleCache: false },
};
