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
