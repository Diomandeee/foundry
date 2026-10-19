// T3: typed workload specs + compatibility matching.
// Compatibility is checked before capacity. Accelerator kinds are
// never interchangeable and independent devices are never summed.
import { checkCaps, integer, type WorkerRecord } from "./registry.js";

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

/** Runtime boundaries reject malformed JSON instead of coercing requirements. */
export function validWorkload(spec: WorkloadSpec): boolean {
  if (!spec || typeof spec !== "object" || typeof spec.workloadId !== "string" || !spec.workloadId ||
    !["cpu-job", "build-test", "inference-batch", "training", "embedding"].includes(spec.kind) ||
    typeof spec.reconstructible !== "boolean" ||
    (spec.slotsNeeded !== undefined && !integer(spec.slotsNeeded, 1))) return false;
  const req = spec.requires;
  if (!req || typeof req !== "object" || Array.isArray(req)) return false;
  for (const key of ["arch", "osContains", "runtimes"] as const) {
    const value = req[key];
    if (value !== undefined && (!Array.isArray(value) ||
      ![...value].every((s) => typeof s === "string" && s.length > 0))) return false;
  }
  if (req.arch?.some((a) => a !== "x86_64" && a !== "arm64")) return false;
  if (req.minRamMib !== undefined && !integer(req.minRamMib, 0)) return false;
  if (req.gpu !== undefined && (!req.gpu || typeof req.gpu !== "object" ||
    (req.gpu.kind !== "metal" && req.gpu.kind !== "cuda") || !integer(req.gpu.minVramMib, 1))) return false;
  return true;
}

export function matchWorker(worker: WorkerRecord, spec: WorkloadSpec): MatchVerdict {
  if (!validWorkload(spec)) return { ok: false, reasons: ["invalid workload requirements"] };
  if (!worker || (worker.workerClass !== "general" && worker.workerClass !== "edge") || checkCaps(worker.capabilities)) {
    return { ok: false, reasons: ["invalid worker capabilities"] };
  }
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
  if (caps.maxParallelAttempts < (spec.slotsNeeded ?? 1)) {
    return { ok: false, reasons: ["parallel capacity below requested slots"] };
  }
  reasons.push(`arch ${caps.arch}`, `ram ${caps.reservableMib}MiB reservable`);
  return { ok: true, reasons };
}
