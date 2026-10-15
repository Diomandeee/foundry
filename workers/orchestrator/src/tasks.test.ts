import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ArtifactsPort } from "@foundry/artifacts-port";
import { GitAdapter, GitTestKit } from "@foundry/artifacts-port/node";
import {
  cheapCost,
  checkAdmissibility,
  InMemoryLedger,
  Layer,
  newKernelState,
  newProposedCall,
} from "@foundry/gate-ts";
import { InMemoryTicketStore, type TicketStore } from "@foundry/stores";
import { createTask } from "./tasks.js";

let root: string;
let port: ArtifactsPort;
let tickets: TicketStore;
let kit: GitTestKit;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "foundry-tasks-"));
  port = new GitAdapter(root);
  tickets = new InMemoryTicketStore();
  kit = new GitTestKit(root, port);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("createTask", () => {
  it("forks per agent with tickets, tokens, and AGENTS.md", async () => {
    const baseSha = await kit.seedBase(
      "base",
      { "app.ts": "v1\n", "AGENTS.md": "# instructions\n" },
      join(root, "w-base"),
    );
    const res = await createTask(port, tickets, {
      baseRepo: "base",
      taskId: "t1",
      agents: ["a", "b"],
    });
    expect(res.taskId).toBe("t1");
    expect(res.baseSha).toBe(baseSha);
    expect(res.dispatches.length).toBe(2);
    for (const d of res.dispatches) {
      expect(d.forkRepo).toBe(`t1--${d.agentId}`);
      expect(d.remote.endsWith(`t1--${d.agentId}.git`)).toBe(true);
      expect(d.token.startsWith("local_write_")).toBe(true);
      expect(d.instructions).toBe("# instructions\n");
      const t = await tickets.getTicketByFork(d.forkRepo);
      expect(t?.agentId).toBe(d.agentId);
      expect(t?.baseSha).toBe(baseSha);
      expect(t?.scope.allowed_tools).toEqual(["foundry.merge"]);
      expect(t?.scope.can_mutate).toBe(true);
    }
    expect(await port.list()).toEqual(["base", "t1--a", "t1--b"]);
    expect(res.subscribeCommands).toEqual([
      "bash tools/subscribe-repo.sh <env> 't1--a'",
      "bash tools/subscribe-repo.sh <env> 't1--b'",
    ]);
  });

  it("prefers explicit instructions and auto-creates missing base", async () => {
    const res = await createTask(port, tickets, {
      baseRepo: "fresh",
      taskId: "t2",
      agents: ["a"],
      instructions: "custom",
    });
    expect(res.baseSha).toBe("");
    expect(res.dispatches[0].instructions).toBe("custom");
    expect(await port.list()).toEqual(["fresh", "t2--a"]);
  });

  it("rejects invalid input", async () => {
    await expect(
      createTask(port, tickets, { baseRepo: "b@d", taskId: "t", agents: ["a"] }),
    ).rejects.toThrow("invalid baseRepo");
    await expect(
      createTask(port, tickets, { baseRepo: "base", taskId: "t", agents: [] }),
    ).rejects.toThrow("invalid agents");
    await expect(
      createTask(port, tickets, {
        baseRepo: "base",
        taskId: "t",
        agents: ["a", "a"],
      }),
    ).rejects.toThrow("duplicate");
  });

  it("rejects invalid chain names", async () => {
    await expect(
      createTask(port, tickets, {
        baseRepo: "base",
        taskId: "t",
        agents: ["a"],
        chains: ["bad name!"],
      }),
    ).rejects.toThrow("invalid chain name");
  });

  it("records the plan verdict on every task", async () => {
    const planCheck = {
      check: async (chains: string[]) => ({
        checked: true,
        ok: true,
        results: chains.map((name) => ({ name, found: true })),
      }),
    };
    const res = await createTask(
      port,
      tickets,
      {
        baseRepo: "fresh",
        taskId: "t3",
        agents: ["a"],
        instructions: "x",
        chains: ["chain:genesis"],
      },
      Date.now(),
      planCheck,
    );
    expect(res.baseRepo).toBe("fresh");
    expect(res.planCheck).toMatchObject({ checked: true, ok: true });
    expect(await port.list()).toEqual(["fresh", "t3--a"]);
  });

  it("rejects unusable chains when enforced, before forking", async () => {
    const planCheck = {
      check: async () => ({
        checked: true,
        ok: false,
        results: [{ name: "chain:bogus", found: false }],
      }),
    };
    await expect(
      createTask(
        port,
        tickets,
        {
          baseRepo: "fresh",
          taskId: "t4",
          agents: ["a"],
          chains: ["chain:bogus"],
          planCheckEnforce: true,
        },
        Date.now(),
        planCheck,
      ),
    ).rejects.toThrow("invalid plan: chains not usable: chain:bogus");
    expect(await port.list()).toEqual([]);
  });

  it("keeps advisory failures non-blocking by default", async () => {
    const planCheck = {
      check: async () => ({ checked: false, ok: true, results: [], error: "down" }),
    };
    const res = await createTask(
      port,
      tickets,
      {
        baseRepo: "fresh",
        taskId: "t5",
        agents: ["a"],
        chains: ["chain:genesis"],
      },
      Date.now(),
      planCheck,
    );
    expect(res.planCheck).toMatchObject({ checked: false, ok: true });
    expect(res.dispatches.length).toBe(1);
  });

  it("carries declared allowed roots into every minted scope", async () => {
    await kit.seedBase("base", { "app.ts": "v1\n" }, join(root, "w-base"));
    const res = await createTask(port, tickets, {
      baseRepo: "base",
      taskId: "t6",
      agents: ["a", "b"],
      allowedRoots: ["src/allowed", "docs"],
    });
    expect(res.allowedRoots).toEqual(["src/allowed", "docs"]);
    for (const d of res.dispatches) {
      const t = await tickets.getTicketByFork(d.forkRepo);
      expect(t?.scope.allowed_roots).toEqual(["src/allowed", "docs"]);
    }
  });

  it("leaves scopes unrestricted when no roots are declared, and says so", async () => {
    await kit.seedBase("base", { "app.ts": "v1\n" }, join(root, "w-base"));
    const res = await createTask(port, tickets, {
      baseRepo: "base",
      taskId: "t7",
      agents: ["a"],
    });
    // The echo is the point: "unrestricted" is visible to the operator rather
    // than something you have to infer from an empty field in the store.
    expect(res.allowedRoots).toEqual([]);
    const t = await tickets.getTicketByFork("t7--a");
    expect(t?.scope.allowed_roots).toEqual([]);
  });

  it("rejects malformed allowed roots before any fork exists", async () => {
    for (const bad of [
      "/etc",
      "src/../../etc",
      "..",
      "src/",
      "src//x",
      "src\\x",
      "",
      7,
    ]) {
      await expect(
        createTask(port, tickets, {
          baseRepo: "base",
          taskId: "t8",
          agents: ["a"],
          allowedRoots: [bad as string],
        }),
      ).rejects.toThrow(/invalid allowed root/);
    }
    // Nothing was minted, so nothing needs cleaning up.
    expect(await tickets.getTicketByFork("t8--a")).toBe(null);
  });

  it("mints a scope the kernel actually enforces", async () => {
    // The connection, asserted rather than assumed: the scope intake writes is
    // fed to the real admissibility kernel, and rule 10 then refuses a path
    // outside the declared root. Without `allowedRoots` on the input the same
    // call is admitted, which is why the default is documented as fail-open.
    await kit.seedBase("base", { "app.ts": "v1\n" }, join(root, "w-base"));
    await createTask(port, tickets, {
      baseRepo: "base",
      taskId: "t9",
      agents: ["a"],
      allowedRoots: ["src/allowed"],
    });
    const ticket = await tickets.getTicketByFork("t9--a");
    expect(ticket).not.toBe(null);

    const syscall = {
      id: "foundry.merge",
      layer: Layer.OBSERVE,
      mutability: "read_only" as const,
      cost: cheapCost(),
      maxSnapshotAgeMs: null,
      validateArgs: () => {},
    };
    const outside = checkAdmissibility(
      syscall,
      newProposedCall("foundry.merge", { path: "src/allowed/../secret" }, ticket!.scope),
      newKernelState(),
      new InMemoryLedger(),
    );
    expect(outside.ok).toBe(false);
    if (!outside.ok) expect(outside.reason.reason).toBe("path_not_allowed");

    const inside = checkAdmissibility(
      syscall,
      newProposedCall("foundry.merge", { path: "src/allowed/x.ts" }, ticket!.scope),
      newKernelState(),
      new InMemoryLedger(),
    );
    expect(inside.ok).toBe(true);
  });
});
