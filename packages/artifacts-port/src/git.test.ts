import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitAdapter } from "./git.js";
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
