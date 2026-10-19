// T4: deterministic placer with replayable explanations.
// Output = reason codes + typed facts + the input snapshot, so any
// placement can be re-derived and audited later — never bare strings.
import { integer, type WorkerRecord } from "./registry.js";
import { matchWorker, validWorkload, type WorkloadSpec } from "./matching.js";

export interface Rejection {
  workerId: string;
  code: string;
  detail: string;
}

/** Non-secret evidence supplied by the caller, never synthesized from load.
 * These are caller-observed live reservations, not authenticated leases.
 * They are audit context only; reservation enforcement belongs to the authority.
 */
export interface LiveReservationEvidence {
  reservationId: string;
  workerId: string;
  slots: number;
  expiresAt: number;
  workloadId?: string;
  generation?: number;
  incarnation?: number;
}

export interface PlacementEvidence {
  policyVersion: string;
  reservations: LiveReservationEvidence[];
}

export const PLACER_POLICY_VERSION = "max-ram-headroom-v2";
const compareId = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

export interface Placement {
  placementId: string;
  workloadId: string;
  workerId: string | null;
  reasonCodes: string[];
  facts: Record<string, string | number>;
  rejected: Rejection[];
  /**
   * Canonical input snapshot: frozen deep copy of the workload plus each
   * candidate's class, capabilities and RAM load. The placer version identifies
   * the local algorithm; policyVersion identifies the caller's policy when given.
   * Omitted reservations mean unknown evidence, never an invented empty lease set.
   */
  inputSnapshot: {
    workload: WorkloadSpec;
    workers: { id: string; workerClass: WorkerRecord["workerClass"]; capabilities: unknown; load: number }[];
    policyVersion: string;
    placerPolicyVersion: string;
    reservations?: LiveReservationEvidence[];
  };
}

let seq = 0;

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

export function place(
  workers: WorkerRecord[],
  spec: WorkloadSpec,
  loadByWorker: Record<string, number> = {},
  evidence?: PlacementEvidence,
): Placement {
  if (!Array.isArray(workers) || [...workers].some((w) => !w || typeof w.workerId !== "string") ||
    new Set(workers.map((w) => w.workerId)).size !== workers.length) throw new Error("invalid workers");
  if (!validWorkload(spec)) throw new Error("invalid workload requirements");
  if (!loadByWorker || typeof loadByWorker !== "object" || Array.isArray(loadByWorker)) throw new Error("invalid worker loads");
  if (evidence !== undefined && (!evidence || typeof evidence.policyVersion !== "string" || !evidence.policyVersion ||
    !Array.isArray(evidence.reservations) || [...evidence.reservations].some((r) => !r ||
      typeof r.reservationId !== "string" || !r.reservationId || typeof r.workerId !== "string" || !r.workerId ||
      !integer(r.slots, 1) || !integer(r.expiresAt, 0) ||
      (r.workloadId !== undefined && (typeof r.workloadId !== "string" || !r.workloadId)) ||
      (r.generation !== undefined && !integer(r.generation, 0)) ||
      (r.incarnation !== undefined && !integer(r.incarnation, 0))) ||
    new Set(evidence.reservations.map((r) => r.reservationId)).size !== evidence.reservations.length)) {
    throw new Error("invalid placement evidence");
  }
  const loadFor = (id: string): number => Object.hasOwn(loadByWorker, id) ? loadByWorker[id] : 0;
  const rejected: Rejection[] = [];
  const candidates: { w: WorkerRecord; headroom: number }[] = [];
  for (const w of [...workers].sort((a, b) => compareId(a.workerId, b.workerId))) {
    const verdict = matchWorker(w, spec);
    if (!verdict.ok) {
      rejected.push({ workerId: w.workerId, code: "incompatible", detail: verdict.reasons.join("; ") });
      continue;
    }
    const load = loadFor(w.workerId);
    if (!integer(load, 0)) {
      rejected.push({ workerId: w.workerId, code: "invalid-load", detail: "load must be a nonnegative safe integer MiB" });
      continue;
    }
    const headroom = w.capabilities.reservableMib - load;
    if (headroom < (spec.requires.minRamMib ?? 0)) {
      rejected.push({ workerId: w.workerId, code: "insufficient-headroom", detail: `${headroom}MiB available` });
      continue;
    }
    candidates.push({ w, headroom });
  }
  const snapshotWorkers = [...workers]
    .sort((a, b) => compareId(a.workerId, b.workerId))
    .map((w) => ({
      id: w.workerId,
      workerClass: w.workerClass,
      capabilities: structuredClone(w.capabilities) as unknown,
      load: loadFor(w.workerId),
    }));
  const base = {
    placementId: `place-${Date.now().toString(36)}-${seq++}`,
    workloadId: spec.workloadId,
    rejected,
    inputSnapshot: {
      workload: structuredClone(spec),
      workers: snapshotWorkers,
      policyVersion: evidence?.policyVersion ?? PLACER_POLICY_VERSION,
      placerPolicyVersion: PLACER_POLICY_VERSION,
      ...(evidence === undefined ? {} : { reservations: evidence.reservations.map((r) => ({
        reservationId: r.reservationId, workerId: r.workerId, slots: r.slots, expiresAt: r.expiresAt,
        ...(r.workloadId === undefined ? {} : { workloadId: r.workloadId }),
        ...(r.generation === undefined ? {} : { generation: r.generation }),
        ...(r.incarnation === undefined ? {} : { incarnation: r.incarnation }),
      })).sort((a, b) => compareId(a.reservationId, b.reservationId)) }),
    },
  };
  if (candidates.length === 0) {
    return deepFreeze({ ...base, workerId: null, reasonCodes: ["no-compatible-worker"], facts: {} });
  }
  // Deterministic: most headroom wins; workerId breaks ties.
  candidates.sort((a, b) => b.headroom - a.headroom || compareId(a.w.workerId, b.w.workerId));
  const winner = candidates[0].w;
  return deepFreeze({
    ...base,
    workerId: winner.workerId,
    reasonCodes: ["compatible", "max-headroom"],
    facts: {
      workerId: winner.workerId,
      arch: winner.capabilities.arch,
      reservableMib: winner.capabilities.reservableMib,
      headroomMib: candidates[0].headroom,
      candidates: candidates.length,
    },
  });
}
