// The ticket store's real SQL against real SQLite (node:sqlite), on the committed schema and on the
// pre-migration tickets table the live ledger still has. Chains reach the gate only through this row.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { newScopeToken } from "@foundry/gate-ts";
import { D1TicketStore, type TaskTicket } from "./tickets.js";

function shim(db: DatabaseSync): D1Database {
  const stmt = (sql: string, params: unknown[] = []) => ({
    first: async () => db.prepare(sql).get(...(params as never[])) ?? null,
    run: async () => {
      db.prepare(sql).run(...(params as never[]));
      return {};
    },
  });
  return {
    prepare: (sql: string) => ({ bind: (...params: unknown[]) => stmt(sql, params), ...stmt(sql) }),
  } as unknown as D1Database;
}

const SCHEMA = readFileSync(join(import.meta.dirname, "../../../workers/gate/schema.sql"), "utf8");
// The tickets table as foundry-decisions-staging has it until the chains_json migration is applied.
const PRE_MIGRATION = `CREATE TABLE tickets (task_id TEXT NOT NULL, base_repo TEXT NOT NULL, base_sha TEXT NOT NULL,
  fork_repo TEXT NOT NULL PRIMARY KEY, agent_id TEXT NOT NULL, scope_json TEXT NOT NULL);`;

function ticket(over: Partial<TaskTicket> = {}): TaskTicket {
  return { taskId: "t", baseRepo: "fleet", baseSha: "a".repeat(40), forkRepo: "t--agent", agentId: "agent",
           scope: newScopeToken("t"), ...over };
}

function store(ddl: string): D1TicketStore {
  const db = new DatabaseSync(":memory:");
  db.exec(ddl);
  return new D1TicketStore(shim(db));
}

describe("D1TicketStore chains", () => {
  it("round-trips declared chains on the committed schema", async () => {
    const s = store(SCHEMA);
    await s.saveTicket(ticket({ chains: ["chain:generational", "chain:deep-research"] }));
    expect((await s.getTicketByFork("t--agent"))?.chains).toEqual(["chain:generational", "chain:deep-research"]);
  });

  it("leaves chains off a ticket that declared none", async () => {
    const s = store(SCHEMA);
    await s.saveTicket(ticket());
    const got = await s.getTicketByFork("t--agent");
    expect(got?.agentId).toBe("agent");
    expect(got && "chains" in got).toBe(false);
  });

  it("keeps taking chainless tickets on a ledger without the migration", async () => {
    const s = store(PRE_MIGRATION);
    await s.saveTicket(ticket());
    expect((await s.getTicketByFork("t--agent"))?.taskId).toBe("t");
    // A declared chain needs the column: it fails loudly rather than being dropped silently.
    await expect(s.saveTicket(ticket({ forkRepo: "t2--agent", chains: ["chain:generational"] }))).rejects.toThrow(
      /chains_json/,
    );
  });
});
