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
