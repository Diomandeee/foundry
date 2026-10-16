// T4: deterministic placer with replayable explanations.
// Output = reason codes + typed facts + the input snapshot, so any
// placement can be re-derived and audited later — never bare strings.
import type { WorkerRecord } from "./registry.js";
import { matchWorker, type WorkloadSpec } from "./matching.js";

export interface Rejection {
  workerId: string;
  code: string;
  detail: string;
}

export interface Placement {
  placementId: string;
  workloadId: string;
  workerId: string | null;
  reasonCodes: string[];
  facts: Record<string, string | number>;
  rejected: Rejection[];
  /**
   * Canonical input snapshot: frozen deep copy of the workload plus each
   * candidate's capabilities, so the decision replays deterministically.
   */
  inputSnapshot: { workload: WorkloadSpec; workers: { id: string; capabilities: unknown; load: number }[] };
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
): Placement {
  const rejected: Rejection[] = [];
  const candidates: { w: WorkerRecord; headroom: number }[] = [];
  for (const w of [...workers].sort((a, b) => a.workerId.localeCompare(b.workerId))) {
    const verdict = matchWorker(w, spec);
    if (!verdict.ok) {
      rejected.push({ workerId: w.workerId, code: "incompatible", detail: verdict.reasons.join("; ") });
      continue;
    }
    candidates.push({
      w,
      headroom: w.capabilities.reservableMib - (loadByWorker[w.workerId] ?? 0),
    });
  }
  const snapshotWorkers = [...workers]
    .sort((a, b) => a.workerId.localeCompare(b.workerId))
    .map((w) => ({
      id: w.workerId,
      capabilities: JSON.parse(JSON.stringify(w.capabilities)) as unknown,
      load: loadByWorker[w.workerId] ?? 0,
    }));
  const base = {
    placementId: `place-${Date.now().toString(36)}-${seq++}`,
    workloadId: spec.workloadId,
    rejected,
    inputSnapshot: {
      workload: JSON.parse(JSON.stringify(spec)) as WorkloadSpec,
      workers: snapshotWorkers,
    },
  };
  if (candidates.length === 0) {
    return deepFreeze({ ...base, workerId: null, reasonCodes: ["no-compatible-worker"], facts: {} });
  }
  // Deterministic: most headroom wins; workerId breaks ties.
  candidates.sort((a, b) => b.headroom - a.headroom || a.w.workerId.localeCompare(b.w.workerId));
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
