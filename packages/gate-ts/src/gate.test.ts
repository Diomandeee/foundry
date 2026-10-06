// Gate tests — mirrors the Rust admissibility tests plus rule coverage.
import { describe, expect, it } from "vitest";
import { checkAdmissibility } from "./gate.js";
import {
  cheapCost,
  InMemoryLedger,
  Layer,
  newKernelState,
  newProposedCall,
  newScopeToken,
  SnapshotId,
  type Mutability,
  type Syscall,
} from "./types.js";

function mockSyscall(
  layer: Layer,
  mutability: Mutability,
  opts: Partial<Syscall> = {},
): Syscall {
  return {
    id: "mock.syscall",
    layer,
    mutability,
    cost: cheapCost(),
    maxSnapshotAgeMs: null,
    validateArgs: () => {},
    ...opts,
  };
}

function testScope() {
  const scope = newScopeToken();
  scope.allowed_tools = ["mock.syscall"];
  scope.can_mutate = false;
  return scope;
}

describe("checkAdmissibility (Rust parity)", () => {
  it("admits a valid read-only call", () => {
    const v = checkAdmissibility(
      mockSyscall(Layer.OBSERVE, "read_only"),
      newProposedCall("mock.syscall", {}, testScope()),
      newKernelState(),
      new InMemoryLedger(),
    );
    expect(v.ok).toBe(true);
  });

  it("rejects an expired scope", () => {
    const scope = testScope();
    scope.expires_at = Date.now() - 3_600_000;
    const v = checkAdmissibility(
      mockSyscall(Layer.OBSERVE, "read_only"),
      newProposedCall("mock.syscall", {}, scope),
      newKernelState(),
      new InMemoryLedger(),
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason.reason).toBe("scope_expired");
  });

  it("rejects an L0→L2 jump", () => {
    const v = checkAdmissibility(
      mockSyscall(Layer.STRUCTURE, "propose_only"),
      newProposedCall("mock.syscall", {}, testScope()),
      newKernelState(), // frontier at L0
      new InMemoryLedger(),
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v2reason(v)).toBe("layer_violation");
  });

  it("rejects mutation without permission", () => {
    const v = checkAdmissibility(
      mockSyscall(Layer.OBSERVE, "reversible"),
      newProposedCall("mock.syscall", {}, testScope()), // can_mutate=false
      newKernelState(),
      new InMemoryLedger(),
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason.reason).toBe("mutation_not_allowed");
  });
});

describe("checkAdmissibility (rule coverage)", () => {
  it("rejects a tool outside the scope allowlist", () => {
    const v = checkAdmissibility(
      mockSyscall(Layer.OBSERVE, "read_only"),
      newProposedCall("evil.tool", {}, testScope()),
      newKernelState(),
      new InMemoryLedger(),
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason.reason).toBe("tool_not_allowed");
  });

  it("rejects an unaffordable call", () => {
    const state = newKernelState();
    state.budget.remaining_units = 5; // cheap() needs 10
    const v = checkAdmissibility(
      mockSyscall(Layer.OBSERVE, "read_only"),
      newProposedCall("mock.syscall", {}, testScope()),
      state,
      new InMemoryLedger(),
    );
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason.reason).toBe("budget_exceeded");
      if (v.reason.reason === "budget_exceeded") {
        expect(v.reason.needed).toBe(10);
        expect(v.reason.remaining).toBe(5);
      }
    }
  });

  it("rejects a call past max steps", () => {
    const state = newKernelState();
    state.monotone_step = state.max_steps;
    const v = checkAdmissibility(
      mockSyscall(Layer.OBSERVE, "read_only"),
      newProposedCall("mock.syscall", {}, testScope()),
      state,
      new InMemoryLedger(),
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason.reason).toBe("steps_exceeded");
  });

  it("rejects a stale proposal", () => {
    const call = newProposedCall("mock.syscall", {}, testScope());
    call.proposed_at = Date.now() - 120_000;
    const v = checkAdmissibility(
      mockSyscall(Layer.OBSERVE, "read_only", { maxSnapshotAgeMs: 60_000 }),
      call,
      newKernelState(),
      new InMemoryLedger(),
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason.reason).toBe("snapshot_too_stale");
  });

  it("rejects a path outside allowed roots", () => {
    const scope = testScope();
    scope.allowed_roots = ["src/allowed"];
    const v = checkAdmissibility(
      mockSyscall(Layer.OBSERVE, "read_only"),
      newProposedCall("mock.syscall", { path: "etc/passwd" }, scope),
      newKernelState(),
      new InMemoryLedger(),
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason.reason).toBe("path_not_allowed");
  });

  it("rejects invalid args", () => {
    const v = checkAdmissibility(
      mockSyscall(Layer.OBSERVE, "read_only", {
        validateArgs: () => {
          throw new Error("nope");
        },
      }),
      newProposedCall("mock.syscall", {}, testScope()),
      newKernelState(),
      new InMemoryLedger(),
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason.reason).toBe("invalid_args");
  });

  it("requires a proposal ref for mutating Apply calls", () => {
    const scope = testScope();
    scope.can_mutate = true;
    const state = newKernelState();
    state.frontier = Layer.STRUCTURE; // L3 within +1
    const v = checkAdmissibility(
      mockSyscall(Layer.APPLY, "reversible"),
      newProposedCall("mock.syscall", {}, scope),
      state,
      new InMemoryLedger(),
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason.reason).toBe("missing_proposal_ref");
  });

  it("rejects an unknown proposal hash", () => {
    const scope = testScope();
    scope.can_mutate = true;
    const state = newKernelState();
    state.frontier = Layer.STRUCTURE;
    const call = newProposedCall("mock.syscall", {}, scope);
    call.proposal_ref = {
      proposal_hash: "ab".repeat(32),
      proposal_snapshot: SnapshotId.zero(),
      proposal_seq: 1,
    };
    const v = checkAdmissibility(
      mockSyscall(Layer.APPLY, "reversible"),
      call,
      state,
      new InMemoryLedger(), // empty
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason.reason).toBe("proposal_not_found");
  });

  it("admits a well-formed Apply call with known proposal", () => {
    const scope = testScope();
    scope.can_mutate = true;
    const state = newKernelState();
    state.frontier = Layer.STRUCTURE;
    const ledger = new InMemoryLedger();
    ledger.addProposal("ab".repeat(32));
    const call = newProposedCall("mock.syscall", {}, scope);
    call.proposal_ref = {
      proposal_hash: "ab".repeat(32),
      proposal_snapshot: SnapshotId.zero(),
      proposal_seq: 1,
    };
    const v = checkAdmissibility(
      mockSyscall(Layer.APPLY, "reversible"),
      call,
      state,
      ledger,
    );
    expect(v.ok).toBe(true);
  });
});

function v2reason(v: { ok: false; reason: { reason: string } }): string {
  return v.reason.reason;
}
