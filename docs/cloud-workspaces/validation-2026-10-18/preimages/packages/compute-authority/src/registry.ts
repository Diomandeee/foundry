// T1: worker registry. Registration is a claim about capabilities;
// the authority assigns trust and never takes the worker's word for it.
export type WorkerClass = "general" | "edge";
export type GpuKind = "metal" | "cuda";

export interface GpuDevice {
  kind: GpuKind;
  vramMib: number;
  computeCapability?: string;
}

export interface WorkerCapabilities {
  arch: "x86_64" | "arm64";
  os: string;
  logicalCores: number;
  reservableCores: number;
  totalMib: number;
  reservableMib: number;
  gpus: GpuDevice[];
  runtimes: string[];
  maxParallelAttempts: number;
}

export interface WorkerRecord {
  workerId: string;
  displayName: string;
  workerClass: WorkerClass;
  capabilities: WorkerCapabilities;
  labels: Record<string, string>;
  /** Server-assigned. Never accepted from the worker. */
  trustTier: "untrusted" | "standard" | "privileged";
  firstSeen: number;
  lastReassert: number;
}

export interface RegistrationInput {
  workerId: string;
  displayName: string;
  workerClass: WorkerClass;
  capabilities: WorkerCapabilities;
  labels?: Record<string, string>;
  /** Must be absent: trust is assigned, not declared. */
  trustTier?: unknown;
}

export const integer = (value: unknown, min: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min;

const ID = /^[A-Za-z0-9._-]{1,64}$/;

export function checkCaps(c: WorkerCapabilities): string | null {
  if (!c || typeof c !== "object") return "capabilities-missing";
  if (c.arch !== "x86_64" && c.arch !== "arm64") return "bad-arch";
  if (typeof c.os !== "string" || c.os.length === 0) return "bad-os";
  if (!integer(c.logicalCores, 1) || !integer(c.reservableCores, 0) || c.reservableCores > c.logicalCores) {
    return "bad-cpu";
  }
  if (!integer(c.totalMib, 1) || !integer(c.reservableMib, 0) || c.reservableMib > c.totalMib) {
    return "bad-ram";
  }
  if (!Array.isArray(c.gpus)) return "bad-gpus";
  for (const g of c.gpus) {
    if (!g || typeof g !== "object" || (g.kind !== "metal" && g.kind !== "cuda") || !integer(g.vramMib, 1) || (g.computeCapability !== undefined && typeof g.computeCapability !== "string")) return "bad-gpu";
  }
  if (!Array.isArray(c.runtimes) || ![...c.runtimes].every((r) => typeof r === "string" && r.length > 0)) return "bad-runtimes";
  if (!integer(c.maxParallelAttempts, 0)) return "bad-parallel";
  return null;
}

/** Deep-frozen copy: nested caps, gpus, and labels included. */
function frozen(w: WorkerRecord): WorkerRecord {
  const c = w.capabilities;
  return Object.freeze({
    ...w,
    capabilities: Object.freeze({
      arch: c.arch, os: c.os, logicalCores: c.logicalCores,
      reservableCores: c.reservableCores, totalMib: c.totalMib,
      reservableMib: c.reservableMib, maxParallelAttempts: c.maxParallelAttempts,
      gpus: Object.freeze(c.gpus.map((g) => Object.freeze({
        kind: g.kind, vramMib: g.vramMib,
        ...(g.computeCapability === undefined ? {} : { computeCapability: g.computeCapability }),
      }))) as unknown as GpuDevice[],
      runtimes: Object.freeze([...c.runtimes]) as unknown as string[],
    }),
    labels: Object.freeze({ ...w.labels }),
  });
}

export class WorkerRegistry {
  private workers = new Map<string, WorkerRecord>();

  register(input: RegistrationInput, now: number = Date.now()): WorkerRecord {
    if (!input || (typeof input.workerId !== "string" || !ID.test(input.workerId))) throw new Error("invalid workerId");
    if (typeof input.displayName !== "string" || input.displayName.length === 0) {
      throw new Error("invalid displayName");
    }
    if (input.workerClass !== "general" && input.workerClass !== "edge") {
      throw new Error("invalid workerClass");
    }
    if (input.trustTier !== undefined) throw new Error("trustTier is server-assigned");
    const bad = checkCaps(input.capabilities);
    if (bad) throw new Error(`invalid capabilities: ${bad}`);
    if (input.labels !== undefined && (!input.labels || typeof input.labels !== "object" ||
      Array.isArray(input.labels) || ![Object.prototype, null].includes(Object.getPrototypeOf(input.labels)) ||
      !Object.values(input.labels).every((v) => typeof v === "string"))) {
      throw new Error("invalid labels");
    }
    if (!integer(now, 0)) throw new Error("invalid timestamp");
    const prior = this.workers.get(input.workerId);
    if (prior && prior.workerClass !== input.workerClass) {
      throw new Error("workerClass cannot change for an existing workerId");
    }
    const record: WorkerRecord = {
      workerId: input.workerId,
      displayName: input.displayName,
      workerClass: input.workerClass,
      capabilities: input.capabilities,
      labels: input.labels ?? {},
      // Edge workers observe only: zero execution slots by policy.
      trustTier: input.workerClass === "edge" ? "untrusted" : "standard",
      firstSeen: prior?.firstSeen ?? now,
      lastReassert: now,
    };
    this.workers.set(input.workerId, frozen(record));
    return frozen(record);
  }

  /** Re-assert with changed caps (e.g. RAM upgrade); trust never changes via this path. */
  reassert(workerId: string, capabilities: WorkerCapabilities, now: number = Date.now()): WorkerRecord {
    const prior = this.workers.get(workerId);
    if (!prior) throw new Error("unknown worker");
    const bad = checkCaps(capabilities);
    if (bad) throw new Error(`invalid capabilities: ${bad}`);
    if (!integer(now, 0)) throw new Error("invalid timestamp");
    const next: WorkerRecord = { ...prior, capabilities, lastReassert: now };
    this.workers.set(workerId, frozen(next));
    return frozen(next);
  }

  deregister(workerId: string): boolean {
    return this.workers.delete(workerId);
  }

  /** Frozen copy: callers can never mutate stored trust or caps. */
  get(workerId: string): WorkerRecord | null {
    const rec = this.workers.get(workerId);
    return rec ? frozen(rec) : null;
  }

  list(): WorkerRecord[] {
    return [...this.workers.values()].map(frozen);
  }
}
