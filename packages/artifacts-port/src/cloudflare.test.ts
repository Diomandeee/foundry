// Only explicit binding results prove absence. Error messages cannot establish
// whether a ref is missing or the repository itself is unavailable.
import { describe, expect, it } from "vitest";
import { cloudflarePort } from "./cloudflare.js";
import { UnsupportedContentError } from "./port.js";

function repoWith(over: Record<string, unknown> = {}) {
  return {
    info: async () => ({
      remote: "https://example.invalid/task-1.git",
      defaultBranch: "main",
      lastPushAt: null,
    }),
    readFile: async () => null,
    log: async () => [],
    readTree: async () => [],
    readCommit: async () => null,
    ...over,
  };
}

function port(over: Record<string, unknown> = {}) {
  return cloudflarePort({
    ARTIFACTS: { get: async () => repoWith(over) },
  } as unknown as { ARTIFACTS: unknown });
}

describe("cloudflarePort missing refs", () => {
  it("reads a branch that does not exist as an empty history", async () => {
    const handle = await port({ log: async () => [] }).get("task-1");
    expect(await handle.history("main", 50)).toEqual([]);
    handle.dispose();
  });

  it("reads a file on a ref that does not exist as absent", async () => {
    const handle = await port({ readFile: async () => null }).get("task-1");
    expect(await handle.readFile("main", "app.ts")).toBeNull();
    handle.dispose();
  });

  it.each([
    new Error("Could not find main."),
    new Error("repository not found"),
    "Could not find main.",
    { status: 404, message: "Could not find main.", toString() { throw new Error("must not stringify"); } },
  ])("preserves missing-looking exceptions without inferring absence (%#)", async error => {
    const handle = await port({
      log: async () => { throw error; },
      readFile: async () => { throw error; },
    }).get("task-1");
    await expect(handle.history("main")).rejects.toBe(error);
    await expect(handle.readFile("main", "app.ts")).rejects.toBe(error);
  });

  it.each([undefined, null, {}])("rejects malformed history results (%#)", async result => {
    const handle = await port({ log: async () => result }).get("task-1");
    await expect(handle.history("main")).rejects.toThrow("history unavailable");
  });

  it("rejects an unavailable file and invalid UTF-8 instead of returning absence", async () => {
    const unavailable = await port({ readFile: async () => undefined }).get("task-1");
    await expect(unavailable.readFile("main", "app.ts")).rejects.toThrow("file unavailable");
    const invalid = await port({ readFile: async () => new Blob([new Uint8Array([0xff])]) }).get("task-1");
    await expect(invalid.readFile("main", "app.ts")).rejects.toThrow();
  });

  it("names content the transport cannot carry with a typed error, unlike an outage", async () => {
    const invalid = await port({ readFile: async () => new Blob([new Uint8Array([0xff, 0xfe])]) }).get("task-1");
    const bad = await invalid.readFile("main", "img.bin").catch((e) => e);
    expect(bad).toBeInstanceOf(UnsupportedContentError);
    expect(bad).toMatchObject({ path: "img.bin", why: "is not UTF-8 text" });
    const big = await port({ readFile: async () => new Blob([new Uint8Array(9 * 1048576)]) }).get("task-1");
    await expect(big.readFile("main", "big.txt")).rejects.toMatchObject({ path: "big.txt", why: "is 9.0 MiB, over the 8 MiB cap" });
    const down = await port({ readFile: async () => undefined }).get("task-1");
    expect(await down.readFile("main", "app.ts").catch((e) => e)).not.toBeInstanceOf(UnsupportedContentError);
  });

  it("preserves exact text bytes including BOM and surrounding whitespace", async () => {
    const content = "\ufeff \nsource\n ";
    const handle = await port({ readFile: async () => new Blob([content]) }).get("task-1");
    expect(await handle.readFile("main", "app.ts")).toBe(content);
  });

  it("still surfaces an outage as a failure, not as an empty repo", async () => {
    const handle = await port({
      log: async () => {
        throw new Error("network unreachable: connect ETIMEDOUT");
      },
    }).get("task-1");
    await expect(handle.history("main", 50)).rejects.toThrow(/timedout/i);
    handle.dispose();
  });

  it("does not swallow a read failure in a file lookup", async () => {
    const handle = await port({
      readFile: async () => {
        throw new Error("internal error: binding unavailable");
      },
    }).get("task-1");
    await expect(handle.readFile("main", "app.ts")).rejects.toThrow(
      /binding unavailable/i,
    );
    handle.dispose();
  });
});

// Review M7: changed paths come from an oid-pruned tree diff, so a repository with
// thousands of files costs only the subtrees that changed.
describe("cloudflarePort tree diff by object id", () => {
  const h = (n: number) => n.toString(16).padStart(40, "0");
  function fakeRepo(trees: Record<string, { name: string; hash: string; type: string; mode: string }[]>,
                    commits: Record<string, { treeHash: string; parents: string[] }>) {
    const reads: string[] = [];
    return {
      reads,
      over: {
        readTree: async (hash: string) => { reads.push(hash); return trees[hash]; },
        readCommit: async (sha: string) => commits[sha] ?? null,
        log: async ({ limit }: { limit: number }) => Object.entries(commits).reverse().slice(0, limit).map(([hash, c]) => ({ hash, message: "", parents: c.parents, treeHash: c.treeHash })),
      },
    };
  }
  const blob = (name: string, n: number) => ({ name, hash: h(n), type: "blob", mode: "100644" });
  const tree = (name: string, hash: string) => ({ name, hash, type: "tree", mode: "040000" });

  it("reads only changed subtrees of a 3000-file repository", async () => {
    const big = Array.from({ length: 3000 }, (_, i) => blob(`f${i}.swift`, 10_000 + i));
    const trees = {
      [h(1)]: [tree("Sources", h(2)), tree("app", h(3))],
      [h(2)]: big,
      [h(3)]: [blob("main.ts", 100)],
      [h(4)]: [tree("Sources", h(2)), tree("app", h(5))],
      [h(5)]: [blob("main.ts", 101), blob("new.ts", 102)],
    };
    const r = fakeRepo(trees, { [h(90)]: { treeHash: h(1), parents: [] }, [h(91)]: { treeHash: h(4), parents: [h(90)] } });
    const handle = await port(r.over).get("motionmixapp");
    const hist = await handle.history("main", 1);
    expect(hist[0].files).toEqual(["app/main.ts", "app/new.ts"]);
    expect(r.reads).not.toContain(h(2));
  });

  it("reports deletions and tree/file swaps", async () => {
    const trees = {
      [h(1)]: [tree("lib", h(2)), blob("gone.txt", 50), blob("x", 51)],
      [h(2)]: [blob("a.ts", 52), blob("b.ts", 53)],
      [h(3)]: [blob("lib", 54), tree("x", h(4))],
      [h(4)]: [blob("y.ts", 55)],
    };
    const r = fakeRepo(trees, { [h(90)]: { treeHash: h(1), parents: [] }, [h(91)]: { treeHash: h(3), parents: [h(90)] } });
    const hist = await (await port(r.over).get("t")).history("main", 1);
    expect(hist[0].files).toEqual(["gone.txt", "lib", "lib/a.ts", "lib/b.ts", "x", "x/y.ts"]);
  });

  it("marks symlinks and submodules however the binding spells their mode", async () => {
    const trees = {
      [h(1)]: [blob("keep.txt", 70)],
      [h(2)]: [blob("keep.txt", 70), { name: "a", hash: h(71), type: "blob", mode: "120000" },
        { name: "b", hash: h(72), type: "symlink", mode: 0o120000 }, { name: "c", hash: h(73), type: "commit", mode: "160000" },
        { name: "d", hash: h(74), type: "blob", mode: 0o100755 }, { name: "e", hash: h(75), type: "exec", mode: "100755" }],
    };
    const r = fakeRepo(trees as never, { [h(90)]: { treeHash: h(1), parents: [] }, [h(91)]: { treeHash: h(2), parents: [h(90)] } });
    const [c] = await (await port(r.over).get("t")).history("main", 1);
    expect(c.files).toEqual(["a", "b", "c", "d", "e"]);
    expect(c.unsupported).toEqual({ a: "symlink", b: "symlink", c: "submodule" });
  });

  it("leaves `unsupported` off a commit of plain files", async () => {
    const trees = { [h(1)]: [], [h(2)]: [blob("x.txt", 80)] };
    const r = fakeRepo(trees, { [h(90)]: { treeHash: h(1), parents: [] }, [h(91)]: { treeHash: h(2), parents: [h(90)] } });
    expect((await (await port(r.over).get("t")).history("main", 1))[0].unsupported).toBeUndefined();
  });

  it("lists every file of a root commit", async () => {
    const trees = { [h(1)]: [tree("d", h(2)), blob("r.md", 60)], [h(2)]: [blob("e.ts", 61)] };
    const r = fakeRepo(trees, { [h(90)]: { treeHash: h(1), parents: [] } });
    const hist = await (await port(r.over).get("t")).history("main", 1);
    expect(hist[0].files).toEqual(["d/e.ts", "r.md"]);
  });

  it("leaves files unknown (never truncated) when a change exceeds the budget or a tree is missing", async () => {
    const huge = Array.from({ length: 6000 }, (_, i) => blob(`g${i}`, 20_000 + i));
    const trees = { [h(1)]: [], [h(2)]: huge };
    const r = fakeRepo(trees, { [h(90)]: { treeHash: h(1), parents: [] }, [h(91)]: { treeHash: h(2), parents: [h(90)] } });
    expect((await (await port(r.over).get("t")).history("main", 1))[0].files).toBeUndefined();
    const m = fakeRepo({ [h(1)]: [tree("d", h(9))] }, { [h(90)]: { treeHash: h(1), parents: [] } });
    expect((await (await port(m.over).get("t")).history("main", 1))[0].files).toBeUndefined();
  });
});
