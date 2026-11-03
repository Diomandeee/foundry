// IsomorphicMerger.merge end to end: clone, admission check, commit and push against real git
// smart-HTTP remotes (git http-backend behind a local server), on the fs the tests use for the rest.
// 2026-11-03: the first deploy from one-foundry errored a lane's second push of content its first push
// had already merged (decision 643); the gate it replaced answered that with the base head.
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { git as sh, serveGit } from "./git-http.testkit.js";
import { IsomorphicMerger } from "./merge.js";

let root: string;
let server: { url: string; close(): Promise<void> };
let url: string;

beforeAll(async () => {
  root = fs.mkdtempSync(join(tmpdir(), "foundry-merge-http-"));
  server = await serveGit(root);
  url = server.url;
});

afterAll(async () => {
  await server.close();
  fs.rmSync(root, { recursive: true, force: true });
});

let n = 0;
let base: string, fork: string, work: string;

beforeEach(() => {
  n += 1;
  base = `base${n}.git`;
  fork = `fork${n}.git`;
  work = join(root, `work${n}`);
  fs.mkdirSync(join(work, "scripts"), { recursive: true });
  sh(work, "init", "-q", "-b", "main");
  fs.writeFileSync(join(work, "app.txt"), "v1\n");
  fs.writeFileSync(join(work, "scripts/tool.sh"), "#!/bin/sh\n");
  fs.chmodSync(join(work, "scripts/tool.sh"), 0o755);
  sh(work, "add", "-A");
  sh(work, "commit", "-q", "-m", "seed");
  sh(root, "clone", "-q", "--bare", work, base);
  sh(root, "clone", "-q", "--bare", work, fork);
});

/** Commit `files` on top of the fork's main in the work tree and push it; returns the new fork head. */
function propose(files: Record<string, string>, exec: string[] = []): string {
  sh(work, "fetch", "-q", join(root, fork), "main");
  sh(work, "reset", "-q", "--hard", "FETCH_HEAD");
  for (const [p, text] of Object.entries(files)) {
    fs.writeFileSync(join(work, p), text);
    fs.chmodSync(join(work, p), exec.includes(p) ? 0o755 : 0o644);
  }
  sh(work, "add", "-A");
  sh(work, "commit", "-q", "--allow-empty", "-m", "proposal");
  sh(work, "push", "-q", "-f", join(root, fork), "HEAD:main");
  return sh(work, "rev-parse", "HEAD");
}

function request(files: Record<string, string>, forkHeadSha: string) {
  return {
    baseName: base, baseRemote: `${url}/${base}`, baseToken: "t?expires=1", baseBranch: "main",
    forkRemote: `${url}/${fork}`, forkToken: "t?expires=1", forkBranch: "main", forkHeadSha,
    files, deletedFiles: [], message: `Merge ${fork}@${forkHeadSha.slice(0, 8)}`, author: "foundry",
    expectedBaseSha: sh(root, "--git-dir", base, "rev-parse", "main"),
  };
}

describe("IsomorphicMerger.merge over smart HTTP", () => {
  const merger = () => new IsomorphicMerger(fs, join(tmpdir(), `foundry-merge-wd-${process.pid}`));

  it("lands an edit to an executable and a new file with their modes", async () => {
    const files = { "scripts/tool.sh": "#!/bin/sh\necho 2\n", "app.txt": "v2\n" };
    const head = propose(files, ["scripts/tool.sh"]);
    const merged = await merger().merge(request(files, head));
    expect(sh(root, "--git-dir", base, "rev-parse", "main")).toBe(merged);
    // Same tree id: every path, blob and mode of the proposal, nothing else.
    expect(sh(root, "--git-dir", base, "rev-parse", `${merged}^{tree}`)).toBe(sh(root, "--git-dir", fork, "rev-parse", `${head}^{tree}`));
  });

  it("answers a re-push of content main already holds with main's head, landing nothing", async () => {
    const files = { "app.txt": "v2\n" };
    const first = propose(files);
    const merged = await merger().merge(request(files, first));
    // The lane amends the same change and pushes it again under a new sha (foundry_ops land attempt 2).
    sh(work, "commit", "-q", "--amend", "--no-edit", "--date=now", "-m", "proposal again");
    sh(work, "push", "-q", "-f", join(root, fork), "HEAD:main");
    const second = sh(work, "rev-parse", "HEAD");
    expect(second).not.toBe(first);
    await expect(merger().merge(request(files, second))).resolves.toBe(merged);
    expect(sh(root, "--git-dir", base, "rev-parse", "main")).toBe(merged);
  });

  it("answers a redelivery of the push it just merged with the same merge", async () => {
    const files = { "app.txt": "v3\n" };
    const head = propose(files);
    const merged = await merger().merge(request(files, head));
    await expect(merger().merge(request(files, head))).resolves.toBe(merged);
  });

  it("refuses a base that moved since the decision", async () => {
    const files = { "app.txt": "v4\n" };
    const head = propose(files);
    const req = request(files, head);
    sh(work, "push", "-q", join(root, base), "HEAD:main");
    await expect(merger().merge(req)).rejects.toThrow(/stale_base/);
  });
});
