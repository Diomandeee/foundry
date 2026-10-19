// Central enforcement point — port of Rust check_admissibility.
// Rule order mirrors the original exactly (1–12).

import type { GateVerdict } from "./reject.js";
import {
  allowsLayer,
  allowsPath,
  allowsTool,
  isReadOnly,
  isScopeValid,
  requiresMutationPermission,
  SnapshotId,
  type KernelState,
  type Ledger,
  type ProposedCall,
  type Syscall,
} from "./types.js";
import { Layer } from "./types.js";

export function checkAdmissibility(
  syscall: Syscall,
  call: ProposedCall,
  state: KernelState,
  ledger: Ledger,
  now: number = Date.now(),
): GateVerdict {
  // 1. Scope validity
  if (!isScopeValid(call.scope, now)) {
    return {
      ok: false,
      reason: {
        reason: "scope_expired",
        expired_at: new Date(call.scope.expires_at).toISOString(),
      },
    };
  }

  // 2. Tool allowed in scope
  if (!allowsTool(call.scope, call.tool_id)) {
    return {
      ok: false,
      reason: { reason: "tool_not_allowed", tool_id: call.tool_id },
    };
  }

  // 3. Layer within scope
  const requested = syscall.layer;
  if (!allowsLayer(call.scope, requested)) {
    return {
      ok: false,
      reason: {
        reason: "layer_violation",
        frontier: state.frontier.toString(),
        requested: requested.toString(),
        max_allowed: call.scope.allowed_layers.max.toString(),
      },
    };
  }

  // 4. Layer rule: frontier or frontier+1
  if (!state.frontier.canTransitionTo(requested)) {
    return {
      ok: false,
      reason: {
        reason: "layer_violation",
        frontier: state.frontier.toString(),
        requested: requested.toString(),
        max_allowed: call.scope.allowed_layers.max.toString(),
      },
    };
  }

  // 5. Time gate for layer transition
  if (requested.value > state.frontier.value) {
    if (!state.time_gates.isAccessible(requested, now)) {
      const earliest = state.time_gates.getGate(requested) ?? now;
      return {
        ok: false,
        reason: {
          reason: "time_gate_violation",
          requested: requested.toString(),
          earliest: new Date(earliest).toISOString(),
          now: new Date(now).toISOString(),
        },
      };
    }
  }

  // 6. Budget check
  const needed = syscall.cost.worst_case_units;
  if (needed > state.budget.remaining_units) {
    return {
      ok: false,
      reason: {
        reason: "budget_exceeded",
        needed,
        remaining: state.budget.remaining_units,
      },
    };
  }

  // 7. Monotone step check (no loops)
  if (state.monotone_step >= state.max_steps) {
    return {
      ok: false,
      reason: {
        reason: "steps_exceeded",
        current: state.monotone_step,
        max: state.max_steps,
      },
    };
  }

  // 8. Mutation permission
  const mutability = syscall.mutability;
  if (
    requiresMutationPermission(mutability) &&
    !call.scope.can_mutate
  ) {
    return { ok: false, reason: { reason: "mutation_not_allowed" } };
  }

  // 9. Snapshot freshness
  if (syscall.maxSnapshotAgeMs !== null) {
    const ageMs = now - call.proposed_at;
    if (ageMs < 0 || ageMs > syscall.maxSnapshotAgeMs) {
      return {
        ok: false,
        reason: {
          reason: "snapshot_too_stale",
          age_secs: Math.max(0, Math.floor(ageMs / 1000)),
          max_age_secs: Math.floor(syscall.maxSnapshotAgeMs / 1000),
        },
      };
    }
  }

  // 10. Path permission (if applicable)
  const path = extractPathFromArgs(call.args);
  if (path !== undefined && !allowsPath(call.scope, path)) {
    return { ok: false, reason: { reason: "path_not_allowed", path } };
  }

  // 11. Argument validation
  try {
    syscall.validateArgs(call.args);
  } catch (e) {
    return {
      ok: false,
      reason: {
        reason: "invalid_args",
        message: e instanceof Error ? e.message : String(e),
      },
    };
  }

  // 12. Proposal reference for Apply layer
  if (syscall.layer.value >= Layer.APPLY.value && !isReadOnly(mutability)) {
    if (call.proposal_ref !== null) {
      if (!ledger.hasProposal(call.proposal_ref.proposal_hash)) {
        return {
          ok: false,
          reason: {
            reason: "proposal_not_found",
            hash_hex: call.proposal_ref.proposal_hash,
          },
        };
      }
      if (
        !call.proposal_ref.proposal_snapshot.matches(state.current_snapshot)
      ) {
        // Tolerance: only mismatch when both sides are non-zero.
        if (
          !call.proposal_ref.proposal_snapshot.isZero() &&
          !state.current_snapshot.isZero()
        ) {
          return {
            ok: false,
            reason: { reason: "proposal_snapshot_mismatch" },
          };
        }
      }
    } else if (
      mutability !== "propose_only" &&
      mutability !== "read_only"
    ) {
      return { ok: false, reason: { reason: "missing_proposal_ref" } };
    }
  }

  return { ok: true };
}

function extractPathFromArgs(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const rec = args as Record<string, unknown>;
  const cand = rec["path"] ?? rec["file"];
  return typeof cand === "string" ? cand : undefined;
}

export { SnapshotId };
