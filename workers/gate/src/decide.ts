// decidePush — the gate's decision path. Pure over ArtifactsPort + gate-ts:
// works identically against LocalGitAdapter (now) and CloudflareAdapter
// (after Paid). No node imports here: this file ships in the Worker.
import {
  UnsupportedContentError,
  type ArtifactsPort,
  type CommitInfo,
  type PushEvent,
  type RepoHandle,
} from "@foundry/artifacts-port";
import {
  allowsPath,
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
import { usable, type PlanCheck, type PlanVerdict } from "@foundry/plan-check";

export interface PlanCheckOpts {
  check: PlanCheck;
  /** When true, a checked negative verdict rejects. Default: advisory only. */
  enforce?: boolean;
}

export type Decision =
  | {
      verdict: "merge";
      ticket: TaskTicket;
      files: Record<string, string>;
      deletedFiles: string[];
      /** Base head this decision was made against (null = empty base). */
      baseHead: string | null;
      /** Exact base branch the admitted decision is destined for. */
      baseBranch: string;
      planAdvisory?: PlanVerdict;
    }
  | { verdict: "reject"; reason: RejectReason }
  | {
      verdict: "conflict";
      ticket: TaskTicket;
      files: string[];
      planAdvisory?: PlanVerdict;
    };

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

/** History caps: a fork point past the cap used to false-conflict. */
const HIST_FIRST = 200;
const HIST_DEEP = 2000;

/**
 * Newest-first history guaranteed to include `forkPoint` when it exists
 * within the deep cap. Returns the history plus whether the fork point
 * was found (empty forkPoint = genesis: everything is fork-side).
 */
async function historyBackTo(
  handle: RepoHandle,
  branch: string,
  forkPoint: string,
): Promise<{ hist: CommitInfo[]; found: boolean }> {
  if (forkPoint === "") {
    return { hist: await handle.history(branch, HIST_FIRST), found: true };
  }
  let hist = await handle.history(branch, HIST_FIRST);
  if (hist.some((c) => c.sha === forkPoint)) return { hist, found: true };
  if (hist.length < HIST_FIRST) return { hist, found: false };
  hist = await handle.history(branch, HIST_DEEP);
  return { hist, found: hist.some((c) => c.sha === forkPoint) };
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

/** The first path the proposal leaves as a symlink or submodule, judged by the newest fork-side commit that
 * touches each path (first-parent diffs, newest first, so that commit decides what the path is at the head). */
function firstUnsupported(commits: CommitInfo[]): { path: string; why: string } | null {
  const seen = new Set<string>();
  for (const c of commits) {
    for (const f of c.files ?? []) {
      if (seen.has(f)) continue;
      seen.add(f);
      const kind = c.unsupported?.[f];
      if (kind) return { path: f, why: kind.startsWith("mode ") ? `has ${kind}` : `is a ${kind}` };
    }
  }
  return null;
}

/** A proposal the text transport cannot carry is refused, not retried: the same push fails the same way
 * every time. Until 2026-11-03 these surfaced as `infra_failure` and the queue retried them until it
 * dropped the push (gate parity P15, P16). */
function unsupportedReject(u: { path: string; why: string }): Decision {
  return {
    verdict: "reject",
    reason: {
      reason: "invalid_args",
      message: `unsupported content: ${u.path} ${u.why}; the gate lands regular and executable UTF-8 text files up to 8 MiB`,
    },
  };
}

export async function decidePush(
  port: ArtifactsPort,
  tickets: TicketStore,
  push: PushEvent,
  now: number = Date.now(),
  overlap?: OverlapOracle,
  planCheck?: PlanCheckOpts,
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
    // The base's own default branch, not an assumed "main".
    const branch=(await base.info()).defaultBranch;
    if(!branch)throw new Error('base branch metadata unavailable');
    // Anchor every fork-side read to the event SHA. Reading the mutable pushed
    // branch allowed a later commit to supply the paths/content admitted under
    // an earlier `push.after` value.
    const forkBack = await historyBackTo(fork, push.after, ticket.baseSha);
    const forkHist = forkBack.hist;
    let baseHist: CommitInfo[];
    try {
      const baseBack = await historyBackTo(base, branch, ticket.baseSha);
      baseHist = baseBack.hist;
      if (ticket.baseSha !== "" && !baseBack.found) {
        return {
          verdict: "reject",
          reason: {
            reason: "invalid_args",
            message: `fork point ${ticket.baseSha.slice(0, 8)} not in base history (base moved on; rebase the fork)`,
          },
        };
      }
    } catch (e) {
      throw e; // Absence is represented by the port, never inferred from text.
    }
    // An unknown proposal SHA is reported as such, before any fork-point claim:
    // reading history from an absent commit yields an empty list, which must not
    // be misreported as a missing fork point.
    if (!forkHist.some((c) => c.sha === push.after)) {
      return {
        verdict: "reject",
        reason: {
          reason: "proposal_not_found",
          hash_hex: push.after,
        },
      };
    }
    if (ticket.baseSha !== "" && !forkBack.found) {
      return {
        verdict: "reject",
        reason: {
          reason: "invalid_args",
          message: `fork point ${ticket.baseSha.slice(0, 8)} not in fork history (too old or unknown)`,
        },
      };
    }
    // The named fork ref must actually resolve to the proposed SHA. Without this
    // a push event could name a branch the fork does not have and still be
    // admitted on the strength of the SHA alone.
    if (/^refs\/heads\//.test(push.ref)) {
      const pushedBranch = push.ref.slice("refs/heads/".length);
      let refHead: string | null = null;
      try {
        refHead = (await fork.history(pushedBranch, 1))[0]?.sha ?? null;
      } catch {
        refHead = null;
      }
      if (refHead !== push.after) {
        return {
          verdict: "reject",
          reason: {
            reason: "invalid_args",
            // Usually a newer push moved the branch; that push is its own event and is decided on its own.
            message: refHead
              ? `${push.ref} moved past ${push.after.slice(0, 8)} (now ${refHead.slice(0, 8)}); the newer push is decided on its own`
              : `${push.ref} does not exist on the fork`,
          },
        };
      }
    }

    // 1. Admissibility gate (scope/layer/budget/freshness/proposal).
    const baseHead = baseHist.length > 0 ? baseHist[0].sha : null;
    const state = admissionState(baseHead);
    const ledger = new InMemoryLedger();
    ledger.addProposal(SnapshotId.fromShortHex(push.after).toHex());
    const call = toProposedCall(ticket, push, baseHead, baseHist.length);
    // Freshness is measured from the proposal's own commit time, not the
    // decision time: a push that sat in a queue ages out for real.
    const headCommit = forkHist.find((c) => c.sha === push.after);
    const proposedAt = headCommit ? Date.parse(headCommit.date) : NaN;
    call.proposed_at = Number.isNaN(proposedAt) ? now : proposedAt;
    const gate = checkAdmissibility(mergeSyscall(), call, state, ledger, now);
    if (!gate.ok) return { verdict: "reject", reason: gate.reason };

    // 1b. PACT chain check over the ticket's declared chains. Advisory by
    // default; only a checked negative verdict can reject, and only when
    // enforced. Outages fail open (checked=false, ok=true).
    let planAdvisory: PlanVerdict | undefined;
    const chains = ticket.chains ?? [];
    if (planCheck && chains.length > 0) {
      planAdvisory = await planCheck.check.check(chains);
      if (planCheck.enforce && planAdvisory.checked && !planAdvisory.ok) {
        const bad = planAdvisory.results.filter((r) => !usable(r)).map((r) => r.name);
        return {
          verdict: "reject",
          reason: {
            reason: "invalid_args",
            message: `pact: unusable chains: ${bad.join(", ") || chains.join(", ")}`,
          },
        };
      }
    }

    // 2. Conflict detection: paths changed on both sides of the fork point.
    const forkOnly = commitsAfter(forkHist, ticket.baseSha);
    const baseOnly = commitsAfter(baseHist, ticket.baseSha);
    const forkPaths = unionFiles(forkOnly);
    const basePaths = unionFiles(baseOnly);
    if (forkPaths === null || basePaths === null) {
      // Cannot prove disjointness — route to the resolver (safe default).
      return { verdict: "conflict", ticket, files: ["unknown"], planAdvisory };
    }
    if (forkPaths.size === 0) {
      return {
        verdict: "reject",
        reason: {
          reason: "invalid_args",
          message: `empty diff: push ${push.after.slice(0, 8)} changes no files vs fork point`,
        },
      };
    }
    // Scope path allowlist, enforced on the real diff (kernel rule 10
    // cannot run before the diff exists).
    const badPath = [...forkPaths].find((p) => !allowsPath(ticket.scope, p));
    if (badPath !== undefined) {
      return {
        verdict: "reject",
        reason: { reason: "path_not_allowed", path: badPath },
      };
    }
    // The port's tree diff already gives up past 5,000 paths (unknown files, a conflict above). A lower
    // cap here sent a 2,100-file import to the resolver that the deployed gate merges (gate parity P19).
    if(forkPaths.size>5000||[...forkPaths].some(p=>p.length>1024))return {verdict:'conflict',ticket,files:['admission-path-budget'],planAdvisory};
    const link = firstUnsupported(forkOnly);
    if (link) return unsupportedReject(link);
    const overlapping = [...forkPaths].filter((p) => basePaths.has(p));
    const realConflicts: string[] = [];
    try {
      for (const p of overlapping) {
        if (baseHead === null) continue;
        const a = await fork.readFile(push.after, p);
        const b = await base.readFile(baseHead, p);
        if (a !== b) realConflicts.push(p);
      }
    } catch (e) {
      if (e instanceof UnsupportedContentError) return unsupportedReject(e);
      throw e;
    }
    if (realConflicts.length > 0) {
      return {
        verdict: "conflict",
        ticket,
        files: realConflicts.sort(),
        planAdvisory,
      };
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
        return {
          verdict: "conflict",
          ticket,
          files: contenders.sort(),
          planAdvisory,
        };
      }
    }

    // 3. Clean: collect fork-side file contents for the merger.
    // Paths absent on the fork side are deletions the merger must apply.
    const files: Record<string, string> = Object.create(null);
    const deletedFiles: string[] = [];
    try {
      for (const p of forkPaths) {
        const content = await fork.readFile(push.after, p);
        // No total-size cap: the port refuses a file over 8 MiB, and a cap thrown here was an error the queue
        // retried until it dropped the push, where the deployed gate merges it (gate parity P20).
        if (content !== null) files[p] = content;
        else deletedFiles.push(p);
      }
    } catch (e) {
      if (e instanceof UnsupportedContentError) return unsupportedReject(e);
      throw e;
    }
    return {
      verdict: "merge",
      ticket,
      files,
      deletedFiles,
      baseHead,
      baseBranch: branch,
      planAdvisory,
    };
  } finally {
    fork?.dispose();
    base?.dispose();
  }
}
