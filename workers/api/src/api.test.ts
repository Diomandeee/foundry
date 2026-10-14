import { describe, expect, it } from "vitest";
import { MemoryDecisionStore } from "@foundry/stores";
import { createApi } from "./index.js";

const event = {
  namespace: "test",
  repo: "fork-1",
  ref: "refs/heads/main",
  before_sha: "a".repeat(40),
  after_sha: "b".repeat(40),
};

async function seeded() {
  const store = new MemoryDecisionStore();
  await store.record({ ...event, verdict: "merge", merged_sha: "c".repeat(40) });
  await store.record({ ...event, after_sha: "d".repeat(40), verdict: "reject" });
  return createApi(store);
}

describe("api", () => {
  it("serves the board", async () => {
    const res = await (await seeded()).request("/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Foundry");
  });

  it("lists decisions as JSON", async () => {
    const res = await (await seeded()).request("/decisions?limit=10");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { decisions: unknown[] };
    expect(body.decisions.length).toBe(2);
  });

  it("explains a sha (why-trail)", async () => {
    const app = await seeded();
    const hit = await app.request("/why/bbbbbbbbbbbb");
    expect(hit.status).toBe(200);
    const miss = await app.request("/why/000000000000");
    expect(miss.status).toBe(404);
    const bad = await app.request("/why/not-a-sha!!");
    expect(bad.status).toBe(400);
  });

  it("serves the spatial feed", async () => {
    const res = await (await seeded()).request("/history.json");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { commits: { sha: string }[] };
    expect(body.commits[0].sha).toBe("d".repeat(40));
  });
});
