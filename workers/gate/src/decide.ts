// decidePush — the gate's decision path. Pure over ArtifactsPort + gate-ts:
// works identically against LocalGitAdapter (now) and CloudflareAdapter
// (after Paid). No node imports here: this file ships in the Worker.
import type {
  ArtifactsPort,
  CommitInfo,
  PushEvent,
  RepoHandle,
} from "@foundry/artifacts-port";
import {
  checkAdmissibility,
  InMemoryLedger,
  Layer,
  newKernelState,
  newProposedCall,
  SnapshotId,
  standardCost,
  type KernelState,
  type ProposedCall,
  type RejectReason,
  type Syscall,
} from "@foundry/gate-ts";

import type { TaskTicket, TicketStore } from "@foundry/stores";
import type { OverlapOracle } from "@foundry/lkg-client";

export type Decision =
  | {
      verdict: "merge";
      ticket: TaskTicket;
      files: Record<string, string>;
      deletedFiles: string[];
    }
  | { verdict: "reject"; reason: RejectReason }
  | { verdict: "conflict"; ticket: TaskTicket; files: string[] };

const MERGE_TOOL = "foundry.merge";

function mergeSyscall(): Syscall {
  return {
    id: MERGE_TOOL,
    layer: Layer.APPLY,
    mutability: "reversible",
    cost: standardCost(),
    maxSnapshotAgeMs: 5 * 60_000,
    validateArgs: (args: unknown) => {
      const rec = args as Record<string, unknown>;
      if (typeof rec?.after !== "string" || !/^[0-9a-f]{40}$/i.test(rec.after)) {
        throw new Error("args.after must be a 40-char hex sha");
      }
    },
  };
}

/** Fresh admission state: frontier at L2 so APPLY is one step up. */
export function admissionState(baseHeadSha: string | null): KernelState {
  const state = newKernelState();
  state.frontier = Layer.STRUCTURE;
  state.current_snapshot = baseHeadSha
    ? SnapshotId.fromShortHex(baseHeadSha)
    : SnapshotId.zero();
  return state;
}

function toProposedCall(
  ticket: TaskTicket,
  push: PushEvent,
  baseHeadSha: string | null,
  baseHistoryLen: number,
): ProposedCall {
  const call = newProposedCall(
    MERGE_TOOL,
    { repo: push.repo, ref: push.ref, after: push.after },
    ticket.scope,
  );
  call.proposal_ref = {
    proposal_hash: SnapshotId.fromShortHex(push.after).toHex(),
    proposal_snapshot: baseHeadSha
      ? SnapshotId.fromShortHex(baseHeadSha)
      : SnapshotId.zero(),
    proposal_seq: baseHistoryLen,
  };
  return call;
}

/** Commits in `hist` (newest-first) strictly after `forkPoint` (exclusive). */
function commitsAfter(hist: CommitInfo[], forkPoint: string): CommitInfo[] {
  const out: CommitInfo[] = [];
  for (const c of hist) {
    if (c.sha === forkPoint) break;
    out.push(c);
  }
  return out;
}

function unionFiles(commits: CommitInfo[]): Set<string> | null {
  const out = new Set<string>();
  for (const c of commits) {
    if (!c.files) return null; // backend doesn't track paths
    for (const f of c.files) out.add(f);
  }
  return out;
}

export async function decidePush(
  port: ArtifactsPort,
  tickets: TicketStore,
  push: PushEvent,
  now: number = Date.now(),
  overlap?: OverlapOracle,
): Promise<Decision> {
  // 0. The fork must belong to a known task.
  const ticket = await tickets.getTicketByFork(push.repo);
  if (!ticket) {
    return {
      verdict: "reject",
      reason: {
        reason: "invalid_args",
        message: `no task ticket for fork ${push.repo}`,
      },
    };
  }

  // Both handles open inside try: a throw on the second get must not leak
  // the first. Disposal is null-safe.
  let fork: RepoHandle | null = null;
  let base: RepoHandle | null = null;
  try {
    fork = await port.get(push.repo);
    base = await port.get(ticket.baseRepo);
    const forkHist = await fork.history("main", 200);
    const baseHist = await base.history("main", 200);
    if (!forkHist.some((c) => c.sha === push.after)) {
      return {
        verdict: "reject",
        reason: {
          reason: "proposal_not_found",
          hash_hex: push.after,
        },
      };
    }

    // 1. Admissibility gate (scope/layer/budget/freshness/proposal).
    const baseHead = baseHist.length > 0 ? baseHist[0].sha : null;
    const state = admissionState(baseHead);
    const ledger = new InMemoryLedger();
    ledger.addProposal(SnapshotId.fromShortHex(push.after).toHex());
    const call = toProposedCall(ticket, push, baseHead, baseHist.length);
    call.proposed_at = now;
    const gate = checkAdmissibility(mergeSyscall(), call, state, ledger, now);
    if (!gate.ok) return { verdict: "reject", reason: gate.reason };

    // 2. Conflict detection: paths changed on both sides of the fork point.
    const forkOnly = commitsAfter(forkHist, ticket.baseSha);
    const baseOnly = commitsAfter(baseHist, ticket.baseSha);
    const forkPaths = unionFiles(forkOnly);
    const basePaths = unionFiles(baseOnly);
    if (forkPaths === null || basePaths === null) {
      // Cannot prove disjointness — route to the resolver (safe default).
      return { verdict: "conflict", ticket, files: ["unknown"] };
    }
    const overlapping = [...forkPaths].filter((p) => basePaths.has(p));
    const realConflicts: string[] = [];
    for (const p of overlapping) {
      const [a, b] = await Promise.all([
        fork.readFile("main", p),
        base.readFile("main", p),
      ]);
      if (a !== b) realConflicts.push(p);
    }
    if (realConflicts.length > 0) {
      return { verdict: "conflict", ticket, files: realConflicts.sort() };
    }

    // 2b. Cross-task overlap via the knowledge graph (best-effort).
    // Step 2 sees one fork vs base; the oracle sees every Foundry task.
    // Runs only when local diff is clean; unknown (null) keeps local-only.
    if (overlap) {
      const known = [...forkHist, ...baseHist].map((c) => c.sha);
      const contenders = await overlap.findContenders({
        baseRepo: ticket.baseRepo,
        taskId: ticket.taskId,
        paths: [...forkPaths].sort(),
        knownCommits: known,
      });
      if (contenders && contenders.length > 0) {
        return { verdict: "conflict", ticket, files: contenders.sort() };
      }
    }

    // 3. Clean: collect fork-side file contents for the merger.
    // Paths absent on the fork side are deletions the merger must apply.
    const files: Record<string, string> = {};
    const deletedFiles: string[] = [];
    for (const p of forkPaths) {
      const content = await fork.readFile("main", p);
      if (content !== null) files[p] = content;
      else deletedFiles.push(p);
    }
    return { verdict: "merge", ticket, files, deletedFiles };
  } finally {
    fork?.dispose();
    base?.dispose();
  }
}
