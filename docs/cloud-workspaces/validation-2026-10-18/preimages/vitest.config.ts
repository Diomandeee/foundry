import { defineConfig } from "vitest/config";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// This working copy may share a node_modules symlink with another checkout, so
// bare @foundry/* imports must be pinned to THIS tree or tests silently exercise
// a different repository at the same base commit.
const root = dirname(fileURLToPath(import.meta.url));
const local = (path: string) => join(root, path);
const alias = [
  { find: /^@foundry\/artifacts-port\/node$/, replacement: local("packages/artifacts-port/src/node.ts") },
  ...["artifacts-port", "stores", "gate-ts", "lkg-client", "plan-check", "verify", "evidence"].map(name => ({
    find: new RegExp(`^@foundry/${name}$`),
    replacement: local(`packages/${name}/src/index.ts`),
  })),
];

export default defineConfig({
  resolve: { alias },
  test: {
    // Real-git suites shell out dozens of times per test (seed + fork +
    // clone + merge); the 5s default flakes under load (39-43/44 wandering
    // failures, all timeouts, never assertion errors). Assertions unchanged.
    testTimeout: 30_000,
  },
});
