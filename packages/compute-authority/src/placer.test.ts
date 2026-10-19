// T4 acceptance: deterministic choice, replayable records, full rejection lists.
import { describe, expect, it } from "vitest";
import { WorkerRegistry } from "./registry.js";
import { place } from "./placer.js";
import type { WorkloadSpec } from "./matching.js";

function rig() {
  const reg = new WorkerRegistry();
  const mk = (workerId: string, reservableMib: number, arch: "x86_64" | "arm64" = "x86_64") =>
    reg.register({
      workerId, displayName: workerId, workerClass: "general",
      capabilities: {
        arch, os: "linux", logicalCores: 4, reservableCores: 4,
        totalMib: 8192, reservableMib, gpus: [],
        runtimes: ["python3"], maxParallelAttempts: 1,
      },
    });
  return [mk("b-worker", 2000), mk("a-worker", 4000)];
}

const spec: WorkloadSpec = {
  workloadId: "w", kind: "cpu-job", reconstructible: true,
  requires: { arch: ["x86_64"], runtimes: ["python3"], minRamMib: 256 },
};

describe("placer", () => {
  it("picks max headroom deterministically", () => {
    const p1 = place(rig(), spec);
    const p2 = place(rig(), spec);
    expect(p1.workerId).toBe("a-worker");
    expect(p1.workerId).toBe(p2.workerId);
    expect(p1.reasonCodes).toContain("max-headroom");
    expect(p1.facts.headroomMib).toBe(4000);
  });

  it("snapshot carries capabilities, is frozen and immune to later mutation", () => {
    const workers = rig().map((w) => ({ ...w, capabilities: { ...w.capabilities } }));
    const p = place(workers, spec);
    expect(p.inputSnapshot.workers).toHaveLength(2);
    expect(p.inputSnapshot.workers[0]).toHaveProperty("capabilities");
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.isFrozen(p.inputSnapshot)).toBe(true);
    expect(Object.isFrozen(p.inputSnapshot.workload)).toBe(true);
    workers[0].capabilities.reservableMib = 1; // mutate after the fact
    const snapCaps = p.inputSnapshot.workers[0].capabilities as { reservableMib: number };
    expect(snapCaps.reservableMib).not.toBe(1);
    expect(p.inputSnapshot.workload.workloadId).toBe("w");
  });

  it("respects live load and lists every rejection", () => {
    const workers = rig();
    const loaded = place(workers, spec, { "a-worker": 3900 });
    expect(loaded.workerId).toBe("b-worker");
    const impossible: WorkloadSpec = {
      ...spec, requires: { arch: ["x86_64"], minRamMib: 99999 },
    };
    const none = place(workers, impossible);
    expect(none.workerId).toBeNull();
    expect(none.reasonCodes).toEqual(["no-compatible-worker"]);
    expect(none.rejected).toHaveLength(2);
  });
});

 describe("placement replay regressions", () => {
  it("rejects workers with insufficient actual RAM headroom", () => {
    const p = place(rig(), spec, { "a-worker": 3900, "b-worker": 1900 });
    expect(p.workerId).toBeNull();
    expect(p.rejected).toHaveLength(2);
  });
  it.each([NaN, Infinity, -1, 0.5])("fails closed on invalid live load %s", (load) => {
    expect(place(rig(), spec, { "a-worker": load, "b-worker": load }).workerId).toBeNull();
  });
  it("captures class, policy and explicit stable reservation evidence without aliases", () => {
    const evidence = { policyVersion: "owner-policy-7", reservations: [{ reservationId: "lease-1", workerId: "a-worker", slots: 1, expiresAt: 2000 }] };
    const p = place(rig(), spec, {}, evidence);
    expect(p.inputSnapshot.workers[0].workerClass).toBe("general");
    expect(p.inputSnapshot.policyVersion).toBe("owner-policy-7");
    expect(p.inputSnapshot.reservations).toEqual(evidence.reservations);
    evidence.reservations[0].reservationId = "changed";
    expect(p.inputSnapshot.reservations![0].reservationId).toBe("lease-1");
    expect(Object.isFrozen(p.inputSnapshot.reservations![0])).toBe(true);
    expect(place(rig(), spec).inputSnapshot.reservations).toBeUndefined();
  });
});

it("uses fixed identifier ordering for ties and snapshots regardless of input order", () => {
  const workers = rig().map((w) => ({ ...w, capabilities: { ...w.capabilities, reservableMib: 4000 } }));
  workers[0].workerId = "Z-worker";
  const p = place(workers, spec);
  expect(p.workerId).toBe("Z-worker");
  const reversed = place([...workers].reverse(), spec);
  expect(reversed.workerId).toBe(p.workerId);
  expect(reversed.inputSnapshot).toEqual(p.inputSnapshot);
  expect(p.inputSnapshot.placerPolicyVersion).toBeTruthy();
});
it("replays eligibility and scoring from the captured inputs", () => {
  const workers = rig();
  workers[0] = { ...workers[0], workerClass: "edge" };
  const p = place(workers, spec, { "a-worker": 100 });
  const snap = p.inputSnapshot;
  const replay = place(snap.workers.map((w) => ({ ...workers.find((original) => original.workerId === w.id)!, workerClass: w.workerClass, capabilities: w.capabilities as typeof workers[0]["capabilities"] })), snap.workload, Object.fromEntries(snap.workers.map((w) => [w.id, w.load])));
  expect(replay.workerId).toBe(p.workerId);
  expect(replay.rejected).toEqual(p.rejected);
  expect(replay.facts).toEqual(p.facts);
});
it("rejects malformed top-level collections and evidence with controlled errors", () => {
  expect(() => place(null as never, spec)).toThrow("invalid workers");
  expect(() => place(rig(), spec, null as never)).toThrow("invalid worker loads");
  expect(() => place(rig(), spec, {}, { policyVersion: "v", reservations: [null] } as never)).toThrow("invalid placement evidence");
  expect(() => place(rig(), spec, {}, { policyVersion: "v", reservations: new Array(1) })).toThrow("invalid placement evidence");
});
it("does not copy secret-bearing extra reservation fields into audit snapshots", () => {
  const reservation = { reservationId: "r", workerId: "a-worker", slots: 1, expiresAt: 2000, capability: "fixture-secret" };
  const p = place(rig(), spec, {}, { policyVersion: "v", reservations: [reservation] });
  expect(p.inputSnapshot.reservations![0]).not.toHaveProperty("capability");
});
