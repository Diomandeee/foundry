import { afterEach, describe, expect, it, vi } from "vitest";
import { PactServerPlanCheck, StubPlanCheck, usable } from "./index.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("StubPlanCheck", () => {
  it("passes unchecked", async () => {
    const v = await new StubPlanCheck().check(["chain:genesis"]);
    expect(v).toMatchObject({ checked: false, ok: true });
    expect(v.results).toEqual([{ name: "chain:genesis", found: true }]);
  });
});

describe("PactServerPlanCheck", () => {
  function stub(status: number, body: unknown) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fake = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: status >= 200 && status < 300, status, json: async () => body };
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fake);
    return calls;
  }

  const full = { name: "c:a", found: true, present: 4, missing: [], typechecks: true, word: "w" };

  it("passes when every chain is found and typechecking", async () => {
    const calls = stub(200, { results: [full, { ...full, name: "c:b" }] });
    const v = await new PactServerPlanCheck("http://pact:8730").check(["c:a", "c:b"]);
    expect(v).toMatchObject({ checked: true, ok: true });
    expect(calls[0].url).toBe("http://pact:8730/api/check-chains");
    expect(JSON.parse(String(calls[0].init?.body ?? "{}"))).toEqual({ chains: ["c:a", "c:b"] });
  });

  it("fails on unknown or non-typechecking chains", async () => {
    const cases = [
      [{ ...full, found: false }],
      [{ ...full, typechecks: false }],
    ];
    for (const results of cases) {
      stub(200, { results });
      const v = await new PactServerPlanCheck("http://p").check(["c:a"]);
      expect(v.ok).toBe(false);
      expect(v.checked).toBe(true);
      vi.unstubAllGlobals();
    }
  });

  it("passes a pipeline that lacks canonical stages (finding 0009)", async () => {
    // chain:deep-research as pact-server answered it on 2026-11-05: 0/4 stages, typechecks.
    const pipeline = { name: "c:a", found: true, present: 0, typechecks: true, word: "▸ ▸",
                       missing: ["⊗ expand", "* execute", "⊕ select", "↺ repeat"] };
    stub(200, { results: [pipeline] });
    const v = await new PactServerPlanCheck("http://p").check(["c:a"]);
    expect(v).toMatchObject({ checked: true, ok: true });
    expect(usable(pipeline)).toBe(true);
    expect(usable(undefined)).toBe(false);
  });

  it("routes through a supplied fetcher instead of global fetch", async () => {
    const globalCalls = stub(500, {});
    const routed: string[] = [];
    const fetcher = async (url: string) => {
      routed.push(url);
      return new Response(JSON.stringify({ results: [full] }), { status: 200 });
    };
    const v = await new PactServerPlanCheck("http://pact.internal", { fetcher }).check(["c:a"]);
    expect(v).toMatchObject({ checked: true, ok: true });
    expect(routed).toEqual(["http://pact.internal/api/check-chains"]);
    expect(globalCalls.length).toBe(0);
  });

  it("fails closed when the server drops a requested name", async () => {
    stub(200, { results: [full] });
    const v = await new PactServerPlanCheck("http://p").check(["c:a", "c:gone"]);
    expect(v.ok).toBe(false);
  });

  it("fails open on server errors and outages", async () => {
    stub(500, {});
    const v500 = await new PactServerPlanCheck("http://p").check(["c:a"]);
    expect(v500).toMatchObject({ checked: false, ok: true });
    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch);
    const vdown = await new PactServerPlanCheck("http://p").check(["c:a"]);
    expect(vdown).toMatchObject({ checked: false, ok: true });
    expect(vdown.error).toBe("down");
  });

  it("short-circuits empty chain lists without fetching", async () => {
    const calls = stub(200, { results: [] });
    const v = await new PactServerPlanCheck("http://p").check([]);
    expect(v).toMatchObject({ checked: true, ok: true, results: [] });
    expect(calls.length).toBe(0);
  });
});
