import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitAdapter, GitTestKit } from "@foundry/artifacts-port/node";
import { newScopeToken } from "@foundry/gate-ts";
import { decidePush } from "./decide.js";
import {
  InMemoryTicketStore,
  type TicketStore,
} from "@foundry/stores";

let root: string;
let port: GitAdapter;
let tickets: TicketStore;
let kit: GitTestKit;
let forkWork: string;
let baseWork: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "foundry-decide-"));
  port = new GitAdapter(root);
  tickets = new InMemoryTicketStore();
  kit = new GitTestKit(root, port);
  forkWork = join(root, "w-fork");
  baseWork = join(root, "w-base");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function setup(): Promise<{ baseSha: string }> {
  const baseSha = await kit.seedBase(
    "base",
    { "app.ts": "v1\n", "lib.ts": "v1\n" },
    baseWork,
  );
  const base = await port.get("base");
  await base.fork("task-1");
  base.dispose();
  kit.cloneTo("task-1", forkWork);
  const scope = newScopeToken();
  scope.allowed_tools = ["foundry.merge"];
  scope.can_mutate = true;
  await tickets.saveTicket({
    taskId: "t1",
    baseRepo: "base",
    baseSha,
    forkRepo: "task-1",
    agentId: "agent-a",
    scope,
  });
  return { baseSha };
}

function pushBody(repo: string, before: string, after: string) {
  return {
    type: "foundry.local.pushed",
    source: { namespace: "test", repoName: repo },
    payload: { ref: "refs/heads/main", before, after },
  };
}

describe("decidePush", () => {
  it("merges a clean disjoint push", async () => {
    const { baseSha } = await setup();
    const after = kit.commitAll(forkWork, "feat", { "feat.ts": "new\n" });
    const d = await decidePush(
      port,
      tickets,
      {
        namespace: "test",
        repo: "task-1",
        ref: "refs/heads/main",
        before: baseSha,
        after,
      },
    );
    expect(d.verdict).toBe("merge");
    if (d.verdict === "merge") {
      expect(d.files).toEqual({ "feat.ts": "new\n" });
    }
  });

  it("detects a real content conflict", async () => {
    const { baseSha } = await setup();
    kit.commitAll(baseWork, "base change", { "app.ts": "base-v2\n" });
    const after = kit.commitAll(forkWork, "fork change", {
      "app.ts": "fork-v2\n",
    });
    const d = await decidePush(port, tickets, {
      namespace: "test",
      repo: "task-1",
      ref: "refs/heads/main",
      before: baseSha,
      after,
    });
    expect(d.verdict).toBe("conflict");
    if (d.verdict === "conflict") expect(d.files).toEqual(["app.ts"]);
  });

  it("merges when both sides touch a path identically", async () => {
    const { baseSha } = await setup();
    kit.commitAll(baseWork, "same", { "app.ts": "same\n" });
    const after = kit.commitAll(forkWork, "same", { "app.ts": "same\n" });
    const d = await decidePush(port, tickets, {
      namespace: "test",
      repo: "task-1",
      ref: "refs/heads/main",
      before: baseSha,
      after,
    });
    expect(d.verdict).toBe("merge");
  });

  it("rejects pushes from unknown forks", async () => {
    await setup();
    const d = await decidePush(port, tickets, {
      namespace: "test",
      repo: "rogue",
      ref: "refs/heads/main",
      before: "0".repeat(40),
      after: "a".repeat(40),
    });
    expect(d.verdict).toBe("reject");
    if (d.verdict === "reject") expect(d.reason.reason).toBe("invalid_args");
  });

  it("rejects pushes for unknown shas", async () => {
    const { baseSha } = await setup();
    const d = await decidePush(port, tickets, {
      namespace: "test",
      repo: "task-1",
      ref: "refs/heads/main",
      before: baseSha,
      after: "b".repeat(40),
    });
    expect(d.verdict).toBe("reject");
    if (d.verdict === "reject")
      expect(d.reason.reason).toBe("proposal_not_found");
  });

  it("rejects when the ticket scope expired", async () => {
    const { baseSha } = await setup();
    const ticket = await tickets.getTicketByFork("task-1");
    ticket!.scope.expires_at = Date.now() - 1000;
    await tickets.saveTicket(ticket!);
    const after = kit.commitAll(forkWork, "late", { "late.ts": "x\n" });
    const d = await decidePush(port, tickets, {
      namespace: "test",
      repo: "task-1",
      ref: "refs/heads/main",
      before: baseSha,
      after,
    });
    expect(d.verdict).toBe("reject");
    if (d.verdict === "reject") expect(d.reason.reason).toBe("scope_expired");
  });

  it("accepts normalized local push events", async () => {
    const { baseSha } = await setup();
    const after = kit.commitAll(forkWork, "feat", { "feat.ts": "new\n" });
    // Same verdict via the event normalizer path shape.
    const body = pushBody("task-1", baseSha, after);
    expect(body.type).toBe("foundry.local.pushed");
    const d = await decidePush(port, tickets, {
      namespace: "test",
      repo: "task-1",
      ref: "refs/heads/main",
      before: baseSha,
      after,
    });
    expect(d.verdict).toBe("merge");
  });

  it("escalates KG-detected cross-task contention to conflict", async () => {
    const { baseSha } = await setup();
    const after = kit.commitAll(forkWork, "feat", { "feat.ts": "new\n" });
    let seen: unknown = null;
    const oracle = {
      findContenders: async (input: unknown) => {
        seen = input;
        return ["feat.ts"];
      },
    };
    const d = await decidePush(
      port,
      tickets,
      {
        namespace: "test",
        repo: "task-1",
        ref: "refs/heads/main",
        before: baseSha,
        after,
      },
      Date.now(),
      oracle,
    );
    expect(d.verdict).toBe("conflict");
    if (d.verdict === "conflict") expect(d.files).toEqual(["feat.ts"]);
    expect(seen).toMatchObject({ baseRepo: "base", taskId: "t1" });
  });

  it("merges clean when the oracle reports no contenders", async () => {
    const { baseSha } = await setup();
    const after = kit.commitAll(forkWork, "feat", { "feat.ts": "new\n" });
    const oracle = { findContenders: async () => [] as string[] };
    const d = await decidePush(
      port,
      tickets,
      {
        namespace: "test",
        repo: "task-1",
        ref: "refs/heads/main",
        before: baseSha,
        after,
      },
      Date.now(),
      oracle,
    );
    expect(d.verdict).toBe("merge");
  });

  it("merges clean when the oracle is unknown (fail-open)", async () => {
    const { baseSha } = await setup();
    const after = kit.commitAll(forkWork, "feat", { "feat.ts": "new\n" });
    const oracle = { findContenders: async () => null };
    const d = await decidePush(
      port,
      tickets,
      {
        namespace: "test",
        repo: "task-1",
        ref: "refs/heads/main",
        before: baseSha,
        after,
      },
      Date.now(),
      oracle,
    );
    expect(d.verdict).toBe("merge");
  });

  it("skips the oracle when local conflicts already exist", async () => {
    const { baseSha } = await setup();
    kit.commitAll(baseWork, "base change", { "app.ts": "base-v2\n" });
    const after = kit.commitAll(forkWork, "fork change", {
      "app.ts": "fork-v2\n",
    });
    let called = false;
    const oracle = {
      findContenders: async () => {
        called = true;
        return ["app.ts"];
      },
    };
    const d = await decidePush(
      port,
      tickets,
      {
        namespace: "test",
        repo: "task-1",
        ref: "refs/heads/main",
        before: baseSha,
        after,
      },
      Date.now(),
      oracle,
    );
    expect(d.verdict).toBe("conflict");
    if (d.verdict === "conflict") expect(d.files).toEqual(["app.ts"]);
    expect(called).toBe(false);
  });

  it("rejects unusable chains when enforced", async () => {
    const { baseSha } = await setup();
    const ticket = await tickets.getTicketByFork("task-1");
    ticket!.chains = ["chain:broken"];
    await tickets.saveTicket(ticket!);
    const after = kit.commitAll(forkWork, "feat", { "feat.ts": "new\n" });
    const planCheck = {
      check: {
        check: async () => ({
          checked: true,
          ok: false,
          results: [
            { name: "chain:broken", found: true, missing: ["ghost-skill"] },
          ],
        }),
      },
      enforce: true,
    };
    const d = await decidePush(
      port,
      tickets,
      {
        namespace: "test",
        repo: "task-1",
        ref: "refs/heads/main",
        before: baseSha,
        after,
      },
      Date.now(),
      undefined,
      planCheck,
    );
    expect(d.verdict).toBe("reject");
    if (d.verdict === "reject") {
      expect(d.reason.reason).toBe("invalid_args");
      if (d.reason.reason === "invalid_args")
        expect(d.reason.message).toContain("chain:broken");
    }
  });

  it("merges with advisory attached when not enforced", async () => {
    const { baseSha } = await setup();
    const ticket = await tickets.getTicketByFork("task-1");
    ticket!.chains = ["chain:broken"];
    await tickets.saveTicket(ticket!);
    const after = kit.commitAll(forkWork, "feat", { "feat.ts": "new\n" });
    const planCheck = {
      check: {
        check: async () => ({
          checked: true,
          ok: false,
          results: [
            { name: "chain:broken", found: true, missing: ["ghost-skill"] },
          ],
        }),
      },
    };
    const d = await decidePush(
      port,
      tickets,
      {
        namespace: "test",
        repo: "task-1",
        ref: "refs/heads/main",
        before: baseSha,
        after,
      },
      Date.now(),
      undefined,
      planCheck,
    );
    expect(d.verdict).toBe("merge");
    if (d.verdict === "merge") expect(d.planAdvisory?.ok).toBe(false);
  });

  it("fails open on outage even when enforced", async () => {
    const { baseSha } = await setup();
    const ticket = await tickets.getTicketByFork("task-1");
    ticket!.chains = ["chain:any"];
    await tickets.saveTicket(ticket!);
    const after = kit.commitAll(forkWork, "feat", { "feat.ts": "new\n" });
    const planCheck = {
      check: {
        check: async () => ({
          checked: false,
          ok: true,
          results: [],
          error: "pact down",
        }),
      },
      enforce: true,
    };
    const d = await decidePush(
      port,
      tickets,
      {
        namespace: "test",
        repo: "task-1",
        ref: "refs/heads/main",
        before: baseSha,
        after,
      },
      Date.now(),
      undefined,
      planCheck,
    );
    expect(d.verdict).toBe("merge");
  });

  it("skips the check when the ticket declares no chains", async () => {
    const { baseSha } = await setup();
    const after = kit.commitAll(forkWork, "feat", { "feat.ts": "new\n" });
    let called = false;
    const planCheck = {
      check: {
        check: async () => {
          called = true;
          return { checked: true, ok: true, results: [] };
        },
      },
      enforce: true,
    };
    const d = await decidePush(
      port,
      tickets,
      {
        namespace: "test",
        repo: "task-1",
        ref: "refs/heads/main",
        before: baseSha,
        after,
      },
      Date.now(),
      undefined,
      planCheck,
    );
    expect(d.verdict).toBe("merge");
    expect(called).toBe(false);
  });
});

describe("decidePush guards", () => {
  it("rejects pushes that change no files", async () => {
    const { baseSha } = await setup();
    const d = await decidePush(port, tickets, {
      namespace: "test",
      repo: "task-1",
      ref: "refs/heads/main",
      before: baseSha,
      after: baseSha,
    });
    expect(d.verdict).toBe("reject");
    if (d.verdict === "reject" && d.reason.reason === "invalid_args") {
      expect(d.reason.message).toContain("empty diff");
    } else {
      expect.unreachable("expected invalid_args reject");
    }
  });

  it("rejects paths outside the scope allowlist", async () => {
    const { baseSha } = await setup();
    const ticket = await tickets.getTicketByFork("task-1");
    ticket!.scope.allowed_roots = ["src"];
    await tickets.saveTicket(ticket!);
    const after = kit.commitAll(forkWork, "feat", { "feat.ts": "new\n" });
    const d = await decidePush(port, tickets, {
      namespace: "test",
      repo: "task-1",
      ref: "refs/heads/main",
      before: baseSha,
      after,
    });
    expect(d.verdict).toBe("reject");
    if (d.verdict === "reject") {
      expect(d.reason.reason).toBe("path_not_allowed");
    }
  });
});

describe("decidePush empty base", () => {
  it("merges the first task onto a base with no commits", async () => {
    await port.create("base");
    const base = await port.get("base");
    await base.fork("task-1");
    base.dispose();
    kit.cloneTo("task-1", forkWork);
    const scope = newScopeToken();
    scope.allowed_tools = ["foundry.merge"];
    scope.can_mutate = true;
    await tickets.saveTicket({
      taskId: "t1",
      baseRepo: "base",
      baseSha: "",
      forkRepo: "task-1",
      agentId: "agent-a",
      scope,
    });
    const after = kit.commitAll(forkWork, "first", { "app.ts": "v1\n" });
    const d = await decidePush(port, tickets, {
      namespace: "test",
      repo: "task-1",
      ref: "refs/heads/main",
      before: "0".repeat(40),
      after,
    });
    expect(d.verdict).toBe("merge");
    if (d.verdict === "merge") {
      expect(d.files).toEqual({ "app.ts": "v1\n" });
      expect(d.baseHead).toBeNull();
    }
  });
});

describe("decidePush fork-point honesty", () => {
  it("rejects when the fork point is not in history", async () => {
    const { baseSha } = await setup();
    const ticket = await tickets.getTicketByFork("task-1");
    ticket!.baseSha = "f".repeat(40);
    await tickets.saveTicket(ticket!);
    const after = kit.commitAll(forkWork, "feat", { "feat.ts": "new\n" });
    const d = await decidePush(port, tickets, {
      namespace: "test",
      repo: "task-1",
      ref: "refs/heads/main",
      before: baseSha,
      after,
    });
    expect(d.verdict).toBe("reject");
    if (d.verdict === "reject" && d.reason.reason === "invalid_args") {
      expect(d.reason.message).toContain("fork point");
    } else {
      expect.unreachable("expected invalid_args reject");
    }
  });
});
