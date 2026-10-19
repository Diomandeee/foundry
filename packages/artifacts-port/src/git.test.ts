import { chmodSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitAdapter, runGit } from "./git.js";
import { GitTestKit } from "./testing.js";
import { toPushEvent } from "./port.js";

let root: string;
let adapter: GitAdapter;
let kit: GitTestKit;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "foundry-git-"));
  adapter = new GitAdapter(root);
  kit = new GitTestKit(root, adapter);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("GitAdapter", () => {
  it("creates, gets, and lists repos", async () => {
    const created = await adapter.create("base", { defaultBranch: "main" });
    expect(created.remote.endsWith("base.git")).toBe(true);
    const handle = await adapter.get("base");
    expect((await handle.info()).defaultBranch).toBe("main");
    expect(await adapter.list()).toEqual(["base"]);
    handle.dispose();
  });

  it("rejects duplicate creates and unknown gets", async () => {
    await adapter.create("base");
    await expect(adapter.create("base")).rejects.toThrow("already exists");
    await expect(adapter.get("nope")).rejects.toThrow("not found");
  });

  it("represents unborn branches and unknown SHAs as explicit absence", async () => {
    await adapter.create("empty");
    const repo = await adapter.get("empty");
    expect(await repo.info()).toEqual({ defaultBranch: "main", lastPushAt: null });
    for (const ref of ["main", "refs/heads/main", "missing", "b".repeat(40)]) {
      expect(await repo.history(ref)).toEqual([]);
      expect(await repo.readFile(ref, "AGENTS.md")).toBeNull();
    }
  });

  it("distinguishes missing refs from readable immutable commits in a populated repo", async () => {
    const sha = await kit.seedBase("base", { "a.txt": " \nhello\n " }, join(root, "w"));
    const repo = await adapter.get("base");
    for (const ref of [sha, sha.toUpperCase(), "refs/heads/main"]) {
      expect((await repo.history(ref, 1)).map(c => c.sha)).toEqual([sha]);
      expect(await repo.readFile(ref, "a.txt")).toBe(" \nhello\n ");
      expect(await repo.readFile(ref, "missing.txt")).toBeNull();
    }
    for (const ref of ["absent", "refs/heads/absent", "b".repeat(40)]) {
      expect(await repo.history(ref)).toEqual([]);
      expect(await repo.readFile(ref, "a.txt")).toBeNull();
    }
    expect((await repo.info()).lastPushAt).toMatch(/^\d{4}-/);
  });

  it("does not resolve a branch lookup through a same-named tag", async () => {
    const work = join(root, "w");
    const first = await kit.seedBase("base", { "a.txt": "first" }, work);
    const second = kit.commitAll(work, "second", { "a.txt": "second" });
    runGit([`--git-dir=${kit.bare("base")}`, "update-ref", "refs/tags/main", first]);
    const repo = await adapter.get("base");
    expect((await repo.history("main", 1))[0].sha).toBe(second);
    expect(await repo.readFile("main", "a.txt")).toBe("second");
  });

  it("propagates repository loss for branch and SHA lookups", async () => {
    await adapter.create("base");
    const repo = await adapter.get("base");
    renameSync(kit.bare("base"), join(root, "moved.git"));
    for (const ref of ["main", "b".repeat(40)]) {
      await expect(repo.history(ref)).rejects.toThrow();
      await expect(repo.readFile(ref, "a.txt")).rejects.toThrow();
    }
    await expect(repo.info()).rejects.toThrow();
  });

  it("propagates dangling ref corruption rather than claiming an empty repo", async () => {
    await adapter.create("base");
    const repo = await adapter.get("base");
    writeFileSync(join(kit.bare("base"), "refs/heads/main"), `${"b".repeat(40)}\n`);
    await expect(repo.history("main")).rejects.toThrow();
    await expect(repo.readFile("main", "missing.txt")).rejects.toThrow();
    await expect(repo.info()).rejects.toThrow();
  });

  it("rejects corrupt objects even when batch lookup reports missing", async () => {
    const sha = await kit.seedBase("base", { "a.txt": "x" }, join(root, "w"));
    const repo = await adapter.get("base");
    const objectPath = join(kit.bare("base"), "objects", sha.slice(0, 2), sha.slice(2));
    chmodSync(objectPath, 0o600);
    writeFileSync(objectPath, "corrupt");
    for (const ref of [sha, "main"]) {
      await expect(repo.history(ref)).rejects.toThrow();
      await expect(repo.readFile(ref, "missing.txt")).rejects.toThrow();
    }
  });

  it("rejects blob and tree object IDs instead of treating them as missing commits", async () => {
    const sha = await kit.seedBase("base", { "a.txt": "x" }, join(root, "w"));
    const repo = await adapter.get("base");
    for (const revision of [`${sha}:a.txt`, `${sha}^{tree}`]) {
      const oid = runGit([`--git-dir=${kit.bare("base")}`, "rev-parse", revision]);
      await expect(repo.history(oid)).rejects.toThrow("expected a commit object");
      await expect(repo.readFile(oid, "missing.txt")).rejects.toThrow("expected a commit object");
    }
  });

  it("commits, reads files, and tracks history with paths", async () => {
    const work = join(root, "w");
    await adapter.create("base");
    kit.cloneTo("base", work);
    const c1 = kit.commitAll(work, "first", { "a.txt": "hello" });
    const c2 = kit.commitAll(work, "second", { "b.txt": "world" });
    const repo = await adapter.get("base");
    expect(await repo.readFile("main", "a.txt")).toBe("hello");
    expect(await repo.readFile("main", "missing")).toBeNull();
    const hist = await repo.history("main");
    expect(hist.map((c) => c.sha)).toEqual([c2, c1]);
    expect(hist[0].files).toEqual(["b.txt"]);
    expect(hist[1].parents).toEqual([]);
    expect(hist[0].parents).toEqual([c1]);
    repo.dispose();
  });

  it("forks carry history and diverge independently", async () => {
    const work = join(root, "w");
    const forkWork = join(root, "w-fork");
    const baseSha = await kit.seedBase("base", { "a.txt": "v1" }, work);
    const base = await adapter.get("base");
    const fork = await base.fork("task-1");
    base.dispose();
    expect(fork.remote.endsWith("task-1.git")).toBe(true);
    kit.cloneTo("task-1", forkWork);
    kit.commitAll(forkWork, "diverge", { "a.txt": "v2" });
    const forked = await adapter.get("task-1");
    const baseAgain = await adapter.get("base");
    expect(await forked.readFile("main", "a.txt")).toBe("v2");
    expect(await baseAgain.readFile("main", "a.txt")).toBe("v1");
    expect((await forked.history("main")).length).toBe(2);
    expect((await baseAgain.history("main")).length).toBe(1);
    expect((await forked.history("main"))[1].sha).toBe(baseSha);
    forked.dispose();
    baseAgain.dispose();
  });

  it("issues scoped tokens and deletes repos", async () => {
    await adapter.create("base");
    const repo = await adapter.get("base");
    const tok = await repo.createToken("write", 60);
    expect(tok.startsWith("local_write_60_")).toBe(true);
    repo.dispose();
    await adapter.delete("base");
    expect(await adapter.list()).toEqual([]);
  });

  it("ignores GIT_DIR inherited from hooks", async () => {
    const prev = process.env.GIT_DIR;
    process.env.GIT_DIR = ".";
    try {
      const work = join(root, "w");
      await adapter.create("g");
      kit.cloneTo("g", work);
      const sha = kit.commitAll(work, "s", { "a.txt": "x" });
      expect(sha).toMatch(/^[0-9a-f]{40}$/);
      const repo = await adapter.get("g");
      expect((await repo.history("main")).length).toBe(1);
      repo.dispose();
    } finally {
      if (prev === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = prev;
    }
  });

  it("prefixes remotes with host when configured", async () => {
    const hosted = new GitAdapter(root, "git@k11:/srv/foundry");
    const created = await hosted.create("h");
    expect(created.remote).toBe("git@k11:/srv/foundry/h.git");
    const h = await hosted.get("h");
    expect(h.remote).toBe("git@k11:/srv/foundry/h.git");
    const fork = await h.fork("h2");
    expect(fork.remote).toBe("git@k11:/srv/foundry/h2.git");
    h.dispose();
  });
});

describe("toPushEvent", () => {
  it("normalizes Artifacts push events", () => {
    const e = toPushEvent("ns", {
      type: "cf.artifacts.repo.pushed",
      source: { namespace: "ns", repoName: "task-1" },
      payload: { ref: "refs/heads/main", before: "a", after: "b" },
    });
    expect(e).toEqual({
      namespace: "ns",
      repo: "task-1",
      ref: "refs/heads/main",
      before: "a",
      after: "b",
    });
  });

  it("accepts local demo events and rejects others", () => {
    expect(
      toPushEvent("ns", {
        type: "foundry.local.pushed",
        source: { repoName: "r" },
        payload: { after: "b" },
      }),
    ).not.toBeNull();
    expect(toPushEvent("ns", { type: "cf.artifacts.repo.created" })).toBeNull();
    expect(
      toPushEvent("ns", {
        type: "cf.artifacts.repo.pushed",
        source: {},
        payload: {},
      }),
    ).toBeNull();
  });
});
