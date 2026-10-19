// T1 acceptance: validation, server-assigned trust, edge zero-slots policy.
import { describe, expect, it } from "vitest";
import { WorkerRegistry, type WorkerCapabilities } from "./registry.js";

const vpsCaps: WorkerCapabilities = {
  arch: "x86_64",
  os: "ubuntu-24.04",
  logicalCores: 2,
  reservableCores: 2,
  totalMib: 3915,
  reservableMib: 3000,
  gpus: [],
  runtimes: ["python3", "docker", "node22"],
  maxParallelAttempts: 1,
};

const piCaps: WorkerCapabilities = {
  arch: "arm64",
  os: "debian-13-trixie",
  logicalCores: 4,
  reservableCores: 2,
  totalMib: 3795,
  reservableMib: 512,
  gpus: [],
  runtimes: ["python3", "docker"],
  maxParallelAttempts: 1,
};

describe("worker registry", () => {
  it("registers general workers as standard trust", () => {
    const reg = new WorkerRegistry();
    const rec = reg.register({ workerId: "foundry-node-01", displayName: "VPS", workerClass: "general", capabilities: vpsCaps });
    expect(rec.trustTier).toBe("standard");
    expect(rec.firstSeen).toBe(rec.lastReassert);
  });

  it("registers edge workers untrusted (observe-only by policy)", () => {
    const reg = new WorkerRegistry();
    const rec = reg.register({ workerId: "minenode", displayName: "Pi", workerClass: "edge", capabilities: piCaps });
    expect(rec.trustTier).toBe("untrusted");
  });

  it("rejects worker-declared trust", () => {
    const reg = new WorkerRegistry();
    expect(() =>
      reg.register({ workerId: "evil", displayName: "E", workerClass: "general", capabilities: vpsCaps, trustTier: "privileged" }),
    ).toThrow("server-assigned");
  });

  it("rejects reservable exceeding total and bad arch", () => {
    const reg = new WorkerRegistry();
    expect(() =>
      reg.register({ workerId: "x", displayName: "X", workerClass: "general", capabilities: { ...vpsCaps, reservableMib: 99999 } }),
    ).toThrow("bad-ram");
    expect(() =>
      reg.register({ workerId: "y", displayName: "Y", workerClass: "general", capabilities: { ...vpsCaps, arch: "riscv" as never } }),
    ).toThrow("bad-arch");
  });

  it("returned records are frozen: trust cannot be escalated through get()", () => {
    const reg = new WorkerRegistry();
    reg.register({ workerId: "vps", displayName: "V", workerClass: "general", capabilities: vpsCaps });
    const got = reg.get("vps")!;
    expect(Object.isFrozen(got)).toBe(true);
    expect(() => ((got as { trustTier: string }).trustTier = "privileged")).toThrow();
    expect(reg.get("vps")!.trustTier).toBe("standard");
  });

  it("reassert updates caps but never trust; deregister removes", () => {
    const reg = new WorkerRegistry();
    reg.register({ workerId: "vps", displayName: "V", workerClass: "general", capabilities: vpsCaps });
    const next = reg.reassert("vps", { ...vpsCaps, reservableMib: 2000 });
    expect(next.capabilities.reservableMib).toBe(2000);
    expect(next.trustTier).toBe("standard");
    expect(reg.deregister("vps")).toBe(true);
    expect(reg.get("vps")).toBeNull();
  });
});

 describe("registry reference isolation regressions", () => {
  it("owns registration/reassert inputs and freezes nested output arrays", () => {
    const reg = new WorkerRegistry();
    const caps = structuredClone(vpsCaps);
    caps.gpus = [{ kind: "metal", vramMib: 2048 }];
    const labels = { zone: "local" };
    const rec = reg.register({ workerId: "owned", displayName: "Owned", workerClass: "general", capabilities: caps, labels });
    caps.reservableMib = 1;
    caps.runtimes.push("injected");
    caps.gpus[0].vramMib = 1;
    labels.zone = "changed";
    expect(reg.get("owned")!.capabilities.reservableMib).toBe(3000);
    expect(reg.get("owned")!.labels.zone).toBe("local");
    expect(Object.isFrozen(rec.capabilities.runtimes)).toBe(true);
    expect(Object.isFrozen(rec.capabilities.gpus)).toBe(true);
    expect(Object.isFrozen(rec.capabilities.gpus[0])).toBe(true);
    expect(reg.get("owned")!.capabilities.gpus[0].vramMib).toBe(2048);
    expect(reg.get("owned")!.capabilities.runtimes).not.toContain("injected");
    const next = structuredClone(vpsCaps);
    reg.reassert("owned", next);
    next.runtimes.push("injected");
    expect(reg.list()[0].capabilities.runtimes).not.toContain("injected");
  });
  it.each([Infinity, NaN, 1.5, "2"])("rejects non-finite/non-integer caps %s", (value) => {
    const reg = new WorkerRegistry();
    for (const field of ["logicalCores", "reservableCores", "totalMib", "reservableMib", "maxParallelAttempts"]) {
      expect(() => reg.register({ workerId: "bad", displayName: "Bad", workerClass: "general", capabilities: { ...vpsCaps, [field]: value } as WorkerCapabilities })).toThrow();
    }
  });
  it.each([{ gpus: [null] }, { gpus: [{ kind: "metal", vramMib: Infinity }] }, { runtimes: [null] }, { runtimes: "node" }, { labels: [] }, { labels: { zone: 1 } }])("rejects malformed collections %#", (patch) => {
    const reg = new WorkerRegistry();
    expect(() => reg.register({ workerId: "bad", displayName: "Bad", workerClass: "general", capabilities: { ...vpsCaps, ...patch }, ...("labels" in patch ? { labels: patch.labels } : {}) } as never)).toThrow(/invalid/);
  });
});

it("rejects sparse runtime collections", () => {
  expect(() => new WorkerRegistry().register({ workerId: "sparse", displayName: "S", workerClass: "general", capabilities: { ...vpsCaps, runtimes: new Array(1) } })).toThrow("bad-runtimes");
});

describe("registration class stability", () => {
  it.each(["edge", "general"] as const)("rejects changing an existing %s worker class without changing its record", (workerClass) => {
    const reg = new WorkerRegistry();
    const input = { workerId: "stable-class", displayName: "Original", workerClass, capabilities: structuredClone(vpsCaps) };
    const original = reg.register(input, 1000);
    expect(() => reg.register({ ...input, displayName: "Changed", workerClass: workerClass === "edge" ? "general" : "edge" }, 2000)).toThrow("workerClass cannot change");
    expect(reg.get(input.workerId)).toEqual(original);
    const refreshed = reg.register({ ...input, displayName: "Refreshed" }, 3000);
    expect(refreshed.workerClass).toBe(workerClass);
    expect(refreshed.trustTier).toBe(original.trustTier);
    expect(refreshed.firstSeen).toBe(1000);
    expect(refreshed.lastReassert).toBe(3000);
  });
});
