// T7 + T8 acceptance: snapshot shape with watermark; quote-only, no provisioning surface.
import { describe, expect, it } from "vitest";
import { WorkerRegistry } from "./registry.js";
import { ComputeAuthority } from "./authority.js";
import {POLICY} from "./test-artifacts.js";
import { AuditLog } from "./verifier.js";
import { snapshotFor } from "./dashboard.js";
import { normalizeQuotes, filterQuotes } from "./vastai.js";

describe("dashboard snapshot", () => {
  it("carries workers, watermark, and recent events — no DB handles", () => {
    const reg = new WorkerRegistry();
    reg.register({
      workerId: "vps", displayName: "VPS", workerClass: "general",
      capabilities: {
        arch: "x86_64", os: "u", logicalCores: 2, reservableCores: 2,
        totalMib: 4000, reservableMib: 3000, gpus: [],
        runtimes: ["python3"], maxParallelAttempts: 1,
      },
    });
    const audit = new AuditLog();
    audit.append("worker-registered", "vps");
    const auth = new ComputeAuthority();
    auth.registerWorker("vps", 1, 'general');
    auth.submitWorkload("job", 1, "retry-new-attempt", 3, POLICY);
    auth.claim("vps", "job", 0, "c1");
    const snap = snapshotFor(auth, reg);
    expect(snap.workers).toHaveLength(1);
    expect(snap.workers[0].trustTier).toBe("standard");
    expect(snap.liveLeases).toHaveLength(1);
    expect(snap.liveLeases[0].workerId).toBe("vps");
    expect(snap.watermark.pendingOutbox).toBe(3);
    expect(JSON.stringify(snap)).not.toMatch("password|secret|token");
  });
});

describe("vastai quotes", () => {
  it("normalizes, sorts, drops unpriced rows; filters by budget", () => {
    const quotes = normalizeQuotes([
      { id: "a", model: "RTX 3090", vram_mib: 24576, usd_per_hour: 0.25 },
      { id: "b", model: "RTX 4090", vram_mib: 24576 }, // no price -> dropped
      { id: "c", model: "RTX 3080", vram_mib: 10240, usd_per_hour: 0.12 },
    ], "vastai", 123);
    expect(quotes.map((q) => q.gpuModel)).toEqual(["RTX 3080", "RTX 3090"]);
    expect(quotes.every((q) => q.feesUnknown)).toBe(true);
    const cheap = filterQuotes(quotes, { minVramMib: 8000, maxUsdPerHour: 0.15 });
    expect(cheap).toHaveLength(1);
  });

  it("exposes no provisioning capability", async () => {
    const mod = await import("./vastai.js");
    expect(Object.keys(mod).sort()).toEqual(["filterQuotes", "normalizeQuotes"]);
  });
});
