// Compute authority: single serial mutation point for reservations,
// attempts, leases, placements, and results. Every public method runs to
// completion without interleaving; a Durable Object (or D1 with an atomic
// multi-entity protocol) must provide the same serializability remotely.
// This in-memory implementation is the protocol reference, not storage:
// restart loses state (see outbox/SQLite follow-up in the plan).
import { randomUUID } from "node:crypto";

/** Local verification core (mirrors verifier.verifyResult; kept here so
 *  commit cannot bypass it — the only path to "committed" runs this). */
function checkResult(
  result: SubmittedResult,
  policy: VerificationPolicy,
): { verified: boolean; reason: string } {
  if (result.outcome !== "exited") return { verified: false, reason: `exec-${result.outcome}` };
  if (policy.exitCode === undefined && policy.stdoutSha256 === undefined && policy.minBytes === undefined) {
    return { verified: false, reason: "no-policy" };
  }
  if (policy.exitCode !== undefined && result.exitCode !== policy.exitCode) {
    return { verified: false, reason: `exit ${result.exitCode} != ${policy.exitCode}` };
  }
  if (policy.stdoutSha256 !== undefined && result.stdoutSha256 !== policy.stdoutSha256) {
    return { verified: false, reason: "sha-mismatch" };
  }
  if (policy.minBytes !== undefined && result.stdoutBytes < policy.minBytes) {
    return { verified: false, reason: "too-few-bytes" };
  }
  return { verified: true, reason: "independent-check-passed" };
}

export interface AuthorityWorker {
  id: string;
  workerClass: "general" | "edge";
  slots: number;
  incarnation: number;
  /** Fenced workers stay quarantined until an authenticated reconcile. */
  quarantined: boolean;
}

export type WorkloadStatus = "open" | "committed" | "failed" | "cancelled";

export interface AuthorityWorkload {
  id: string;
  generation: number;
  slotsNeeded: number;
  status: WorkloadStatus;
  winnerLeaseId: string | null;
  replayPolicy: "retry-new-attempt" | "fail";
  maxAttempts: number;
  attemptsUsed: number;
}

export interface AuthorityLease {
  leaseId: string;
  workerId: string;
  workloadId: string;
  generation: number;
  incarnation: number;
  capability: string;
  claimScope: string;
  slots: number;
  issuedAt: number;
  expiresAt: number;
  /** Sliding window per renew, capped by maxLifetimeMs. */
  ttlMs: number;
  maxLifetimeMs: number;
  live: boolean;
}

export interface CompletionReceipt {
  verified: boolean;
  reason: string;
}

export interface SubmittedResult {
  outcome: string;
  exitCode: number | null;
  stdoutSha256: string;
  stdoutBytes: number;
}

export interface VerificationPolicy {
  kind: string;
  exitCode?: number;
  stdoutSha256?: string;
  minBytes?: number;
}

export interface AuthorityResult {
  accepted: boolean;
  reason: string;
}

const freeze = <T extends object>(o: T): T => Object.freeze({ ...o });

export class ComputeAuthority {
  private workers = new Map<string, AuthorityWorker>();
  private workloads = new Map<string, AuthorityWorkload>();
  private leases = new Map<string, AuthorityLease>();
  private liveByWorkload = new Map<string, string>();
  readonly events: string[] = [];

  constructor(
    private now: () => number = Date.now,
    private maxLifetimeMs = 3_600_000,
  ) {}

  registerWorker(
    id: string,
    slots: number,
    workerClass: "general" | "edge" = "general",
  ): AuthorityWorker {
    const prior = this.workers.get(id);
    const w: AuthorityWorker = {
      id,
      workerClass,
      // Edge class can never hold execution slots, regardless of ask.
      slots: workerClass === "edge" ? 0 : slots,
      // Re-registration preserves incarnation: no silent reset.
      incarnation: prior?.incarnation ?? 0,
      quarantined: prior?.quarantined ?? false,
    };
    this.workers.set(id, w);
    this.events.push(`worker-registered ${id} class=${w.workerClass} slots=${w.slots}`);
    return freeze(w);
  }

  submitWorkload(
    id: string,
    slotsNeeded: number,
    replayPolicy: AuthorityWorkload["replayPolicy"] = "retry-new-attempt",
    maxAttempts = 3,
  ): AuthorityWorkload {
    const w: AuthorityWorkload = {
      id, generation: 0, slotsNeeded, status: "open",
      winnerLeaseId: null, replayPolicy, maxAttempts, attemptsUsed: 0,
    };
    this.workloads.set(id, w);
    this.events.push(`workload-submitted ${id}`);
    return freeze(w);
  }

  private usedSlots(workerId: string): number {
    let used = 0;
    for (const l of this.leases.values()) {
      if (l.live && l.workerId === workerId) used += l.slots;
    }
    return used;
  }

  claim(
    workerId: string,
    workloadId: string,
    incarnation: number,
    claimScope: string,
    ttlMs = 60_000,
  ): AuthorityLease | null {
    const worker = this.workers.get(workerId);
    const workload = this.workloads.get(workloadId);
    if (!worker || !workload) return null;
    if (worker.quarantined) return null;
    if (incarnation !== worker.incarnation) return null;
    if (workload.status !== "open") return null; // terminal: never re-claim
    const key = `${workloadId}#${workload.generation}`;
    const existingId = this.liveByWorkload.get(key);
    if (existingId) {
      const existing = this.leases.get(existingId);
      // Idempotent replay only for the same principal + scope.
      if (existing && existing.workerId === workerId && existing.claimScope === claimScope) {
        return freeze(existing);
      }
      return null;
    }
    if (workload.attemptsUsed >= workload.maxAttempts) return null;
    if (this.usedSlots(workerId) + workload.slotsNeeded > worker.slots) return null;
    const t = this.now();
    const lease: AuthorityLease = {
      leaseId: `lease-${randomUUID()}`,
      workerId,
      workloadId,
      generation: workload.generation,
      incarnation: worker.incarnation,
      capability: randomUUID(),
      claimScope,
      slots: workload.slotsNeeded,
      issuedAt: t,
      expiresAt: t + ttlMs,
      ttlMs,
      maxLifetimeMs: this.maxLifetimeMs,
      live: true,
    };
    this.leases.set(lease.leaseId, lease);
    this.liveByWorkload.set(key, lease.leaseId);
    workload.attemptsUsed++;
    this.events.push(`lease-issued ${lease.leaseId} ${workerId} ${workloadId} gen=${workload.generation}`);
    return freeze(lease);
  }

  /**
   * Heartbeat renew with a sliding window: success extends expiresAt by
   * one TTL, capped at issuedAt + maxLifetimeMs. Jobs that stop renewing
   * die at expiry; jobs that outlive the cap are refused, not extended.
   */
  renew(leaseId: string, capability: string): boolean {
    const lease = this.leases.get(leaseId);
    if (!lease || !lease.live || lease.capability !== capability) return false;
    const workload = this.workloads.get(lease.workloadId);
    const worker = this.workers.get(lease.workerId);
    if (!workload || !worker || worker.quarantined) return false;
    if (this.now() > lease.expiresAt) {
      lease.live = false;
      return false;
    }
    if (lease.generation !== workload.generation || lease.incarnation !== worker.incarnation) {
      return false;
    }
    lease.expiresAt = Math.min(this.now() + lease.ttlMs, lease.issuedAt + lease.maxLifetimeMs);
    return true;
  }

  /** Live leases for observability (frozen copies). */
  listLiveLeases(): AuthorityLease[] {
    return [...this.leases.values()].filter((l) => l.live).map((l) => freeze(l));
  }

  /** Fence: kill leases AND quarantine capacity until reconciled. */
  fenceWorker(workerId: string): void {
    const worker = this.workers.get(workerId);
    if (!worker) return;
    worker.incarnation++;
    worker.quarantined = true;
    for (const lease of this.leases.values()) {
      if (lease.workerId === workerId && lease.live) lease.live = false;
    }
    this.events.push(`worker-fenced ${workerId} incarnation=${worker.incarnation} quarantined`);
  }

  /** Authenticated stop/reboot reconciliation lifts the quarantine. */
  reconcileWorker(workerId: string, incarnation: number): boolean {
    const worker = this.workers.get(workerId);
    if (!worker || incarnation !== worker.incarnation) return false;
    worker.quarantined = false;
    this.events.push(`worker-reconciled ${workerId}`);
    return true;
  }

  requeue(workloadId: string): boolean {
    const workload = this.workloads.get(workloadId);
    if (!workload || workload.status !== "open") return false;
    if (workload.replayPolicy !== "retry-new-attempt") return false;
    // End the old generation's live lease first: never two live generations.
    const oldKey = `${workloadId}#${workload.generation}`;
    const oldId = this.liveByWorkload.get(oldKey);
    if (oldId) {
      const old = this.leases.get(oldId);
      if (old) old.live = false;
      this.liveByWorkload.delete(oldKey);
    }
    workload.generation++;
    this.events.push(`workload-requeued ${workloadId} gen=${workload.generation}`);
    return true;
  }

  cancel(workloadId: string): boolean {
    const workload = this.workloads.get(workloadId);
    if (!workload || workload.status !== "open") return false;
    workload.status = "cancelled";
    const key = `${workloadId}#${workload.generation}`;
    const liveId = this.liveByWorkload.get(key);
    if (liveId) {
      const live = this.leases.get(liveId);
      if (live) live.live = false;
      this.liveByWorkload.delete(key);
    }
    this.events.push(`workload-cancelled ${workloadId}`);
    return true;
  }

  /**
   * Commit runs the verifier itself: the caller submits the executed
   * result plus the workload's policy, and only a passing independent
   * check commits. Skipping verification is not expressible.
   */
  complete(
    leaseId: string,
    capability: string,
    result: SubmittedResult,
    policy: VerificationPolicy,
  ): AuthorityResult {
    const lease = this.leases.get(leaseId);
    if (!lease) return { accepted: false, reason: "unknown-lease" };
    const check = checkResult(result, policy);
    if (!check.verified) return { accepted: false, reason: `unverified:${check.reason}` };
    const workload = this.workloads.get(lease.workloadId);
    const worker = this.workers.get(lease.workerId);
    if (!workload || !worker) return { accepted: false, reason: "unknown-refs" };
    if (workload.status !== "open") return { accepted: false, reason: "workload-terminal" };
    if (!lease.live) return { accepted: false, reason: "lease-not-live" };
    if (lease.capability !== capability) return { accepted: false, reason: "bad-capability" };
    if (this.now() > lease.expiresAt) {
      lease.live = false;
      return { accepted: false, reason: "lease-expired" };
    }
    if (lease.generation !== workload.generation) {
      return { accepted: false, reason: "stale-generation" };
    }
    if (lease.incarnation !== worker.incarnation || worker.quarantined) {
      return { accepted: false, reason: "stale-incarnation" };
    }
    lease.live = false;
    workload.status = "committed";
    workload.winnerLeaseId = lease.leaseId;
    this.liveByWorkload.delete(`${lease.workloadId}#${lease.generation}`);
    this.events.push(`result-committed ${leaseId} gen=${lease.generation}`);
    return { accepted: true, reason: "committed" };
  }
}
