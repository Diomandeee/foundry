/** Structurally identical to the compute durable port; trusted host only. */
export type SqlValue = string | number | null | ArrayBuffer;
export interface TransactionPort {
  sql: { exec(query: string, ...bindings: SqlValue[]): Iterable<Record<string, unknown>> };
  transactionSync<T>(callback: () => T): T;
}
export interface OwnerContext { role: 'owner'; principal: string }
export interface Device { id: string; kind: 'cuda' | 'metal'; vramMib: number }
export interface ApprovedIdentity {
  workerId: string; principal: string; workerClass: 'general' | 'edge';
  cpu: number; ramMib: number; devices: Device[];
}
export interface ExecutorBinding {
  role: 'executor'; workerId: string; principal: string; revision: number; incarnation: number;
}
export interface EnrollRequest extends ApprovedIdentity {
  key: string; tokenSha256: string; expiresAt: number; expectedRevision: number; incarnation: number;
}
export interface RevokeRequest { key: string; workerId: string; revision: number }
export interface HeartbeatRequest { key: string; sequence: number; observedIdentity: ApprovedIdentity }
export interface EnrollmentStatus extends ExecutorBinding {
  identity: ApprovedIdentity; expiresAt: number; revokedAt: number | null;
  lastSeen: number | null; sequence: number; freshness: 'never-seen' | 'fresh' | 'stale' | 'inactive';
}
export interface MutationResult { status: EnrollmentStatus; applied: boolean; replayed: boolean; isCurrent: boolean }
export interface Options {
  environment: string; authorityId: string; now?: () => number;
  /** Default 60 seconds; fixed on database creation; range 1..300000. */
  heartbeatFreshnessMs?: number;
  /** Default min(1000, freshness window), persisted per-worker admission interval. */
  heartbeatMinIntervalMs?: number;
  /** Lifetime retained capacities; defaults 128 workers, 4096 credentials, 65536 events. */
  maxWorkers?: number; maxCredentials?: number; maxEvents?: number;
}
export class EnrollmentError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'EnrollmentError'; }
}
