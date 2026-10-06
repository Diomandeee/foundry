import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Real-git suites shell out dozens of times per test (seed + fork +
    // clone + merge); the 5s default flakes under load (39-43/44 wandering
    // failures, all timeouts, never assertion errors). Assertions unchanged.
    testTimeout: 30_000,
  },
});
