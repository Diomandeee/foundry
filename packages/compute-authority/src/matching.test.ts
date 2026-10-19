// T3 acceptance: exact-mismatch rejections, no VRAM pooling, edge refusal.
import { describe, expect, it } from "vitest";
import { WorkerRegistry } from "./registry.js";
import { matchWorker, type WorkloadSpec } from "./matching.js";

function rig() {
  const reg = new WorkerRegistry();
  const vps = reg.register({
    workerId: "vps", displayName: "VPS", workerClass: "general",
    capabilities: {
      arch: "x86_64", os: "ubuntu-24.04", logicalCores: 2, reservableCores: 2,
      totalMib: 3915, reservableMib: 3000, gpus: [],
      runtimes: ["python3", "docker", "node22"], maxParallelAttempts: 1,
    },
  });
  const pi = reg.register({
    workerId: "pi", displayName: "Pi", workerClass: "edge",
    capabilities: {
      arch: "arm64", os: "debian-13", logicalCores: 4, reservableCores: 2,
      totalMib: 3795, reservableMib: 512, gpus: [],
      runtimes: ["python3", "docker"], maxParallelAttempts: 1,
    },
  });
  const mac = reg.register({
    workerId: "mac", displayName: "Mac", workerClass: "general",
    capabilities: {
      arch: "arm64", os: "macos-26", logicalCores: 10, reservableCores: 8,
      totalMib: 16384, reservableMib: 8192,
      gpus: [{ kind: "metal", vramMib: 16384 }],
      runtimes: ["python3", "node22"], maxParallelAttempts: 2,
    },
  });
  return { vps, pi, mac };
}

const cpuJob: WorkloadSpec = {
  workloadId: "w", kind: "cpu-job", reconstructible: true,
  requires: { arch: ["x86_64", "arm64"], runtimes: ["python3"], minRamMib: 256 },
};

describe("matching", () => {
  it("places a portable cpu job on vps and mac, never pi", () => {
    const { vps, pi, mac } = rig();
    expect(matchWorker(vps, cpuJob).ok).toBe(true);
    expect(matchWorker(mac, cpuJob).ok).toBe(true);
    const piVerdict = matchWorker(pi, cpuJob);
    expect(piVerdict.ok).toBe(false);
    expect(piVerdict.reasons.join(" ")).toMatch("edge");
  });

  it("rejects CUDA on metal-only and cpu-only with exact mismatch", () => {
    const { vps, mac } = rig();
    const cuda: WorkloadSpec = {
      workloadId: "g", kind: "training", reconstructible: false,
      requires: { gpu: { kind: "cuda", minVramMib: 20000 } },
    };
    expect(matchWorker(vps, cuda).reasons.join(" ")).toMatch("no cuda device");
    expect(matchWorker(mac, cuda).reasons.join(" ")).toMatch("no cuda device");
  });

  it("never pools two small GPUs into one big requirement", () => {
    const { mac } = rig();
    const big: WorkloadSpec = {
      workloadId: "big", kind: "training", reconstructible: false,
      requires: { gpu: { kind: "metal", minVramMib: 20000 } },
    };
    // Single 16 GB Metal device must NOT satisfy a 20 GB requirement.
    expect(matchWorker(mac, big).ok).toBe(false);
  });

  it("rejects missing runtime and short ram with reasons", () => {
    const { vps } = rig();
    const needDocker = matchWorker(vps, {
      workloadId: "d", kind: "build-test", reconstructible: true,
      requires: { runtimes: ["bazel"] },
    });
    expect(needDocker.ok).toBe(false);
    expect(needDocker.reasons.join(" ")).toMatch("bazel");
    const needRam = matchWorker(vps, {
      workloadId: "r", kind: "cpu-job", reconstructible: true,
      requires: { minRamMib: 99999 },
    });
    expect(needRam.ok).toBe(false);
    expect(needRam.reasons.join(" ")).toMatch("reservable");
  });
});

 describe("matching malformed inputs", () => {
  it.each([{ minRamMib: NaN }, { minRamMib: -1 }, { minRamMib: 0.5 }, { runtimes: "python3" }, { arch: "x86_64" }, { osContains: [null] }, { gpu: { kind: "cuda", minVramMib: -1 } }])("fails closed for malformed requirements %#", (requires) => {
    expect(matchWorker(rig().vps, { ...cpuJob, requires } as never).ok).toBe(false);
  });
  it("fails closed for null requirements and invalid worker capabilities", () => {
    expect(matchWorker(rig().vps, { ...cpuJob, requires: null } as never).ok).toBe(false);
    expect(matchWorker({ ...rig().vps, capabilities: { ...rig().vps.capabilities, runtimes: null } } as never, cpuJob).ok).toBe(false);
  });
  it.each([0, -1, 0.5, Infinity, NaN])("rejects invalid slot requirements %s", (slotsNeeded) => {
    expect(matchWorker(rig().vps, { ...cpuJob, slotsNeeded }).ok).toBe(false);
  });
});

it("rejects sparse requirement collections", () => {
  expect(matchWorker(rig().vps, { ...cpuJob, requires: { runtimes: new Array(1) } }).reasons).toContain("invalid workload requirements");
});
it("refuses a worker whose static parallel cap cannot fit the request", () => {
  expect(matchWorker(rig().vps, { ...cpuJob, slotsNeeded: 2 }).ok).toBe(false);
  const worker = rig().vps;
  expect(matchWorker({ ...worker, capabilities: { ...worker.capabilities, maxParallelAttempts: 0 } }, cpuJob).ok).toBe(false);
});
