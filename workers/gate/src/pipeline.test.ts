import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GitAdapter,
  GitMerger,
  GitTestKit,
} from "@foundry/artifacts-port/node";
import { newScopeToken } from "@foundry/gate-ts";
import { InMemoryTicketStore } from "@foundry/stores";
import { StaleBaseError, type MergeRequest } from "@foundry/artifacts-port";
import type { Merger } from "@foundry/artifacts-port";
import { handlePush, type PipelineDeps } from "./pipeline.js";
import { MemoryDecisionStore } from "@foundry/stores";

let root: string;
let deps: PipelineDeps;
let kit: GitTestKit;
let forkWork: string;
let baseWork: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "foundry-pipe-"));
  const port = new GitAdapter(root);
  kit = new GitTestKit(root, port);
  deps = {
    port,
    tickets: new InMemoryTicketStore(),
    store: new MemoryDecisionStore(),
    merger: new GitMerger(root),
  };
  forkWork = join(root, "w-fork");
  baseWork = join(root, "w-base");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function setup(): Promise<{ baseSha: string }> {
  const baseSha = await kit.seedBase("base", { "app.ts": "v1\n" }, baseWork);
  const base = await deps.port.get("base");
  await base.fork("task-1");
  base.dispose();
  kit.cloneTo("task-1", forkWork);
  const scope = newScopeToken();
  scope.allowed_tools = ["foundry.merge"];
  scope.can_mutate = true;
  await deps.tickets.saveTicket({
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

describe("handlePush pipeline", () => {
  it("merges clean pushes and lands files on base", async () => {
    const { baseSha } = await setup();
    const after = kit.commitAll(forkWork, "feat", { "feat.ts": "new\n" });
    const res = await handlePush(deps, "test", pushBody("task-1", baseSha, after));
    expect(res.handled).toBe(true);
    if (!res.handled) return;
    expect(res.record.verdict).toBe("merge");
    expect(res.record.merged_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(res.record.files).toEqual(["feat.ts"]);
    const base = await deps.port.get("base");
    expect(await base.readFile("main", "feat.ts")).toBe("new\n");
    // True merge: two parents.
    const hist = await base.history("main", 1);
    expect(hist[0].parents.length).toBe(2);
    // The proposal -> landed link. This trailer is the canonical join between
    // the two merge shapes: production squashes (one parent) and the local
    // runner merges (two), and the record has to be the same either way.
    expect(hist[0].message).toContain(`Fork-Head: ${after}`);
    base.dispose();
  });

  it("records conflicts and leaves base untouched", async () => {
    const { baseSha } = await setup();
    kit.commitAll(baseWork, "base edit", { "app.ts": "base\n" });
    const after = kit.commitAll(forkWork, "fork edit", { "app.ts": "fork\n" });
    const res = await handlePush(deps, "test", pushBody("task-1", baseSha, after));
    expect(res.handled).toBe(true);
    if (!res.handled) return;
    expect(res.record.verdict).toBe("conflict");
    expect(res.record.conflict_files).toEqual(["app.ts"]);
    expect(res.record.files).toEqual(["app.ts"]);
    const base = await deps.port.get("base");
    expect(await base.readFile("main", "app.ts")).toBe("base\n");
    base.dispose();
  });

  it("records rejects for unknown forks", async () => {
    await setup();
    const res = await handlePush(
      deps,
      "test",
      pushBody("rogue", "0".repeat(40), "a".repeat(40)),
    );
    expect(res.handled).toBe(true);
    if (!res.handled) return;
    expect(res.record.verdict).toBe("reject");
  });

  it("ignores non-push events", async () => {
    await setup();
    const res = await handlePush(deps, "test", {
      type: "cf.artifacts.repo.created",
      source: { repoName: "x" },
      payload: {},
    });
    expect(res).toEqual({ handled: false });
  });

  it("lists recorded decisions", async () => {
    const { baseSha } = await setup();
    const after = kit.commitAll(forkWork, "feat", { "feat.ts": "new\n" });
    await handlePush(deps, "test", pushBody("task-1", baseSha, after));
    const rows = await deps.store.list();
    expect(rows.length).toBe(1);
    expect(rows[0].repo).toBe("task-1");
  });

  it("propagates fork-side deletions on merge", async () => {
    const { baseSha } = await setup();
    const after = kit.commitAll(forkWork, "drop", {}, "agent-a", ["app.ts"]);
    const res = await handlePush(deps, "test", pushBody("task-1", baseSha, after));
    expect(res.handled).toBe(true);
    if (!res.handled) return;
    expect(res.record.verdict).toBe("merge");
    const base = await deps.port.get("base");
    expect(await base.readFile("main", "app.ts")).toBeNull();
    base.dispose();
  });
});

describe("handlePush idempotency and races", () => {
  it("returns the first decision on redelivery", async () => {
    const { baseSha } = await setup();
    const after = kit.commitAll(forkWork, "feat", { "feat.ts": "new\n" });
    const body = pushBody("task-1", baseSha, after);
    const first = await handlePush(deps, "test", body);
    const second = await handlePush(deps, "test", body);
    expect(first.handled && second.handled).toBe(true);
    if (!first.handled || !second.handled) return;
    expect(first.record.verdict).toBe("merge");
    expect(second.record.id).toBe(first.record.id);
    expect((await deps.store.list()).length).toBe(1);
  });

  it("re-decides once when base moves mid-merge", async () => {
    const { baseSha } = await setup();
    const after = kit.commitAll(forkWork, "feat", { "feat.ts": "new\n" });
    const real = deps.merger;
    let calls = 0;
    const flaky: Merger = {
      merge: async (req: MergeRequest) => {
        calls++;
        // Simulate a concurrent landing detected between decide and merge.
        if (calls === 1) throw new StaleBaseError("base moved ab12 -> cd34");
        return real.merge(req);
      },
    };
    deps.merger = flaky;
    try {
      const res = await handlePush(deps, "test", pushBody("task-1", baseSha, after));
      expect(res.handled).toBe(true);
      if (!res.handled) return;
      expect(calls).toBe(2);
      expect(res.record.verdict).toBe("merge");
    } finally {
      deps.merger = real;
    }
  });
});

describe("handlePush debug flag", () => {
  it("attaches the stack to pipeline errors when debug is on", async () => {
    const { baseSha } = await setup();
    const after = kit.commitAll(forkWork, "feat", { "feat.ts": "new\n" });
    deps.debug = true;
    const exploding = {
      merge: async (_req: MergeRequest) => {
        throw new Error("boom");
      },
    };
    deps.merger = exploding as Merger;
    try {
      const res = await handlePush(deps, "test", pushBody("task-1", baseSha, after));
      expect(res.handled).toBe(true);
      if (!res.handled) return;
      // An outage is an unfinished attempt, not a refusal.
      expect(res.record.verdict).toBe("error");
      const reason = res.record.reason;
      expect(
        reason && reason.reason === "infra_failure" && reason.message,
      ).toContain("boom");
      expect(
        reason && reason.reason === "infra_failure" && reason.message,
      ).toContain("at ");
    } finally {
      deps.debug = false;
    }
  });
});

describe("handlePush failure classification", () => {
  // 7 rows on the live staging board read exactly like this: a repo/transport
  // failure recorded as `reject`/`invalid_args`, i.e. counted as the agent's
  // fault. These tests hold the line between an outage and a verdict.
  function exploding(error: string): Merger {
    return {
      merge: async (_req: MergeRequest) => {
        throw new Error(error);
      },
    } as Merger;
  }

  it("records a transport failure as error, never as a refusal", async () => {
    const { baseSha } = await setup();
    const after = kit.commitAll(forkWork, "feat", { "feat.ts": "new\n" });
    const real = deps.merger;
    deps.merger = exploding("merge:push: Could not find main.");
    try {
      const res = await handlePush(deps, "test", pushBody("task-1", baseSha, after));
      expect(res.handled).toBe(true);
      if (!res.handled) return;
      expect(res.record.verdict).toBe("error");
      expect(res.record.reason?.reason).toBe("infra_failure");
      // The shared base is untouched: nothing partial landed.
      const base = await deps.port.get("base");
      expect(await base.readFile("main", "feat.ts")).toBeNull();
      base.dispose();
    } finally {
      deps.merger = real;
    }
  });

  it("lets a retry replace the error row with the real verdict", async () => {
    const { baseSha } = await setup();
    const after = kit.commitAll(forkWork, "feat", { "feat.ts": "new\n" });
    const body = pushBody("task-1", baseSha, after);
    const real = deps.merger;
    deps.merger = exploding("merge:clone: network");
    let first;
    try {
      first = await handlePush(deps, "test", body);
    } finally {
      deps.merger = real;
    }
    expect(first.handled && first.record.verdict).toBe("error");

    const second = await handlePush(deps, "test", body);
    expect(second.handled).toBe(true);
    if (!first.handled || !second.handled) return;
    expect(second.record.verdict).toBe("merge");
    // Same event, same row: the ledger has one row from first failure on.
    expect(second.record.id).toBe(first.record.id);
    expect((await deps.store.list()).length).toBe(1);
  });

  it("still returns the first real decision on redelivery after an error", async () => {
    const { baseSha } = await setup();
    const after = kit.commitAll(forkWork, "feat", { "feat.ts": "new\n" });
    const body = pushBody("task-1", baseSha, after);
    const real = deps.merger;
    deps.merger = exploding("merge:push: transient");
    try {
      await handlePush(deps, "test", body);
    } finally {
      deps.merger = real;
    }
    const merged = await handlePush(deps, "test", body);
    const again = await handlePush(deps, "test", body);
    expect(merged.handled && merged.record.verdict).toBe("merge");
    expect(again.handled && again.record.id).toBe(merged.handled && merged.record.id);
    expect((await deps.store.list()).length).toBe(1);
  });
});
