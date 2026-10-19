// End-to-end regression for the judge path: the demo must actually run
// the gate (ticket -> push -> verdict -> base advanced). A missing
// gate-runner bundle used to print empty decisions and exit 0.
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
let root: string;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("graphvc-demo (judge path)", () => {
  it(
    "records a merge verdict and advances base",
    async () => {
      root = mkdtempSync(join(tmpdir(), "foundry-demo-"));
      const { stdout } = await run(
        "npx",
        ["tsx", "tools/graphvc-demo.ts", "--root", root],
        { cwd: process.cwd(), timeout: 120_000 },
      );
      expect(stdout).toContain('"merge"');
      expect(stdout).toContain("Merge fork-1@");
      expect(stdout).toContain("base: initial");
    },
    150_000,
  );
});
