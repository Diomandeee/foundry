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

const ID = /^[A-Za-z0-9._-]{1,64}$/;

function checkCaps(c: WorkerCapabilities): string | null {
  if (!c || typeof c !== "object") return "capabilities-missing";
  if (c.arch !== "x86_64" && c.arch !== "arm64") return "bad-arch";
  if (typeof c.os !== "string" || c.os.length === 0) return "bad-os";
  if (!(c.logicalCores >= 1) || !(c.reservableCores >= 0) || c.reservableCores > c.logicalCores) {
    return "bad-cpu";
  }
  if (!(c.totalMib >= 1) || !(c.reservableMib >= 0) || c.reservableMib > c.totalMib) {
    return "bad-ram";
  }
  if (!Array.isArray(c.gpus)) return "bad-gpus";
  for (const g of c.gpus) {
    if ((g.kind !== "metal" && g.kind !== "cuda") || !(g.vramMib >= 1)) return "bad-gpu";
  }
  if (!Array.isArray(c.runtimes)) return "bad-runtimes";
  if (!(c.maxParallelAttempts >= 0)) return "bad-parallel";
  return null;
}

/** Deep-frozen copy: nested caps, gpus, and labels included. */
function frozen(w: WorkerRecord): WorkerRecord {
  return Object.freeze({
    ...w,
    capabilities: Object.freeze({
      ...w.capabilities,
      gpus: w.capabilities.gpus.map((g) => Object.freeze({ ...g })),
    }),
    labels: Object.freeze({ ...w.labels }),
  });
}

export class WorkerRegistry {
  private workers = new Map<string, WorkerRecord>();

  register(input: RegistrationInput, now: number = Date.now()): WorkerRecord {
    if (!input || !ID.test(input.workerId ?? "")) throw new Error("invalid workerId");
    if (typeof input.displayName !== "string" || input.displayName.length === 0) {
      throw new Error("invalid displayName");
    }
    if (input.workerClass !== "general" && input.workerClass !== "edge") {
      throw new Error("invalid workerClass");
    }
    if (input.trustTier !== undefined) throw new Error("trustTier is server-assigned");
    const bad = checkCaps(input.capabilities);
    if (bad) throw new Error(`invalid capabilities: ${bad}`);
    const prior = this.workers.get(input.workerId);
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
    this.workers.set(input.workerId, record);
    return frozen(record);
  }

  /** Re-assert with changed caps (e.g. RAM upgrade); trust never changes via this path. */
  reassert(workerId: string, capabilities: WorkerCapabilities, now: number = Date.now()): WorkerRecord {
    const prior = this.workers.get(workerId);
    if (!prior) throw new Error("unknown worker");
    const bad = checkCaps(capabilities);
    if (bad) throw new Error(`invalid capabilities: ${bad}`);
    const next: WorkerRecord = { ...prior, capabilities, lastReassert: now };
    this.workers.set(workerId, next);
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
