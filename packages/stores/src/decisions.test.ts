import { describe, expect, it } from "vitest";
import { MemoryDecisionStore } from "./decisions.js";

const event = {
  namespace: "test",
  repo: "fork-1",
  ref: "refs/heads/main",
  before_sha: "a".repeat(40),
  after_sha: "b".repeat(40),
};

describe("MemoryDecisionStore idempotency", () => {
  it("returns the first decision for a repeated event", async () => {
    const store = new MemoryDecisionStore();
    const first = await store.record({ ...event, verdict: "merge" });
    const second = await store.record({ ...event, verdict: "reject" });
    expect(second.id).toBe(first.id);
    expect(second.verdict).toBe("merge");
    expect(
      await store.findByEvent(
        event.namespace,
        event.repo,
        event.ref,
        event.before_sha,
        event.after_sha,
      ),
    ).toMatchObject({ id: first.id, verdict: "merge" });
  });

  it("records distinct events separately", async () => {
    const store = new MemoryDecisionStore();
    const a = await store.record({ ...event, verdict: "merge" });
    const b = await store.record({
      ...event,
      after_sha: "c".repeat(40),
      verdict: "reject",
    });
    expect(b.id).not.toBe(a.id);
    expect((await store.list()).length).toBe(2);
  });
});
