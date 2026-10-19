// T2: outbound execution agent protocol + legacy Pi collector.
// Workers call out (Cloudflare cannot dial tailnet). The Pi keeps its
// existing :9107 GET; a private collector translates it into census.
import { ComputeAuthority, type AuthorityLease, type SubmittedResult, type VerificationPolicy } from "./authority.js";

export interface CensusReading {
  workerId: string;
  heartbeatSequence: number;
  observedAt: number;
  cpuLoad1m: number;
  ramAvailableMib: number;
  activeLeaseIds: string[];
  blockers: string[];
}

/** Minimal agent: holds at most one live lease, renews, reports, completes. */
export class OutboundAgent {
  private lease: AuthorityLease | null = null;

  constructor(
    private auth: ComputeAuthority,
    readonly workerId: string,
    private incarnation: number,
  ) {}

  /** One active attempt: claiming while holding a live lease is refused. */
  claim(workloadId: string, claimId: string): AuthorityLease | null {
    if (this.lease) return null;
    const lease = this.auth.claim(this.workerId, workloadId, this.incarnation, claimId);
    if (lease) this.lease = lease;
    return lease;
  }

  renew(): boolean {
    if (!this.lease) return false;
    const ok = this.auth.renew(this.lease.leaseId, this.lease.capability);
    if (!ok) this.lease = null;
    return ok;
  }

  /** Trusted adapter calls this only after independently confirming process stop.
   * Incarnation is a fence, not proof of stop or enrollment authentication.
   */
  reconcileAfterStop(incarnation: number): boolean {
    if (!this.auth.reconcileWorker(this.workerId, incarnation)) return false;
    this.incarnation = incarnation;
    this.lease = null;
    return true;
  }

  complete(
    result: SubmittedResult,
    policy?: VerificationPolicy,
  ): { accepted: boolean; reason: string } {
    if (!this.lease) return { accepted: false, reason: "no-lease" };
    const res = this.auth.complete(this.lease.leaseId, this.lease.capability, result, policy);
    if (res.accepted || res.reason === "lease-not-live" || res.reason === "lease-expired" || res.reason === "workload-terminal") this.lease = null;
    return res;
  }
}

/** Translates a Pi :9107/health payload into a CensusReading. Pure. */
export function collectPiCensus(payload: unknown): CensusReading {
  if (!payload || typeof payload !== "object") throw new Error("invalid census payload");
  const p = payload as Record<string, unknown>;
  const host = p.host as Record<string, unknown> | undefined;
  const load = host?.loadavg as number[] | undefined;
  if (typeof p.worker_id !== "string" && typeof host?.hostname !== "string") {
    throw new Error("census missing worker identity");
  }
  const blockers = Array.isArray(p.blockers) ? (p.blockers as string[]) : [];
  const leases = Array.isArray(p.active_lease_ids) ? (p.active_lease_ids as string[]) : [];
  // Unknown upstream fields stay unknown: no fabricated timestamps.
  if (typeof p.observed_at !== "number") throw new Error("census missing observed_at");
  return {
    workerId: (p.worker_id as string) ?? (host?.hostname as string),
    heartbeatSequence: typeof p.heartbeat_sequence === "number" ? p.heartbeat_sequence : 0,
    observedAt: p.observed_at,
    cpuLoad1m: load?.[0] ?? (p.cpu_load_1m as number) ?? -1,
    ramAvailableMib: (p.ram_available_mib as number) ?? -1,
    activeLeaseIds: leases,
    blockers,
  };
}
