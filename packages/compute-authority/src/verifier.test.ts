// T6 acceptance: independent checks reject bad results; outbox drains exactly once.
import { describe, expect, it } from "vitest";
import { verifyResult, AuditLog } from "./verifier.js";

const good = {
  leaseId: "l", outcome: "exited" as const, exitCode: 0, signal: null, resolvedBin: "/usr/bin/python3",
  stdoutSha256: "abc", stdoutBytes: 100, stderrTail: "",
};

describe("verifier", () => {
  it("accepts matching results, rejects mismatches independently", () => {
    expect(verifyResult(good, { kind: "cpu-job", exitCode: 0 }).verified).toBe(true);
    expect(verifyResult(good, { kind: "cpu-job", exitCode: 0, stdoutSha256: "zzz" })).toEqual({
      verified: false, reason: "sha-mismatch",
    });
    expect(verifyResult(good, { kind: "anything" })).toEqual({
      verified: false, reason: "no-policy",
    });
    expect(verifyResult({ ...good, outcome: "timed-out", exitCode: null }, { kind: "cpu-job", exitCode: 0 })).toEqual({
      verified: false, reason: "exec-timed-out",
    });
    expect(verifyResult({ ...good, stdoutBytes: 1 }, { kind: "cpu-job", minBytes: 10 })).toEqual({
      verified: false, reason: "too-few-bytes",
    });
  });
});

describe("audit outbox", () => {
  it("drains exactly once with ack cursor", () => {
    const log = new AuditLog();
    log.append("lease-issued", "l1");
    log.append("result-committed", "l1");
    expect(log.pendingOutbox).toBe(2);
    const batch = log.drainOutbox();
    expect(batch.map((e) => e.seq)).toEqual([0, 1]);
    expect(log.ackOutbox_through(1)).toBe(true);
    expect(log.pendingOutbox).toBe(0);
    log.append("lease-issued", "l2");
    expect(log.drainOutbox().map((e) => e.detail)).toEqual(["l2"]);
  });

  it("rejects future, duplicate, and non-integer acks", () => {
    const log = new AuditLog();
    log.append("a", "1");
    expect(log.ackOutbox_through(99)).toBe(false);
    expect(log.pendingOutbox).toBe(1);
    expect(log.drainOutbox()).toHaveLength(1);
    expect(log.ackOutbox_through(0)).toBe(true);
    expect(log.ackOutbox_through(0)).toBe(false); // duplicate
    expect(log.ackOutbox_through(1.5)).toBe(false);
    expect(log.pendingOutbox).toBe(0);
  });

  it("rejects acks for events never drained (no silent skips)", () => {
    const log = new AuditLog();
    for (let i = 0; i < 10; i++) log.append("e", String(i));
    expect(log.ackOutbox_through(9)).toBe(false);
    expect(log.pendingOutbox).toBe(10);
    expect(log.drainOutbox()).toHaveLength(10);
    expect(log.ackOutbox_through(9)).toBe(true);
    expect(log.pendingOutbox).toBe(0);
  });
});
