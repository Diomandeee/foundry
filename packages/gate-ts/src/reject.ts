// Reject reasons — mirrors Rust cc-kernel RejectReason (serde snake_case).

export type RejectReason =
  | { reason: "unknown_tool"; tool_id: string }
  | { reason: "scope_expired"; expired_at: string }
  | { reason: "tool_not_allowed"; tool_id: string }
  | {
      reason: "layer_violation";
      frontier: string;
      requested: string;
      max_allowed: string;
    }
  | {
      reason: "time_gate_violation";
      requested: string;
      earliest: string;
      now: string;
    }
  | { reason: "budget_exceeded"; needed: number; remaining: number }
  | { reason: "steps_exceeded"; current: number; max: number }
  | { reason: "mutation_not_allowed" }
  | { reason: "snapshot_too_stale"; age_secs: number; max_age_secs: number }
  | { reason: "path_not_allowed"; path: string }
  | { reason: "invalid_args"; message: string }
  | { reason: "missing_proposal_ref" }
  | { reason: "proposal_not_found"; hash_hex: string }
  | { reason: "proposal_snapshot_mismatch" };

export function describe(r: RejectReason): string {
  switch (r.reason) {
    case "unknown_tool":
      return `Unknown tool: ${r.tool_id}`;
    case "scope_expired":
      return `Scope expired at ${r.expired_at}`;
    case "tool_not_allowed":
      return `Tool not allowed in scope: ${r.tool_id}`;
    case "layer_violation":
      return `Layer violation: at ${r.frontier} but requested ${r.requested}`;
    case "time_gate_violation":
      return `Time gate: ${r.requested} not accessible until ${r.earliest} (now: ${r.now})`;
    case "budget_exceeded":
      return `Budget exceeded: need ${r.needed} but have ${r.remaining}`;
    case "steps_exceeded":
      return `Steps exceeded: ${r.current} of ${r.max} max`;
    case "mutation_not_allowed":
      return "Mutation not permitted in scope";
    case "snapshot_too_stale":
      return `Snapshot too stale: ${r.age_secs}s old, max ${r.max_age_secs}s`;
    case "path_not_allowed":
      return `Path not allowed: ${r.path}`;
    case "invalid_args":
      return `Invalid arguments: ${r.message}`;
    case "missing_proposal_ref":
      return "Apply layer requires proposal reference";
    case "proposal_not_found":
      return `Proposal not found: ${r.hash_hex}`;
    case "proposal_snapshot_mismatch":
      return "Proposal snapshot doesn't match current state";
  }
}

export type GateVerdict = { ok: true } | { ok: false; reason: RejectReason };
