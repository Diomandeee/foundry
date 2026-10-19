// T7: dashboard read model. API-mediated only: this snapshot is built
// server-side from authority state. The browser never sees DB handles.
// Includes a freshness watermark so stale reads are visible.
import type { WorkerRegistry } from "./registry.js";
import type { ComputeAuthority } from "./authority.js";
import type { AuditLog } from "./verifier.js";

export interface DashboardSnapshot {
  watermark: { at: number; pendingOutbox: number };
  workers: Array<{
    workerId: string;
    workerClass: string;
    trustTier: string;
    arch: string;
    reservableMib: number;
    incarnation: number | null;
    quarantined: boolean | null;
    reconciliation: "required" | "clear" | "unknown";
  }>;
  liveLeases: Array<{
    leaseId: string;
    workerId: string;
    workloadId: string;
    generation: number;
    expiresAt: number;
  }>;
  recentEvents: Array<{ seq: number; kind: string; detail: string }>;
}

export function buildSnapshot(
  registry: WorkerRegistry,
  audit: AuditLog,
  at: number = Date.now(),
  eventLimit = 50,
): DashboardSnapshot {
  return {
    watermark: { at, pendingOutbox: audit.pendingOutbox },
    liveLeases: [],
    workers: registry.list().map((w) => ({
      workerId: w.workerId,
      workerClass: w.workerClass,
      trustTier: w.trustTier,
      arch: w.capabilities.arch,
      reservableMib: w.capabilities.reservableMib,
      incarnation: null, quarantined: null, reconciliation: "unknown",
    })),
    recentEvents: audit.all().slice(-eventLimit),
  };
}

export function snapshotFor(
  auth: ComputeAuthority,
  registry: WorkerRegistry,
  audit: AuditLog = auth.audit,
): DashboardSnapshot {
  if (audit !== auth.audit) throw new Error("snapshot requires authority audit");
  const leases = auth.listLiveLeases(); // expiry mutates state and audit together
  const snap = buildSnapshot(registry, audit);
  for (const worker of auth.listWorkers()) {
    const state = {incarnation:worker.incarnation, quarantined:worker.quarantined,
      reconciliation:worker.quarantined ? "required" as const : "clear" as const};
    const row = snap.workers.find(w=>w.workerId===worker.id);
    if(row)Object.assign(row,state,{workerClass:worker.workerClass});
    else snap.workers.push({workerId:worker.id,workerClass:worker.workerClass,trustTier:"unknown",
      arch:"unknown",reservableMib:worker.resources.ramMib,...state});
  }
  snap.liveLeases = leases.map((l) => ({
    leaseId: l.leaseId,
    workerId: l.workerId,
    workloadId: l.workloadId,
    generation: l.generation,
    expiresAt: l.expiresAt,
  }));
  return snap;
}
