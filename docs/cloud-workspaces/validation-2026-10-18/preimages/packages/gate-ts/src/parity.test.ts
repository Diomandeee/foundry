// Cross-language parity. The SAME case set (fixtures/kernel-parity.json) is
// executed here and by the Rust reference kernel in
// substrate/cc-kernel/tests/parity.rs. A rule changed on one side turns the
// other side red, which is the only thing that makes "the port mirrors the
// reference" a checkable claim instead of a comment.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkAdmissibility } from "./gate.js";
import {
  InMemoryLedger,
  Layer,
  newKernelState,
  newProposedCall,
  newScopeToken,
  SnapshotId,
  type Mutability,
  type ScopeToken,
  type Syscall,
} from "./types.js";

interface Case {
  name: string;
  tool_id: string;
  layer: number;
  mutability: string;
  cost_worst: number;
  max_snapshot_age_secs: number | null;
  frontier: number;
  budget_remaining: number;
  monotone_step: number;
  max_steps: number;
  scope: {
    tools: string[];
    can_mutate: boolean;
    min_layer: number;
    max_layer: number;
    roots: string[];
    expired: boolean;
    not_yet_valid: boolean;
  };
  args: Record<string, unknown>;
  proposed_at_offset_secs: number;
  layer_gate_offset_secs: number | null;
  reject_args: boolean;
  proposal_hash_hex: string | null;
  expect: { ok: boolean; reason: string | null };
}

// `.href` rather than the URL object: @cloudflare/workers-types declares its
// own global URL, which is not the node:url one fileURLToPath is typed against.
const fixturePath = fileURLToPath(
  new URL("../../../fixtures/kernel-parity.json", import.meta.url).href,
);
const cases: Case[] = JSON.parse(readFileSync(fixturePath, "utf8")).cases;

function buildScope(s: Case["scope"], now: number): ScopeToken {
  const scope = newScopeToken();
  scope.allowed_tools = [...s.tools];
  scope.can_mutate = s.can_mutate;
  scope.allowed_layers = {
    min: new Layer(s.min_layer),
    max: new Layer(s.max_layer),
  };
  scope.allowed_roots = [...s.roots];
  scope.issued_at = now + (s.not_yet_valid ? 60_000 : -60_000);
  scope.expires_at = now + (s.expired ? -60_000 : 3_600_000);
  return scope;
}

function buildSyscall(c: Case, layer: Layer): Syscall {
  return {
    id: "mock.syscall",
    layer,
    mutability: c.mutability as Mutability,
    cost: {
      worst_case_units: c.cost_worst,
      typical_units: 0,
      supports_estimate: false,
    },
    maxSnapshotAgeMs:
      c.max_snapshot_age_secs === null ? null : c.max_snapshot_age_secs * 1000,
    validateArgs: () => {
      if (c.reject_args) throw new Error("rejected-by-fixture");
    },
  };
}

describe("kernel parity fixtures (Rust reference <-> TS port)", () => {
  it("loads a case set both implementations run", () => {
    expect(cases.length).toBeGreaterThanOrEqual(30);
    expect(cases.every((c) => typeof c.expect.ok === "boolean")).toBe(true);
  });

  for (const c of cases) {
    it(c.name, () => {
      const now = Date.now();
      const layer = new Layer(c.layer);
      const scope = buildScope(c.scope, now);
      const call = newProposedCall("mock.syscall", c.args, scope);
      call.proposed_at = now + c.proposed_at_offset_secs * 1000;
      if (c.proposal_hash_hex) {
        call.proposal_ref = {
          proposal_hash: c.proposal_hash_hex,
          proposal_snapshot: SnapshotId.zero(),
          proposal_seq: 0,
        };
      }

      const state = newKernelState();
      state.frontier = new Layer(c.frontier);
      state.budget.remaining_units = c.budget_remaining;
      state.monotone_step = c.monotone_step;
      state.max_steps = c.max_steps;
      if (c.layer_gate_offset_secs !== null) {
        state.time_gates.setGate(layer, now + c.layer_gate_offset_secs * 1000);
      }

      const verdict = checkAdmissibility(
        buildSyscall(c, layer),
        call,
        state,
        new InMemoryLedger(),
        now,
      );

      expect(verdict.ok).toBe(c.expect.ok);
      if (!verdict.ok) {
        expect(verdict.reason.reason).toBe(c.expect.reason);
      }
    });
  }
});
