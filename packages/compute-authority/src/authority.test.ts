// Acceptance incl. review probes: no double commit, slot ledger,
// scoped idempotency, expiry, quarantine, terminal states.
import { describe, expect, it } from "vitest";
import { ComputeAuthority } from "./authority.js";

const RESULT = { outcome: "exited", exitCode: 0, stdoutSha256: "abc", stdoutBytes: 100 };
const POLICY = { kind: "cpu-job", exitCode: 0 };

function setup() {
  const auth = new ComputeAuthority(() => 1_000_000);
  auth.registerWorker("vps", 2);
  auth.registerWorker("mac", 1);
  auth.submitWorkload("job-a", 1);
  return auth;
}

describe("concurrent claims cannot double-spend one slot", () => {
  it("20 simultaneous claims yield exactly 1 lease", async () => {
    const auth = setup();
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        Promise.resolve(auth.claim("vps", "job-a", 0, `claim-${i}`)),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(auth.events.filter((e) => e.startsWith("lease-issued"))).toHaveLength(1);
  });

  it("same principal+scope redelivery returns the same lease", () => {
    const auth = setup();
    const first = auth.claim("vps", "job-a", 0, "claim-9");
    const retry = auth.claim("vps", "job-a", 0, "claim-9");
    expect(first).not.toBeNull();
    expect(retry?.leaseId).toBe(first?.leaseId);
  });

  it("a different worker cannot replay another worker's claim scope", () => {
    const auth = setup();
    const first = auth.claim("vps", "job-a", 0, "shared-scope")!;
    const other = auth.claim("mac", "job-a", 0, "shared-scope");
    expect(other).toBeNull();
    expect(first.workerId).toBe("vps");
  });

  it("returned leases are immutable copies", () => {
    const auth = setup();
    const lease = auth.claim("vps", "job-a", 0, "c1")!;
    expect(Object.isFrozen(lease)).toBe(true);
    expect(() => ((lease as { capability: string }).capability = "x")).toThrow();
  });

  it("slot ledger sums slotsNeeded, not rows", () => {
    const auth = new ComputeAuthority(() => 1_000_000);
    auth.registerWorker("w3", 3);
    auth.submitWorkload("big1", 2);
    auth.submitWorkload("big2", 2);
    expect(auth.claim("w3", "big1", 0, "c1")).not.toBeNull();
    expect(auth.claim("w3", "big2", 0, "c2")).toBeNull(); // 2+2 > 3
  });
});

describe("terminal states: a committed workload never commits twice", () => {
  it("second claim and second complete both lose", () => {
    const auth = setup();
    const lease = auth.claim("vps", "job-a", 0, "c1")!;
    expect(auth.complete(lease.leaseId, lease.capability, RESULT, POLICY)).toEqual({
      accepted: true, reason: "committed",
    });
    expect(auth.claim("vps", "job-a", 0, "c2")).toBeNull();
    expect(auth.complete(lease.leaseId, lease.capability, RESULT, POLICY)).toEqual({
      accepted: false, reason: "workload-terminal",
    });
  });

  it("completion without a check policy is rejected", () => {
    const auth = setup();
    const lease = auth.claim("vps", "job-a", 0, "c1")!;
    expect(auth.complete(lease.leaseId, lease.capability, RESULT, { kind: "cpu-job" })).toEqual({
      accepted: false, reason: "unverified:no-policy",
    });
  });
});

describe("fence, quarantine, expiry, requeue", () => {
  it("fenced worker is quarantined until reconciled", () => {
    const auth = setup();
    const lease = auth.claim("vps", "job-a", 0, "c1")!;
    auth.fenceWorker("vps");
    expect(auth.complete(lease.leaseId, lease.capability, RESULT, POLICY).accepted).toBe(false);
    // Capacity is NOT silently freed: new claims refused while quarantined.
    expect(auth.claim("vps", "job-a", 0, "c2")).toBeNull();
    expect(auth.reconcileWorker("vps", 0)).toBe(false); // wrong incarnation
    expect(auth.reconcileWorker("vps", 1)).toBe(true);
  });

  it("requeue ends the old generation first; old results lose", () => {
    const auth = setup();
    const lease = auth.claim("vps", "job-a", 0, "c1")!;
    expect(auth.requeue("job-a")).toBe(true);
    expect(auth.complete(lease.leaseId, lease.capability, RESULT, POLICY)).toEqual({
      accepted: false, reason: "lease-not-live",
    });
    const lease2 = auth.claim("mac", "job-a", 0, "c2")!;
    expect(lease2.generation).toBe(1);
    expect(auth.complete(lease2.leaseId, lease2.capability, RESULT, POLICY)).toEqual({
      accepted: true, reason: "committed",
    });
  });

  it("expired leases cannot renew or commit", () => {
    let t = 1_000_000;
    const auth = new ComputeAuthority(() => t);
    auth.registerWorker("vps", 1);
    auth.submitWorkload("job", 1);
    const lease = auth.claim("vps", "job", 0, "c1", 1000)!;
    t += 2000;
    expect(auth.renew(lease.leaseId, lease.capability)).toBe(false);
    // Renew already killed it: completing now reports not-live, truthfully.
    expect(auth.complete(lease.leaseId, lease.capability, RESULT, POLICY)).toEqual({
      accepted: false, reason: "lease-not-live",
    });
    // A fresh expiry observed at commit time reports expired.
    const auth2 = new ComputeAuthority(() => t);
    auth2.registerWorker("vps", 1);
    auth2.submitWorkload("job", 1);
    t -= 2000;
    const lease2 = auth2.claim("vps", "job", 0, "c1", 1000)!;
    t += 2000;
    expect(auth2.complete(lease2.leaseId, lease2.capability, RESULT, POLICY)).toEqual({
      accepted: false, reason: "lease-expired",
    });
  });

  it("heartbeats extend the lease within a bounded max lifetime", () => {
    let t = 1_000_000;
    const auth = new ComputeAuthority(() => t, 100_000);
    auth.registerWorker("vps", 1);
    auth.submitWorkload("job", 1);
    const lease = auth.claim("vps", "job", 0, "c1", 60_000)!;
    t += 30_000;
    expect(auth.renew(lease.leaseId, lease.capability)).toBe(true); // extends to 90 s
    t += 31_000; // 61 s: alive only because of the renew
    expect(auth.renew(lease.leaseId, lease.capability)).toBe(true);
    t += 100_000; // past issuedAt + maxLifetime: refused, never extended
    expect(auth.renew(lease.leaseId, lease.capability)).toBe(false);
  });

  it("cancel ends the workload; fail-policy never requeues", () => {
    const auth = setup();
    expect(auth.cancel("job-a")).toBe(true);
    expect(auth.claim("vps", "job-a", 0, "c1")).toBeNull();
    auth.submitWorkload("once", 1, "fail");
    const lease = auth.claim("vps", "once", 0, "c1")!;
    auth.fenceWorker("vps");
    expect(auth.complete(lease.leaseId, lease.capability, RESULT, POLICY).accepted).toBe(false);
    expect(auth.requeue("once")).toBe(false);
  });

  it("edge class holds zero slots even when asked", () => {
    const auth = new ComputeAuthority(() => 1_000_000);
    const edge = auth.registerWorker("pi", 4, "edge");
    expect(edge.slots).toBe(0);
    auth.submitWorkload("job", 1);
    expect(auth.claim("pi", "job", 0, "c1")).toBeNull();
  });

  it("re-registration preserves incarnation", () => {
    const auth = setup();
    auth.fenceWorker("vps");
    const again = auth.registerWorker("vps", 2);
    expect(again.incarnation).toBe(1);
  });
});
