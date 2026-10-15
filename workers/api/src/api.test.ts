import { describe, expect, it } from "vitest";
import { newScopeToken } from "@foundry/gate-ts";
import {
  InMemoryTicketStore,
  MemoryDecisionStore,
  type TaskTicket,
} from "@foundry/stores";
import { createApi, spatialFeed } from "./index.js";

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

  it("pages the spatial feed with limit+cursor", async () => {
    const app = await seeded();
    const p1 = (await (
      await app.request("/history.json?limit=1")
    ).json()) as { commits: { sha: string }[]; nextCursor: number | null };
    expect(p1.commits.length).toBe(1);
    expect(p1.commits[0].sha).toBe("d".repeat(40));
    expect(p1.nextCursor).toBe(2);
    const p2 = (await (
      await app.request(`/history.json?limit=1&cursor=${p1.nextCursor}`)
    ).json()) as { commits: { sha: string }[]; nextCursor: number | null };
    expect(p2.commits.length).toBe(1);
    expect(p2.commits[0].sha).toBe("c".repeat(40));
    // Last page: nextCursor is null, so a client knows the feed is exhausted
    // without spending a request to discover it.
    expect(p2.nextCursor).toBe(null);
  });

  it("names the proposal and the landed commit separately", async () => {
    const app = await seeded();
    const body = (await (await app.request("/history.json")).json()) as {
      commits: {
        sha: string;
        proposal_sha: string;
        merge_sha: string | null;
        verdict: string;
      }[];
    };
    const merged = body.commits.find((c) => c.verdict === "merge");
    const refused = body.commits.find((c) => c.verdict === "reject");
    expect(merged?.merge_sha).toBe("c".repeat(40));
    expect(merged?.proposal_sha).toBe("b".repeat(40));
    // A refusal never entered the base: no merge identity to show.
    expect(refused?.merge_sha).toBe(null);
    expect(refused?.sha).toBe("d".repeat(40));
  });

  it("rejects a malformed cursor instead of silently ignoring it", async () => {
    const app = await seeded();
    const res = await app.request("/history.json?cursor=later");
    expect(res.status).toBe(400);
  });

  it("reaches history past the first 200 rows", async () => {
    const store = new MemoryDecisionStore();
    for (let i = 1; i <= 250; i++) {
      await store.record({
        ...event,
        after_sha: i.toString(16).padStart(40, "0"),
        verdict: "reject",
      });
    }
    const app = createApi(store);
    const seen: string[] = [];
    let cursor: number | null = null;
    for (let page = 0; page < 20; page++) {
      const url =
        cursor === null
          ? "/history.json?limit=50"
          : `/history.json?limit=50&cursor=${cursor}`;
      const body = (await (await app.request(url)).json()) as {
        commits: { sha: string }[];
        nextCursor: number | null;
      };
      seen.push(...body.commits.map((c) => c.sha));
      if (body.nextCursor === null) break;
      cursor = body.nextCursor;
    }
    expect(seen.length).toBe(250);
    expect(new Set(seen).size).toBe(250);
  });

  it("filters the feed by repo across pages", async () => {
    const store = new MemoryDecisionStore();
    for (let i = 1; i <= 6; i++) {
      await store.record({
        ...event,
        repo: i % 2 === 0 ? "fork-2" : "fork-1",
        after_sha: i.toString(16).padStart(40, "0"),
        verdict: "reject",
      });
    }
    const app = createApi(store);
    const body = (await (
      await app.request("/history.json?repo=fork-2&limit=50")
    ).json()) as { commits: { repo: string }[]; nextCursor: number | null };
    expect(body.commits.length).toBe(3);
    expect(body.commits.every((c) => c.repo === "fork-2")).toBe(true);
    expect(body.nextCursor).toBe(null);
  });

  describe("/git-history.json (Spatial Git adapter)", () => {
    it("renders decisions in the shape the vendored viewer fetches", async () => {
      const res = await (await seeded()).request("/git-history.json");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        branches: string[];
        commits: {
          hash: string;
          fullHash: string;
          author: string;
          date: string;
          message: string;
          branch: string;
          parents: string[];
          files: { path: string; type: string }[];
          verdict: string;
          proposal_sha: string;
          merge_sha: string | null;
        }[];
        truncated: boolean;
      };
      expect(body.branches).toEqual(["fork-1"]);
      expect(body.commits.length).toBe(2);
      for (const c of body.commits) {
        // The viewer reads every one of these; a missing one renders blank.
        expect(typeof c.hash).toBe("string");
        expect(typeof c.fullHash).toBe("string");
        expect(typeof c.author).toBe("string");
        expect(Number.isNaN(Date.parse(c.date))).toBe(false);
        expect(typeof c.message).toBe("string");
        expect(Array.isArray(c.files)).toBe(true);
        expect(Array.isArray(c.parents)).toBe(true);
      }
      expect(body.truncated).toBe(false);
    });

    it("keeps a refusal and the commit that landed distinct", async () => {
      const merged = spatialFeed([
        {
          id: 1,
          namespace: "test",
          repo: "fork-1",
          ref: "refs/heads/main",
          before_sha: "a".repeat(40),
          after_sha: "b".repeat(40),
          merged_sha: "c".repeat(40),
          verdict: "merge",
          reason: null,
          files: ["app.ts"],
          task_id: "t1",
          agent_id: "agent-1",
          decided_at: "2026-10-15T10:00:00.000Z",
        },
        {
          id: 2,
          namespace: "test",
          repo: "fork-1",
          ref: "refs/heads/main",
          before_sha: "c".repeat(40),
          after_sha: "d".repeat(40),
          merged_sha: null,
          verdict: "reject",
          reason: { reason: "path_not_allowed", path: "etc/x" },
          files: null,
          task_id: "t1",
          agent_id: null,
          decided_at: "2026-10-15T10:05:00.000Z",
        },
      ]);
      const [merg, reject] = merged.commits;
      expect(merg.fullHash).toBe("c".repeat(40));
      expect(merg.merge_sha).toBe("c".repeat(40));
      expect(merg.proposal_sha).toBe("b".repeat(40));
      // A refused proposal must not look like it entered the base.
      expect(reject.fullHash).toBe("d".repeat(40));
      expect(reject.merge_sha).toBe(null);
      expect(reject.message).toContain("REJECT");
      expect(reject.message).toContain("path_not_allowed");
      expect(reject.files).toEqual([]);
    });
  });

  describe("/evidence/:taskId (evidence read path)", () => {
    it("names the missing leg instead of returning an empty success", async () => {
      const res = await (await seeded()).request("/evidence/t1");
      expect(res.status).toBe(503);
      expect(await res.text()).toContain("ticket store");
    });

    it("rejects a malformed task id", async () => {
      const app = createApi(new MemoryDecisionStore(), {
        tickets: new InMemoryTicketStore(),
      });
      const res = await app.request("/evidence/not%20a%20task");
      expect(res.status).toBe(400);
    });

    it("is 404 when nothing is recoverable, and never claims", async () => {
      const app = createApi(new MemoryDecisionStore(), {
        tickets: new InMemoryTicketStore(),
      });
      const body = (await (await app.request("/evidence/ghost")).json()) as {
        unrecoverable: boolean;
        claim: { ok: boolean; safe: string };
        gaps: string[];
      };
      expect(body.unrecoverable).toBe(true);
      expect(body.claim.ok).toBe(false);
      expect(body.claim.safe).toContain("UNRECOVERABLE");
      expect(body.gaps.length).toBeGreaterThan(0);
    });

    it("reconstructs the chain for a real decision", async () => {
      const store = new MemoryDecisionStore();
      const tickets = new InMemoryTicketStore();
      const scope = newScopeToken();
      scope.allowed_roots = ["src"];
      const ticket: TaskTicket = {
        taskId: "t9",
        baseRepo: "base",
        baseSha: "a".repeat(40),
        forkRepo: "t9--a",
        agentId: "agent-1",
        scope,
      };
      await tickets.saveTicket(ticket);
      await store.record({
        ...event,
        repo: "t9--a",
        verdict: "merge",
        merged_sha: "c".repeat(40),
        task_id: "t9",
        agent_id: "agent-1",
      });

      const app = createApi(store, { tickets });
      const res = await app.request("/evidence/t9");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        links: { kind: string; pointer: string }[];
        claim: { ok: boolean };
        gaps: string[];
      };
      expect(body.claim.ok).toBe(true);
      expect(body.links.some((l) => l.kind === "ticket")).toBe(true);
      expect(body.links.some((l) => l.kind === "decision")).toBe(true);
      // The KG leg is genuinely absent here, and it says so rather than
      // reporting a complete chain.
      expect(body.gaps.some((g) => g.includes("KG client"))).toBe(true);
    });
  });
});
