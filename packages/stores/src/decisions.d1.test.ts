// Runs the D1 store's real SQL against real SQLite (node:sqlite) through a
// minimal D1Database shim, against the committed schema. The in-memory store
// cannot prove the ON CONFLICT behaviour a retry depends on.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { D1DecisionStore } from "./decisions.js";

function shim(db: DatabaseSync): D1Database {
  const stmt = (sql: string, params: unknown[] = []) => ({
    all: async () => ({ results: db.prepare(sql).all(...(params as never[])) }),
    first: async () => db.prepare(sql).get(...(params as never[])) ?? null,
    run: async () => {
      db.prepare(sql).run(...(params as never[]));
      return {};
    },
  });
  return {
    prepare: (sql: string) => ({
      bind: (...params: unknown[]) => stmt(sql, params),
      ...stmt(sql),
    }),
    exec: async (sql: string) => {
      db.exec(sql);
    },
  } as unknown as D1Database;
}

const event = {
  namespace: "test",
  repo: "fork-1",
  ref: "refs/heads/main",
  before_sha: "a".repeat(40),
  after_sha: "b".repeat(40),
};

let store: D1DecisionStore;

beforeEach(() => {
  const db = new DatabaseSync(":memory:");
  db.exec(
    readFileSync(
      join(import.meta.dirname, "../../../workers/gate/schema.sql"),
      "utf8",
    ),
  );
  store = new D1DecisionStore(shim(db));
});

describe("D1DecisionStore failure classification", () => {
  it("replaces an error row with the verdict on retry, keeping one row", async () => {
    const first = await store.record({
      ...event,
      verdict: "error",
      reason: { reason: "infra_failure", message: "infra: merge:push: boom" },
    });
    expect(first.verdict).toBe("error");

    const second = await store.record({
      ...event,
      verdict: "merge",
      merged_sha: "c".repeat(40),
      files: ["feature.txt"],
    });
    expect(second.verdict).toBe("merge");
    expect(second.id).toBe(first.id);
    expect(second.merged_sha).toBe("c".repeat(40));
    expect((await store.list()).length).toBe(1);
  });

  it("keeps an error row discoverable while it is still failing", async () => {
    await store.record({ ...event, verdict: "error" });
    const rows = await store.list();
    expect(rows.map((r) => r.verdict)).toEqual(["error"]);
  });

  it("never overwrites a final decision", async () => {
    const first = await store.record({ ...event, verdict: "merge" });
    const again = await store.record({ ...event, verdict: "reject" });
    expect(again.id).toBe(first.id);
    expect(again.verdict).toBe("merge");
    expect((await store.list()).length).toBe(1);
  });

  it("does not let an error row stand in for a decision", async () => {
    await store.record({ ...event, verdict: "error" });
    const found = await store.findByEvent(
      event.namespace,
      event.repo,
      event.ref,
      event.before_sha,
      event.after_sha,
    );
    expect(found).toBeNull();
  });
});

describe("D1DecisionStore.listPage", () => {
  it("pages past the old 200-row window without losing history", async () => {
    for (let i = 1; i <= 250; i++) {
      await store.record({
        ...event,
        after_sha: i.toString(16).padStart(40, "0"),
        verdict: i % 5 === 0 ? "merge" : "reject",
      });
    }
    const seen: number[] = [];
    let beforeId: number | undefined;
    for (let page = 0; page < 10; page++) {
      const rows = await store.listPage({ beforeId, limit: 50 });
      if (rows.length === 0) break;
      seen.push(...rows.map((r) => r.id as number));
      beforeId = rows[rows.length - 1].id as number;
    }
    expect(seen.length).toBe(250);
    expect(new Set(seen).size).toBe(250);
    expect(Math.min(...seen)).toBe(1);
  });

  it("filters by repo and stops at the end of the feed", async () => {
    for (let i = 1; i <= 5; i++) {
      await store.record({
        ...event,
        repo: i % 2 === 0 ? "fork-2" : "fork-1",
        after_sha: i.toString(16).padStart(40, "0"),
        verdict: "reject",
      });
    }
    const fork2 = await store.listPage({ repo: "fork-2", limit: 50 });
    expect(fork2.map((r) => r.repo)).toEqual(["fork-2", "fork-2"]);
    const exhausted = await store.listPage({
      beforeId: 1,
      limit: 50,
    });
    expect(exhausted).toEqual([]);
  });
});
