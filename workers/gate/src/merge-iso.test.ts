// commitForkFiles test: init a repo with isomorphic-git, seed one commit,
// then apply fork files and verify the squash-commit + contents.
// Clone/push transport (http-only remotes) is verified at the Paid spike.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fs from "node:fs";
import git from "isomorphic-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commitForkFiles, tokenSecret } from "./merge.js";

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

describe("commitForkFiles replay boundary", () => {
  it.each(["same", "different"])("requires caller-proven replay for the %s proposal with identical content", async proposal => {
    const head = "f".repeat(40);
    const first = await commitForkFiles(
      fs,
      dir,
      { "feat.txt": "new\n" },
      "Merge task-1",
      "foundry",
      head,
    );
    // Only the merger can prove the full parent/tree relationship. This helper
    // cannot infer a valid replay from unchanged content and a trailer alone.
    await expect(commitForkFiles(
      fs,
      dir,
      { "feat.txt": "new\n" },
      "Merge task-1",
      "foundry",
      proposal === "same" ? head : "e".repeat(40),
    )).rejects.toThrow("no changed tree and no proven replay");
    expect(await git.resolveRef({ fs, dir, ref: "HEAD" })).toBe(first);
    const log = await git.log({ fs, dir, depth: 3 });
    expect(log.length).toBe(2); // seed + one merge, not two
  });

  it("refuses unchanged content without proposal provenance", async () => {
    const before = await git.resolveRef({ fs, dir, ref: "HEAD" });
    await expect(commitForkFiles(fs, dir, { "app.txt": "v1\n" }, "Merge", "foundry", "f".repeat(40)))
      .rejects.toThrow("no changed tree and no proven replay");
    expect(await git.resolveRef({ fs, dir, ref: "HEAD" })).toBe(before);
    expect((await git.log({ fs, dir })).length).toBe(1);
  });
});
