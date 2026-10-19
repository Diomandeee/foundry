import { describe, expect, it } from "vitest";
import { newScopeToken } from "@foundry/gate-ts";
import {
  InMemoryTicketStore,
  MemoryDecisionStore,
} from "@foundry/stores";
import {
  checkClaim,
  recoverClaim,
  recoverSha,
  recoverTask,
  type EvidenceStores,
} from "./index.js";

function scope() {
  const s = newScopeToken("proj-test");
  s.can_mutate = true;
  return s;
}

async function stores(): Promise<EvidenceStores> {
  const tickets = new InMemoryTicketStore();
  const decisions = new MemoryDecisionStore();
  await tickets.saveTicket({
    taskId: "task-1",
    baseRepo: "base",
    baseSha: "aaaabbbb",
    forkRepo: "fork-1",
    agentId: "agent-1",
    scope: scope(),
  });
  await decisions.record({
    namespace: "test",
    repo: "fork-1",
    ref: "main",
    before_sha: "aaaabbbb",
    after_sha: "ccccdddd",
    verdict: "merge",
    merged_sha: "eeeeffff",
    task_id: "task-1",
    agent_id: "agent-1",
  });
  await decisions.record({
    namespace: "test",
    repo: "fork-2",
    ref: "main",
    before_sha: "11112222",
    after_sha: "33334444",
    verdict: "reject",
    reason: { code: "scope", message: "out of scope" } as never,
    task_id: "task-2",
    agent_id: "agent-2",
  });
  return {
    tickets,
    decisions,
    memory: {
      search: async (q: string) =>
        q.includes("nothing")
          ? []
          : [{ id: "t1", kind: "turn", source: "v6", text: "relevant past work" }],
    },
  };
}

describe("recoverTask", () => {
  it("chains ticket + decision, notes the missing KG leg", async () => {
    const chain = await recoverTask(await stores(), "task-1");
    expect(chain.unrecoverable).toBe(false);
    expect(chain.links.map((l) => l.kind)).toEqual(["ticket", "decision"]);
    expect(chain.links[0].pointer).toBe("ticket:fork-1");
    expect(chain.gaps.join(" ")).toContain("no KG client");
  });

  it("is unrecoverable for an unknown task", async () => {
    const chain = await recoverTask(await stores(), "task-zzz");
    expect(chain.unrecoverable).toBe(true);
    expect(checkClaim(chain).ok).toBe(false);
  });
});

describe("recoverSha", () => {
  it("finds the merge decision and its task chain", async () => {
    const chain = await recoverSha(await stores(), "fork-1", "eeeeffff");
    expect(chain.unrecoverable).toBe(false);
    expect(chain.links[0].kind).toBe("decision");
    expect(chain.links.some((l) => l.kind === "ticket")).toBe(true);
  });

  it("is unrecoverable for an unknown sha", async () => {
    const chain = await recoverSha(await stores(), "fork-1", "deadbeef");
    expect(chain.unrecoverable).toBe(true);
  });
});

describe("recoverClaim", () => {
  it("turns memory hits into links", async () => {
    const chain = await recoverClaim(await stores(), "past work on x");
    expect(chain.unrecoverable).toBe(false);
    expect(chain.links[0]).toMatchObject({ kind: "memory", pointer: "turn:t1" });
    expect(checkClaim(chain).ok).toBe(true);
  });

  it("is unrecoverable when memory is empty", async () => {
    const chain = await recoverClaim(await stores(), "nothing here");
    expect(chain.unrecoverable).toBe(true);
    expect(checkClaim(chain).safe).toContain("UNRECOVERABLE");
  });
});
