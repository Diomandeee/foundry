// End-to-end regression for the judge path: the demo must actually run
// the gate (ticket -> push -> verdict -> base advanced). A missing
// gate-runner bundle used to print empty decisions and exit 0.
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
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
  it('refuses an existing destination without changing its contents',async()=>{
    root=mkdtempSync(join(tmpdir(),'foundry-demo-preserve-'));
    writeFileSync(join(root,'sentinel'),'preserve existing work');
    await expect(run('./node_modules/.bin/tsx',['tools/graphvc-demo.ts','--root',root,'--lkg',''],{cwd:process.cwd(),timeout:10000})).rejects.toMatchObject({code:1});
    expect(readFileSync(join(root,'sentinel'),'utf8')).toBe('preserve existing work');
  });
  it(
    "records a merge verdict and advances base",
    async () => {
      root = mkdtempSync(join(tmpdir(), "foundry-demo-"));
      const { stdout } = await run(
        "./node_modules/.bin/tsx",
        ["tools/graphvc-demo.ts", "--root", join(root,"demo"), "--lkg", ""],
        { cwd: process.cwd(), timeout: 120_000 },
      );
      expect(stdout).toContain('"merge"');
      expect(stdout).toContain("Merge fork-1@");
      expect(stdout).toContain("base: initial");
      const row=JSON.parse(readFileSync(join(root,'demo','decisions.jsonl'),'utf8').trim());
      expect(row.verdict).toBe('merge');
      expect(row.verification.request.headSha).toBe(row.after_sha);
      expect(row.verification.verdict.checked).toBe(false); // Advisory fixture, never checked-positive evidence.
      expect(JSON.parse(readFileSync(join(root,'demo','decisions.jsonl.verification',row.verification.sha256+'.json'),'utf8'))).toEqual(row.verification);
    },
    150_000,
  );
});
