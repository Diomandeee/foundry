// commitForkFiles test: init a repo with isomorphic-git, seed one commit,
// then apply fork files and verify the squash-commit + contents.
// Clone/push transport (http-only remotes) is verified at the Paid spike.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fs from "node:fs";
import git from "isomorphic-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { admissionOverlay, assertLanded, commitForkFiles, completeTree, proposalModes, tokenSecret } from "./merge.js";

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

  it("lands a mode-only change (chmod +x with identical content)", async () => {
    const before = await git.resolveRef({ fs, dir, ref: "HEAD" });
    const sha = await commitForkFiles(fs, dir, { "app.txt": "v1\n" }, "M", "foundry", "d".repeat(40), [], { "app.txt": "100755" });
    expect(sha).not.toBe(before);
    expect(await modeOf("app.txt")).toBe(0o100755);
    // Landed, the mode no longer differs: a redelivery is refused here like any unchanged tree.
    // merge() proves the replay against the base's Fork-Head first (see "commitForkFiles replay boundary").
    await expect(commitForkFiles(fs, dir, { "app.txt": "v1\n" }, "M", "foundry", "d".repeat(40), [], { "app.txt": "100755" }))
      .rejects.toThrow("no changed tree and no proven replay");
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

// 2026-11-03: epoch-live decisions 562/590/600 reported MERGE but landed none of the files they added under
// scripts/, src/ and test/. The base carries an allowlist .gitignore (`/*` then `!/scripts/`), and
// isomorphic-git's add applied it to untracked paths: its parent check asks about "scripts" without the
// trailing slash, so `!/scripts/` never matches and every new nested file was skipped in silence.
describe("an allowlist .gitignore on the base", () => {
  const GITIGNORE = "/*\n!/.gitignore\n!/README.md\n!/src/\n!/scripts/\n!/test/\n*.log\n";

  async function seedAllowlistBase() {
    fs.writeFileSync(join(dir, ".gitignore"), GITIGNORE);
    fs.writeFileSync(join(dir, "README.md"), "r\n");
    fs.mkdirSync(join(dir, "src"));
    fs.mkdirSync(join(dir, "scripts"));
    fs.writeFileSync(join(dir, "src/a.txt"), "a1\n");
    fs.writeFileSync(join(dir, "src/old.txt"), "rename me\n");
    fs.writeFileSync(join(dir, "src/del.txt"), "delete me\n");
    fs.writeFileSync(join(dir, "scripts/tool.sh"), "#!/bin/sh\n");
    for (const p of [".gitignore", "README.md", "src/a.txt", "src/old.txt", "src/del.txt", "scripts/tool.sh"]) {
      await git.add({ fs, dir, filepath: p, force: true });
    }
    return git.commit({ fs, dir, message: "seed allowlist", author: { name: "t", email: "t@t" } });
  }

  async function treeOf(sha: string) {
    const out: Record<string, { mode: string; text: string }> = {};
    await git.walk({ fs, dir, trees: [git.TREE({ ref: sha })],
      map: async (path, [e]) => {
        if (e && (await e.type()) === "blob") {
          out[path] = {
            mode: ((await e.mode()) as number).toString(8),
            text: new TextDecoder().decode((await e.content()) as Uint8Array),
          };
        }
        return true;
      } });
    return out;
  }

  it("lands added (nested, new dir, ignored-at-root), modified, deleted, renamed and chmod'd files", async () => {
    const base = await seedAllowlistBase();
    const files = {
      "src/new.txt": "new nested\n",          // new file in an allowlisted directory
      "scripts/run.sh": "#!/bin/sh\necho\n",  // new executable
      "test/new.test.mjs": "test\n",          // new file in a directory the base lacks
      "notes.md": "root\n",                   // the base's rules ignore it; the proposal tracks it
      "src/a.txt": "a2\n",                    // modified
      "src/renamed.txt": "rename me\n",       // rename target
      "scripts/tool.sh": "#!/bin/sh\n",       // mode-only change
    };
    const modes = { "scripts/run.sh": "100755", "scripts/tool.sh": "100755" } as const;
    const sha = await commitForkFiles(fs, dir, files, "Merge", "foundry", "f".repeat(40),
      ["src/del.txt", "src/old.txt"], modes);
    expect(sha).not.toBe(base);
    const tree = await treeOf(sha);
    expect(Object.keys(tree).sort()).toEqual([
      ".gitignore", "README.md", "app.txt", "notes.md", "scripts/run.sh", "scripts/tool.sh",
      "src/a.txt", "src/new.txt", "src/renamed.txt", "test/new.test.mjs",
    ]);
    for (const [p, text] of Object.entries(files)) {
      expect(tree[p].text, p).toBe(text);
      expect(tree[p].mode, p).toBe((modes as Record<string, string>)[p] ?? "100644");
    }
  });

  it("a restore-only landing of added files is not an empty merge", async () => {
    const base = await seedAllowlistBase();
    const sha = await commitForkFiles(fs, dir, { "src/lease.mjs": "x\n", "test/lease.test.mjs": "t\n" },
      "Merge", "foundry", "e".repeat(40));
    expect(sha).not.toBe(base);
    const tree = await treeOf(sha);
    expect(tree["src/lease.mjs"]?.text).toBe("x\n");
    expect(tree["test/lease.test.mjs"]?.text).toBe("t\n");
    const { commit } = await git.readCommit({ fs, dir, oid: sha });
    const { commit: parent } = await git.readCommit({ fs, dir, oid: base });
    expect(commit.tree).not.toBe(parent.tree);
  });
});

describe("assertLanded", () => {
  it("refuses a commit that lacks an admitted file, holds a stale blob or mode, or keeps a deletion", async () => {
    const head = await git.resolveRef({ fs, dir, ref: "HEAD" });
    await expect(assertLanded(fs, dir, head, { "app.txt": "v1\n" }, [], {})).resolves.toBeUndefined();
    await expect(assertLanded(fs, dir, head, { "missing.txt": "m\n" }, [], {})).rejects.toThrow(/missing\.txt.*absent/);
    await expect(assertLanded(fs, dir, head, { "app.txt": "v2\n" }, [], {})).rejects.toThrow(/app\.txt.*blob/);
    await expect(assertLanded(fs, dir, head, { "app.txt": "v1\n" }, [], { "app.txt": "100755" }))
      .rejects.toThrow(/app\.txt.*mode/);
    await expect(assertLanded(fs, dir, head, {}, ["app.txt"], {})).rejects.toThrow(/app\.txt.*still/);
  });
});

describe("path shape changes and redelivery", () => {
  it("turns a file into a directory and a directory into a file", async () => {
    fs.mkdirSync(join(dir, "d"));
    fs.writeFileSync(join(dir, "d/only.txt"), "x\n");
    await git.add({ fs, dir, filepath: "d/only.txt" });
    await git.commit({ fs, dir, message: "s", author: { name: "t", email: "t@t" } });
    const sha = await commitForkFiles(fs, dir, { "app.txt/inner.txt": "in\n", "d": "now a file\n" }, "M", "foundry",
      "f".repeat(40), ["app.txt", "d/only.txt"]);
    const files = (await git.listFiles({ fs, dir, ref: sha })).sort();
    expect(files).toEqual(["app.txt/inner.txt", "d"]);
  });

  it("re-landing a change the old merger dropped adds the missing files", async () => {
    fs.writeFileSync(join(dir, ".gitignore"), "/*\n!/.gitignore\n!/app.txt\n!/src/\n");
    await git.add({ fs, dir, filepath: ".gitignore" });
    await git.commit({ fs, dir, message: "allowlist", author: { name: "t", email: "t@t" } });
    // What a dropped landing left behind: a merge commit with the edit but not the nested add.
    const dropped = await commitForkFiles(fs, dir, { "app.txt": "v2\n" }, "M", "foundry", "a".repeat(40));
    const sha = await commitForkFiles(fs, dir, { "app.txt": "v2\n", "src/lease.mjs": "lease\n" }, "M", "foundry",
      "b".repeat(40));
    expect(sha).not.toBe(dropped);
    expect(await git.listFiles({ fs, dir, ref: sha })).toContain("src/lease.mjs");
  });
});

describe("on memfs (the Worker's fs)", () => {
  it("lands new nested files under an allowlist .gitignore with their modes", async () => {
    const { memfs } = await import("memfs");
    const { fs: mfs } = memfs();
    const m = mfs as unknown as typeof fs;
    const d = "/base";
    await git.init({ fs: m, dir: d, defaultBranch: "main" });
    m.mkdirSync(`${d}/scripts`, { recursive: true });
    m.writeFileSync(`${d}/.gitignore`, "/*\n!/.gitignore\n!/scripts/\n");
    m.writeFileSync(`${d}/scripts/old.sh`, "old\n");
    await git.add({ fs: m, dir: d, filepath: ".gitignore" });
    await git.add({ fs: m, dir: d, filepath: "scripts/old.sh", force: true });
    await git.commit({ fs: m, dir: d, message: "s", author: { name: "t", email: "t@t" } });
    const sha = await commitForkFiles(m, d, { "scripts/new.sh": "#!/bin/sh\n", "test/a.test.mjs": "t\n" }, "M",
      "foundry", "c".repeat(40), [], { "scripts/new.sh": "100755" });
    await assertLanded(m, d, sha, { "scripts/new.sh": "#!/bin/sh\n", "test/a.test.mjs": "t\n" }, [],
      { "scripts/new.sh": "100755" });
    expect((await git.listFiles({ fs: m, dir: d, ref: sha })).sort())
      .toEqual([".gitignore", "scripts/new.sh", "scripts/old.sh", "test/a.test.mjs"]);
  });
});

// merge() admits only what admissionOverlay predicts and refuses a landed tree that differs from it. The
// overlay first shipped refusing every executable, so a merge touching one of motionmixapp's 67 scripts
// would have errored and retried forever; it also refused file -> directory changes 9fe6444 lands.
describe("admissionOverlay agrees with what commitForkFiles lands", () => {
  async function blob(text: string) {
    return (await git.hashBlob({ object: new TextEncoder().encode(text) })).oid;
  }

  async function landAndCompare(files: Record<string, string>, deletedFiles: string[], modes: Record<string, "100644" | "100755">) {
    const head = await git.resolveRef({ fs, dir, ref: "HEAD" });
    const base = await completeTree(fs, dir, head);
    const proposal = new Map(base);
    for (const p of deletedFiles) proposal.delete(p);
    for (const [p, text] of Object.entries(files)) proposal.set(p, `${modes[p] ?? "100644"} blob ${await blob(text)}`);
    const expected = await admissionOverlay(base, proposal, { files, deletedFiles });
    const sha = await commitForkFiles(fs, dir, files, "M", "foundry", "f".repeat(40), deletedFiles, modes);
    expect(Object.fromEntries(await completeTree(fs, dir, sha))).toEqual(Object.fromEntries(expected));
    return expected;
  }

  it("admits a new executable and an edit to an existing one", async () => {
    fs.mkdirSync(join(dir, "scripts"));
    fs.writeFileSync(join(dir, "scripts/tool.sh"), "#!/bin/sh\n");
    fs.chmodSync(join(dir, "scripts/tool.sh"), 0o755);
    await git.add({ fs, dir, filepath: "scripts/tool.sh" });
    await git.commit({ fs, dir, message: "x", author: { name: "t", email: "t@t" } });
    const expected = await landAndCompare(
      { "scripts/tool.sh": "#!/bin/sh\necho 2\n", "scripts/new.sh": "#!/bin/sh\n", "app.txt": "v2\n" }, [],
      { "scripts/tool.sh": "100755", "scripts/new.sh": "100755" });
    expect(expected.get("scripts/tool.sh")).toMatch(/^100755 blob /);
    expect(expected.get("app.txt")).toMatch(/^100644 blob /);
  });

  it("admits a file -> directory change and its reverse when the old shape is deleted", async () => {
    fs.mkdirSync(join(dir, "d"));
    fs.writeFileSync(join(dir, "d/only.txt"), "x\n");
    await git.add({ fs, dir, filepath: "d/only.txt" });
    await git.commit({ fs, dir, message: "s", author: { name: "t", email: "t@t" } });
    await landAndCompare({ "app.txt/inner.txt": "in\n", "d": "now a file\n" }, ["app.txt", "d/only.txt"], {});
  });

  it("refuses a path that would be both a file and a directory, a symlink, and substituted text", async () => {
    const head = await git.resolveRef({ fs, dir, ref: "HEAD" });
    const base = await completeTree(fs, dir, head);
    const inner = new Map(base).set("app.txt/inner.txt", `100644 blob ${await blob("in\n")}`);
    await expect(admissionOverlay(base, inner, { files: { "app.txt/inner.txt": "in\n" }, deletedFiles: [] }))
      .rejects.toThrow(/ancestor is not directory/);
    const link = new Map(base).set("l", `120000 blob ${await blob("app.txt")}`);
    await expect(admissionOverlay(base, link, { files: { l: "app.txt" }, deletedFiles: [] }))
      .rejects.toThrow(/unsupported or substituted/);
    const swapped = new Map(base).set("app.txt", `100755 blob ${await blob("v2\n")}`);
    await expect(admissionOverlay(base, swapped, { files: { "app.txt": "v3\n" }, deletedFiles: [] }))
      .rejects.toThrow(/unsupported or substituted/);
  });
});
