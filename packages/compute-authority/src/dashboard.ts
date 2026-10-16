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
    })),
    recentEvents: audit.all().slice(-eventLimit),
  };
}

export function snapshotFor(
  auth: ComputeAuthority,
  registry: WorkerRegistry,
  audit: AuditLog,
): DashboardSnapshot {
  const snap = buildSnapshot(registry, audit);
  snap.liveLeases = auth.listLiveLeases().map((l) => ({
    leaseId: l.leaseId,
    workerId: l.workerId,
    workloadId: l.workloadId,
    generation: l.generation,
    expiresAt: l.expiresAt,
  }));
  return snap;
}
