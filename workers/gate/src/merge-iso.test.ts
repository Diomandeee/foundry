// commitForkFiles test: init a repo with isomorphic-git, seed one commit,
// then apply fork files and verify the squash-commit + contents.
// Clone/push transport (http-only remotes) is verified at the Paid spike.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fs from "node:fs";
import git from "isomorphic-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commitForkFiles, proposalModes, tokenSecret } from "./merge.js";

let dir: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "foundry-iso-"));
  await git.init({ fs, dir, defaultBranch: "main" });
  fs.writeFileSync(join(dir, "app.txt"), "v1\n");
  await git.add({ fs, dir, filepath: "app.txt" });
  await git.commit({
    fs,
    dir,
    message: "seed",
    author: { name: "t", email: "t@t" },
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("commitForkFiles", () => {
  it("lands fork files as one commit on base", async () => {
    const sha = await commitForkFiles(
      fs,
      dir,
      { "feat.txt": "new\n", "nested/deep.txt": "deep\n" },
      "Merge task-1",
      "foundry",
      "f".repeat(40),
    );
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    const log = await git.log({ fs, dir, depth: 2 });
    expect(log.length).toBe(2);
    expect(log[0].commit.message).toContain("Merge task-1");
    expect(log[0].commit.message).toContain(`Fork-Head: ${"f".repeat(40)}`);
    expect(fs.readFileSync(join(dir, "feat.txt"), "utf8")).toBe("new\n");
    expect(fs.readFileSync(join(dir, "nested/deep.txt"), "utf8")).toBe("deep\n");
    expect(fs.readFileSync(join(dir, "app.txt"), "utf8")).toBe("v1\n");
  });

  it("removes deleted files", async () => {
    const sha = await commitForkFiles(
      fs,
      dir,
      { "new.txt": "n\n" },
      "Merge",
      "foundry",
      "f".repeat(40),
      ["app.txt"],
    );
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    const files = await git.listFiles({ fs, dir, ref: sha });
    expect(files).toContain("new.txt");
    expect(files).not.toContain("app.txt");
    expect(fs.readFileSync(join(dir, "new.txt"), "utf8")).toBe("n\n");
  });

  it("strips token expiry metadata for git auth", () => {
    expect(tokenSecret("art_v1_abc?expires=123")).toBe("art_v1_abc");
    expect(tokenSecret("plain")).toBe("plain");
  });
});

describe("commitForkFiles idempotency", () => {
  it("returns the current head instead of an empty commit", async () => {
    const head = "f".repeat(40);
    const first = await commitForkFiles(
      fs,
      dir,
      { "feat.txt": "new\n" },
      "Merge task-1",
      "foundry",
      head,
    );
    // Redelivery after the merge already landed: same content, no commit.
    const second = await commitForkFiles(
      fs,
      dir,
      { "feat.txt": "new\n" },
      "Merge task-1",
      "foundry",
      head,
    );
    expect(second).toBe(first);
    const log = await git.log({ fs, dir, depth: 3 });
    expect(log.length).toBe(2); // seed + one merge, not two
  });
});

describe("file modes", () => {
  async function modeOf(path: string) {
    const head = await git.resolveRef({ fs, dir, ref: "HEAD" });
    const files = await git.walk({ fs, dir, trees: [git.TREE({ ref: head })],
      map: async (p, [e]) => (p === path ? e!.mode() : undefined) });
    return (files as number[]).find((m) => m !== undefined);
  }

  it("lands a new executable as 100755 and keeps an edited file 100644", async () => {
    await commitForkFiles(fs, dir, { "run.sh": "#!/bin/sh\n", "app.txt": "v2\n" }, "Merge", "foundry",
      "f".repeat(40), [], { "run.sh": "100755", "app.txt": "100644" });
    expect(await modeOf("run.sh")).toBe(0o100755);
    expect(await modeOf("app.txt")).toBe(0o100644);
  });

  it("drops the bit when the proposal made a file non-executable", async () => {
    await commitForkFiles(fs, dir, { "run.sh": "#!/bin/sh\n" }, "M", "foundry", "f".repeat(40), [], { "run.sh": "100755" });
    await commitForkFiles(fs, dir, { "run.sh": "#!/bin/sh\necho\n" }, "M", "foundry", "e".repeat(40), [], { "run.sh": "100644" });
    expect(await modeOf("run.sh")).toBe(0o100644);
  });

  it("reads modes from the proposal commit and refuses symlinks and substituted text", async () => {
    fs.mkdirSync(join(dir, "bin"));
    fs.writeFileSync(join(dir, "bin/tool"), "#!/bin/sh\n", { mode: 0o755 });
    fs.symlinkSync("../app.txt", join(dir, "bin/link"));
    await git.add({ fs, dir, filepath: "bin/tool" });
    await git.add({ fs, dir, filepath: "bin/link" });
    const sha = await git.commit({ fs, dir, message: "p", author: { name: "t", email: "t@t" } });
    expect(await proposalModes(fs, dir, sha, { "bin/tool": "#!/bin/sh\n", "app.txt": "v1\n" }))
      .toEqual({ "bin/tool": "100755", "app.txt": "100644" });
    await expect(proposalModes(fs, dir, sha, { "bin/link": "../app.txt" })).rejects.toThrow(/unsupported proposal entry/);
    await expect(proposalModes(fs, dir, sha, { "app.txt": "other\n" })).rejects.toThrow(/differs from proposal blob/);
    await expect(proposalModes(fs, dir, sha, { "nope/x": "x" })).rejects.toThrow(/no directory|unsupported/);
  });
});
