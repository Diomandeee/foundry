// T3: typed workload specs + compatibility matching.
// Compatibility is checked before capacity. Accelerator kinds are
// never interchangeable and independent devices are never summed.
import type { WorkerRecord } from "./registry.js";

export type WorkloadKind = "cpu-job" | "build-test" | "inference-batch" | "training" | "embedding";

export interface WorkloadRequire {
  arch?: Array<"x86_64" | "arm64">;
  osContains?: string[];
  runtimes?: string[];
  minRamMib?: number;
  gpu?: { kind: "metal" | "cuda"; minVramMib: number };
}

export interface WorkloadSpec {
  workloadId: string;
  kind: WorkloadKind;
  requires: WorkloadRequire;
  reconstructible: boolean;
  slotsNeeded?: number;
}

export interface MatchVerdict {
  ok: boolean;
  reasons: string[];
}

export function matchWorker(worker: WorkerRecord, spec: WorkloadSpec): MatchVerdict {
  const reasons: string[] = [];
  const caps = worker.capabilities;
  const req = spec.requires;

  if (req.arch && !req.arch.includes(caps.arch)) {
    return { ok: false, reasons: [`arch ${caps.arch} not in [${req.arch.join(",")}]`] };
  }
  if (req.osContains && !req.osContains.some((s) => caps.os.includes(s))) {
    return { ok: false, reasons: [`os ${caps.os} matches none of [${req.osContains.join(",")}]`] };
  }
  for (const r of req.runtimes ?? []) {
    if (!caps.runtimes.includes(r)) {
      return { ok: false, reasons: [`runtime ${r} missing (has ${caps.runtimes.join(",")})`] };
    }
  }
  if (req.minRamMib && caps.reservableMib < req.minRamMib) {
    return { ok: false, reasons: [`reservable ${caps.reservableMib}MiB < required ${req.minRamMib}MiB`] };
  }
  if (req.gpu) {
    const dev = caps.gpus.find((g) => g.kind === req.gpu!.kind && g.vramMib >= req.gpu!.minVramMib);
    if (!dev) {
      const kinds = caps.gpus.map((g) => `${g.kind}:${g.vramMib}`).join(",") || "none";
      return { ok: false, reasons: [`no ${req.gpu.kind} device with >=${req.gpu.minVramMib}MiB (has ${kinds})`] };
    }
    reasons.push(`gpu ${dev.kind}:${dev.vramMib}MiB satisfies >=${req.gpu.minVramMib}MiB`);
  }
  if (worker.workerClass === "edge") {
    return { ok: false, reasons: ["edge workers observe only: zero execution slots"] };
  }
  reasons.push(`arch ${caps.arch}`, `ram ${caps.reservableMib}MiB reservable`);
  return { ok: true, reasons };
}
