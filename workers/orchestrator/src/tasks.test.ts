import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ArtifactsPort } from "@foundry/artifacts-port";
import { GitAdapter, GitTestKit } from "@foundry/artifacts-port/node";
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
});
