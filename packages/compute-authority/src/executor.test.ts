// T5 acceptance: pinned binaries, no -c payloads, discriminated outcomes.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { execBounded } from "./executor.js";

function script(body: string): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "fabric-exec-"));
  const file = join(dir, "job.py");
  writeFileSync(file, body);
  return { dir, file };
}

describe("bounded executor", () => {
  it("runs a pinned script and seals the output", async () => {
    const { dir, file } = script("print('hi')\n");
    const res = await execBounded({ leaseId: "l1", argv: ["python3", file], timeoutMs: 10000, cwd: dir });
    expect(res.outcome).toBe("exited");
    expect(res.exitCode).toBe(0);
    expect(res.resolvedBin).toMatch(/python3$/);
    expect(res.stdoutSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses -c payloads, absolute paths, and unknown binaries", async () => {
    for (const argv of [
      ["python3", "-c", "print(1)"],
      ["/usr/bin/python3", "-V"],
      ["curl", "http://x"],
    ]) {
      const res = await execBounded({ leaseId: "l", argv, timeoutMs: 5000, cwd: "/tmp" });
      expect(res.outcome).toBe("start-failed");
      expect(res.exitCode).toBeNull();
    }
  });

  it("reports launch failure distinctly, never exit 0", async () => {
    const { dir } = script("print(1)\n");
    const res = await execBounded({
      leaseId: "l", argv: ["git", "--git-dir=/nonexistent-xyz", "status"], timeoutMs: 10000, cwd: dir,
    });
    // git exits nonzero on bad dir (not start-failed): outcome exited, code != 0.
    expect(["exited", "start-failed"]).toContain(res.outcome);
    expect(res.exitCode === 0 && res.outcome === "exited").toBe(false);
  });

  it("kills on timeout with timed-out outcome", async () => {
    const { dir, file } = script("import time; time.sleep(30)\n");
    const res = await execBounded({ leaseId: "l3", argv: ["python3", file], timeoutMs: 1500, cwd: dir });
    expect(res.outcome).toBe("timed-out");
    expect(res.exitCode).toBeNull();
  }, 15000);
});
