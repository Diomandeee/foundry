import { afterEach, describe, expect, it, vi } from "vitest";
import { KGClient } from "./index.js";
import { KgOverlapOracle } from "./overlap.js";
import { intakeTriples, touchTriples, verdictTriples } from "./triples.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

type Call = { url: string; init?: RequestInit };

function stubFetch(handler: (url: string, init?: RequestInit) => unknown) {
  const calls: Call[] = [];
  const fake = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return { ok: true, json: async () => handler(url, init) };
  }) as unknown as typeof fetch;
  vi.stubGlobal("fetch", fake);
  return calls;
}

function headersOf(call: Call): Record<string, string> {
  return (call.init?.headers ?? {}) as Record<string, string>;
}

describe("KGClient auth", () => {
  it("sends a bearer header on all three calls when a token is set", async () => {
    const calls = stubFetch((url) =>
      url.includes("/traverse")
        ? { paths: [], stats: {} }
        : [],
    );
    const kg = new KGClient("http://kg:8002", "sekrit");
    await kg.addTriple({ subject: "a", predicate: "p", object: "b" });
    await kg.query("a");
    await kg.traverse("a", 1);
    expect(calls.length).toBe(3);
    for (const c of calls) {
      expect(headersOf(c)["authorization"]).toBe("Bearer sekrit");
    }
  });

  it("sends no auth header without a token", async () => {
    const calls = stubFetch(() => []);
    const kg = new KGClient("http://kg:8002");
    await kg.addTriple({ subject: "a", predicate: "p", object: "b" });
    await kg.query("a");
    expect(calls.length).toBe(2);
    for (const c of calls) {
      expect("authorization" in headersOf(c)).toBe(false);
    }
  });
});

describe("KGClient shapes", () => {
  it("query unwraps both the bare array and the wrapped form", async () => {
    const bare = [{ subject: "s", predicate: "p", object: "o" }];
    let calls = stubFetch(() => bare);
    expect(await new KGClient("http://kg").query("s")).toEqual(bare);
    expect(calls.length).toBe(1);
    vi.unstubAllGlobals();
    calls = stubFetch(() => ({ triples: bare, total: 1 }));
    expect(await new KGClient("http://kg").query("s")).toEqual(bare);
    expect(calls.length).toBe(1);
  });

  it("traverse normalizes K11 source/target edges and sends both/max_hops", async () => {
    const calls = stubFetch(() => ({
      paths: [{ edges: [{ predicate: "touches", source: "commit:c", target: "path:f" }] }],
      stats: {},
    }));
    const res = await new KGClient("http://kg").traverse("path:f", 2);
    expect(res.paths[0].edges[0]).toMatchObject({
      subject: "commit:c",
      predicate: "touches",
      object: "path:f",
    });
    const body = JSON.parse(String(calls[0].init?.body ?? "{}"));
    expect(body).toMatchObject({ start: "path:f", max_hops: 2, direction: "both" });
  });
});

describe("triple shapes", () => {
  it("verdictTriples covers merge with agent and task links", () => {
    const out = verdictTriples({
      after_sha: "a".repeat(40),
      merged_sha: "b".repeat(40),
      repo: "fork-1",
      verdict: "merge",
      agent_id: "ag",
      task_id: "t1",
    });
    expect(out.map((t) => t.predicate).sort()).toEqual(
      ["by_agent", "for_task", "gate_verdict", "merged_from", "on_repo"].sort(),
    );
    expect(out[0]).toMatchObject({ subject: `commit:${"a".repeat(40)}`, source: "foundry" });
  });

  it("verdictTriples omits absent links on reject", () => {
    const out = verdictTriples({
      after_sha: "a".repeat(40),
      repo: "fork-1",
      verdict: "reject",
    });
    expect(out.map((t) => t.predicate).sort()).toEqual(["gate_verdict", "on_repo"]);
  });

  it("intakeTriples uses prefixed task/repo entities", () => {
    expect(intakeTriples("t1", "base", "t1--a")).toEqual([
      { subject: "task:t1", predicate: "has_fork", object: "repo:t1--a", source: "foundry" },
      { subject: "task:t1", predicate: "on_base", object: "repo:base", source: "foundry" },
    ]);
  });
});

describe("KgOverlapOracle", () => {
  // Live K11 orients hop 0 from the queried path (verified 2026-10-06):
  //   {touches, path:P -> commit:C}, {for_task, commit:C -> task:T}.
  const contenderTraverse = {
    paths: [
      { edges: [{ predicate: "touches", source: "path:a.ts", target: "commit:dead" }] },
      {
        edges: [
          { predicate: "touches", source: "path:a.ts", target: "commit:dead" },
          { predicate: "touches", source: "commit:dead", target: "path:a.ts" },
        ],
      },
      {
        edges: [
          { predicate: "touches", source: "path:a.ts", target: "commit:dead" },
          { predicate: "for_task", source: "commit:dead", target: "task:t2" },
        ],
      },
    ],
    stats: {},
  };

  it("flags a path touched by another same-base task", async () => {
    stubFetch((url) => {
      if (url.includes("/traverse")) return contenderTraverse;
      return [{ subject: "task:t2", predicate: "on_base", object: "repo:base" }];
    });
    const oracle = new KgOverlapOracle(new KGClient("http://kg"));
    const out = await oracle.findContenders({
      baseRepo: "base",
      taskId: "t1",
      paths: ["a.ts"],
      knownCommits: [],
    });
    expect(out).toEqual(["a.ts"]);
  });

  it("ignores legacy commits with no task link", async () => {
    stubFetch((url) => {
      if (url.includes("/traverse")) {
        return {
          paths: [{ edges: [{ predicate: "touches", source: "path:a.ts", target: "commit:old" }] }],
          stats: {},
        };
      }
      return [];
    });
    const oracle = new KgOverlapOracle(new KGClient("http://kg"));
    expect(
      await oracle.findContenders({ baseRepo: "base", taskId: "t1", paths: ["a.ts"], knownCommits: [] }),
    ).toEqual([]);
  });

  it("skips own task, known commits, and unscoped tasks", async () => {
    const calls = stubFetch((url) => {
      if (url.includes("/traverse")) return contenderTraverse;
      return []; // no on_base anywhere: unscoped legacy tasks
    });
    const oracle = new KgOverlapOracle(new KGClient("http://kg"));
    // own task id matches the contender task: no query should fire
    expect(
      await oracle.findContenders({ baseRepo: "base", taskId: "t2", paths: ["a.ts"], knownCommits: [] }),
    ).toEqual([]);
    expect(calls.filter((c) => !c.url.includes("/traverse")).length).toBe(0);
    // known commit: skipped before the scope query
    expect(
      await oracle.findContenders({ baseRepo: "base", taskId: "t1", paths: ["a.ts"], knownCommits: ["dead"] }),
    ).toEqual([]);
    // unscoped foreign task: fail open
    expect(
      await oracle.findContenders({ baseRepo: "base", taskId: "t1", paths: ["a.ts"], knownCommits: [] }),
    ).toEqual([]);
  });

  it("returns survivors on partial outage, null on total outage", async () => {
    stubFetch((url, init) => {
      if (url.includes("/traverse")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        if (body.start === "path:bad.ts") throw new Error("flaky");
        return contenderTraverse;
      }
      return [{ subject: "task:t2", predicate: "on_base", object: "repo:base" }];
    });
    const oracle = new KgOverlapOracle(new KGClient("http://kg"));
    expect(
      await oracle.findContenders({ baseRepo: "base", taskId: "t1", paths: ["bad.ts", "a.ts"], knownCommits: [] }),
    ).toEqual(["a.ts"]);
    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch);
    expect(
      await oracle.findContenders({ baseRepo: "base", taskId: "t1", paths: ["a.ts"], knownCommits: [] }),
    ).toBeNull();
  });

  it("returns null when scope checks fail with no contenders", async () => {
    stubFetch((url) => {
      if (url.includes("/traverse")) return contenderTraverse;
      throw new Error("scope unreadable");
    });
    const oracle = new KgOverlapOracle(new KGClient("http://kg"));
    expect(
      await oracle.findContenders({ baseRepo: "base", taskId: "t1", paths: ["a.ts"], knownCommits: [] }),
    ).toBeNull();
  });
});

describe("touchTriples", () => {
  it("emits one touches triple per path, sorted and deduped", () => {
    expect(touchTriples("d".repeat(40), ["b.ts", "a.ts", "b.ts"])).toEqual([
      { subject: `commit:${"d".repeat(40)}`, predicate: "touches", object: "path:a.ts", source: "foundry" },
      { subject: `commit:${"d".repeat(40)}`, predicate: "touches", object: "path:b.ts", source: "foundry" },
    ]);
  });

  it("emits nothing for empty file lists", () => {
    expect(touchTriples("d".repeat(40), [])).toEqual([]);
  });
});
