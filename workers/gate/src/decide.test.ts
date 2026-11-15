import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitAdapter, GitTestKit } from "@foundry/artifacts-port/node";
import { newScopeToken } from "@foundry/gate-ts";
import { QUEUE_WAIT_CREDIT_MS, creditQueueWait, decidePush } from "./decide.js";
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
            { name: "chain:broken", found: true, typechecks: false },
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
            { name: "chain:broken", found: true, typechecks: false },
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

describe("decidePush branch resolution", () => {
  // A fork's branch is not always called what the base calls its default.
  // Reading the fork on the base's branch name turned that into either a
  // pipeline error or a phantom "proposal not found".
  function eventWithRef(repo: string, ref: string, before: string, after: string) {
    return {
      namespace: "test",
      repo,
      ref,
      before,
      after,
    } as Parameters<typeof decidePush>[2];
  }

  it("decides a push on a branch that is not the base default", async () => {
    const { baseSha } = await setup();
    execFileSync("git", ["-C", forkWork, "checkout", "-q", "-b", "feature"]);
    const after = kit.commitAll(forkWork, "feat on feature", {
      "feat.ts": "new\n",
    });
    const res = await decidePush(
      port,
      tickets,
      eventWithRef("task-1", "refs/heads/feature", baseSha, after),
    );
    expect(res.verdict).toBe("merge");
    if (res.verdict !== "merge") return;
    expect(res.files).toEqual({ "feat.ts": "new\n" });
  });

  it("refuses a push on a branch the fork does not have, without throwing", async () => {
    const { baseSha } = await setup();
    const after = kit.commitAll(forkWork, "feat", { "feat.ts": "new\n" });
    const res = await decidePush(
      port,
      tickets,
      eventWithRef("task-1", "refs/heads/ghost", baseSha, after),
    );
    expect(res.verdict).toBe("reject");
    if (res.verdict !== "reject") return;
    expect(res.reason.reason).toBe("invalid_args");
    expect(
      res.reason.reason === "invalid_args" ? res.reason.message : "",
    ).toMatch(/fork point|does not exist on the fork/);
  });
});

describe("freshness and the gate's own queue", () => {
  const MIN = 60_000;

  async function pushed(): Promise<{ push: Parameters<typeof decidePush>[2]; committedAt: number }> {
    const { baseSha } = await setup();
    // Real tickets live 4 h (orchestrator tasks.ts); the fixture's 1 h default would expire inside the waits below.
    const ticket = await tickets.getTicketByFork("task-1");
    ticket!.scope.expires_at = Date.now() + 4 * 3_600_000;
    await tickets.saveTicket(ticket!);
    const after = kit.commitAll(forkWork, "feat", { "feat.ts": "new\n" });
    return {
      push: { namespace: "test", repo: "task-1", ref: "refs/heads/main", before: baseSha, after },
      committedAt: Date.now(),
    };
  }

  it("refuses a push decided ten minutes after its commit when nothing says it waited", async () => {
    const { push, committedAt } = await pushed();
    const d = await decidePush(port, tickets, push, committedAt + 10 * MIN);
    expect(d.verdict).toBe("reject");
    if (d.verdict === "reject") expect(d.reason.reason).toBe("snapshot_too_stale");
  });

  it("merges a push that spent those ten minutes waiting behind another push's verification", async () => {
    // decision 1467, 2026-11-11: pushed within seconds of its commit, decided 671 s later
    const { push, committedAt } = await pushed();
    const d = await decidePush(port, tickets, push, committedAt + 10 * MIN, undefined, undefined, committedAt + 5_000);
    expect(d.verdict).toBe("merge");
  });

  it("still refuses a commit that was ten minutes old when it reached the gate", async () => {
    const { push, committedAt } = await pushed();
    const now = committedAt + 10 * MIN;
    const d = await decidePush(port, tickets, push, now, undefined, undefined, now - 1_000);
    expect(d.verdict).toBe("reject");
    if (d.verdict === "reject") expect(d.reason.reason).toBe("snapshot_too_stale");
  });

  it("admits the retry that collects a check run late (decision 2520: 33 min of retries)", async () => {
    // The verifier keeps a check that overran its 780 s window running for up to 30 min more; the retry that takes
    // its result can come about 45 min after the push arrived. Before 11-14 the 30 min credit refused it as stale.
    expect(QUEUE_WAIT_CREDIT_MS).toBeGreaterThanOrEqual(780_000 + 30 * MIN);
    const { push, committedAt } = await pushed();
    const now = committedAt + 45 * MIN;
    const d = await decidePush(port, tickets, push, now, undefined, undefined, committedAt + 5_000);
    expect(d.verdict).toBe("merge");
  });

  it("lets a push age out once it has waited past the credit", async () => {
    const { push, committedAt } = await pushed();
    const now = committedAt + QUEUE_WAIT_CREDIT_MS + 10 * MIN;
    const d = await decidePush(port, tickets, push, now, undefined, undefined, committedAt + 5_000);
    expect(d.verdict).toBe("reject");
    if (d.verdict === "reject") expect(d.reason.reason).toBe("snapshot_too_stale");
  });

  it("credits the wait and nothing else", () => {
    const t = 1_800_000_000_000;
    expect(creditQueueWait(t, t + 5_000, t + 10 * MIN)).toBe(t + 10 * MIN - 5_000); // age seen: the 5 s before it arrived
    expect(creditQueueWait(t, t + 10 * MIN, t + 10 * MIN)).toBe(t); // no wait, no credit
    expect(creditQueueWait(t, t + 5_000, t + QUEUE_WAIT_CREDIT_MS + 20 * MIN)).toBe(t + QUEUE_WAIT_CREDIT_MS); // capped
    expect(creditQueueWait(t, t - 60_000, t + MIN)).toBe(t + MIN); // a sender's clock behind ours: never a negative age
    expect(creditQueueWait(t + MIN, t, t)).toBe(t + MIN); // a commit dated in the future is left for the kernel to refuse
    expect(creditQueueWait(t, t + 20 * MIN, t + 10 * MIN)).toBe(t); // a receipt time in the future credits nothing
  });
});

describe("decidePush: append-only logs", () => {
  const LOG = "# Work log\n\n## one\n- a\n";

  async function seeded(files: Record<string, string> = {}) {
    const baseSha = await kit.seedBase("base", { "app.ts": "v1\n", "docs/LOG.md": LOG, ...files }, baseWork);
    const base = await port.get("base");
    await base.fork("task-1");
    base.dispose();
    kit.cloneTo("task-1", forkWork);
    const scope = newScopeToken();
    scope.allowed_tools = ["foundry.merge"];
    scope.can_mutate = true;
    await tickets.saveTicket({ taskId: "t1", baseRepo: "base", baseSha, forkRepo: "task-1", agentId: "agent-a", scope });
    const push = (after: string) => ({ namespace: "test", repo: "task-1", ref: "refs/heads/main", before: baseSha, after });
    return { baseSha, push };
  }

  it("merges two landings that each appended to docs/LOG.md (decision 2966)", async () => {
    const { push } = await seeded();
    kit.commitAll(baseWork, "other lane", { "docs/LOG.md": LOG + "\n## two (other lane)\n- b\n" });
    const after = kit.commitAll(forkWork, "this lane", {
      "web/page.tsx": "x\n",
      "docs/LOG.md": LOG + "\n## three (this lane)\n- c\n",
    });
    const d = await decidePush(port, tickets, push(after));
    expect(d.verdict).toBe("merge");
    if (d.verdict !== "merge") return;
    expect(d.appended).toEqual({
      "docs/LOG.md": LOG + "\n## two (other lane)\n- b\n\n## three (this lane)\n- c\n",
    });
    // `files` keeps the proposal's own text: that is what was verified, and what the merger binds to the proposal.
    expect(d.files["docs/LOG.md"]).toBe(LOG + "\n## three (this lane)\n- c\n");
    expect(d.files["web/page.tsx"]).toBe("x\n");
  });

  it("still conflicts on an edit above the end of the log", async () => {
    const { push } = await seeded();
    kit.commitAll(baseWork, "other lane", { "docs/LOG.md": LOG + "\n## two\n" });
    const after = kit.commitAll(forkWork, "rewrite", { "docs/LOG.md": LOG.replace("- a", "- A") + "\n## three\n" });
    const d = await decidePush(port, tickets, push(after));
    expect(d.verdict).toBe("conflict");
    if (d.verdict === "conflict") expect(d.files).toEqual(["docs/LOG.md"]);
  });

  it("still conflicts when the proposal deletes the log", async () => {
    const { push } = await seeded();
    kit.commitAll(baseWork, "other lane", { "docs/LOG.md": LOG + "\n## two\n" });
    const after = kit.commitAll(forkWork, "drop log", { "app.ts": "v2\n" }, "agent", ["docs/LOG.md"]);
    const d = await decidePush(port, tickets, push(after));
    expect(d.verdict).toBe("conflict");
    if (d.verdict === "conflict") expect(d.files).toEqual(["docs/LOG.md"]);
  });

  it("still conflicts when the base deleted the log", async () => {
    const { push } = await seeded();
    kit.commitAll(baseWork, "drop log", { "app.ts": "v2\n" }, "agent", ["docs/LOG.md"]);
    const after = kit.commitAll(forkWork, "this lane", { "docs/LOG.md": LOG + "\n## three\n" });
    const d = await decidePush(port, tickets, push(after));
    expect(d.verdict).toBe("conflict");
  });

  it("keeps every other path strict, appends included", async () => {
    const { push } = await seeded({ "NOTES.md": "n\n" });
    kit.commitAll(baseWork, "other lane", { "NOTES.md": "n\nb\n", "docs/LOG.md": LOG + "\n## two\n" });
    const after = kit.commitAll(forkWork, "this lane", { "NOTES.md": "n\nc\n", "docs/LOG.md": LOG + "\n## three\n" });
    const d = await decidePush(port, tickets, push(after));
    expect(d.verdict).toBe("conflict");
    if (d.verdict === "conflict") expect(d.files).toEqual(["NOTES.md"]);
  });

  it("takes a base's own append-only paths from .foundry/gate.json at its head", async () => {
    const { push } = await seeded({ "CHANGELOG.md": "# Changes\n" });
    kit.commitAll(baseWork, "other lane", {
      ".foundry/gate.json": '{"appendOnly": ["CHANGELOG.md"]}\n',
      "CHANGELOG.md": "# Changes\n- b\n",
    });
    const after = kit.commitAll(forkWork, "this lane", { "CHANGELOG.md": "# Changes\n- c\n" });
    const d = await decidePush(port, tickets, push(after));
    expect(d.verdict).toBe("merge");
    if (d.verdict === "merge") expect(d.appended).toEqual({ "CHANGELOG.md": "# Changes\n- b\n\n- c\n" });
  });

  it("treats docs/LOG.md strictly when the gate-wide list is empty and the base names none", async () => {
    const { push } = await seeded();
    kit.commitAll(baseWork, "other lane", { "docs/LOG.md": LOG + "\n## two\n" });
    const after = kit.commitAll(forkWork, "this lane", { "docs/LOG.md": LOG + "\n## three\n" });
    const d = await decidePush(port, tickets, push(after), Date.now(), undefined, undefined, Date.now(), []);
    expect(d.verdict).toBe("conflict");
  });

  it("leaves append-only paths out of the cross-task overlap query", async () => {
    const { push } = await seeded();
    kit.commitAll(baseWork, "other lane", { "docs/LOG.md": LOG + "\n## two\n" });
    const after = kit.commitAll(forkWork, "this lane", { "docs/LOG.md": LOG + "\n## three\n" });
    const asked: string[][] = [];
    const oracle = {
      async findContenders(q: { paths: string[] }) {
        asked.push(q.paths);
        return q.paths;
      },
    };
    const d = await decidePush(port, tickets, push(after), Date.now(), oracle as never);
    expect(d.verdict).toBe("merge");
    expect(asked).toEqual([]);
  });
});
