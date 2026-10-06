// Kernel types — faithful TS port of cc-kernel types/*.rs.
// Times are ms since epoch. SnapshotId is a 32-byte lowercase hex string.
// (Rust uses blake3; hashing entry points stay with callers via SubtleCrypto.)

// --- Layer ---------------------------------------------------------------

export class Layer {
  static readonly OBSERVE = new Layer(0);
  static readonly INTERPRET = new Layer(1);
  static readonly STRUCTURE = new Layer(2);
  static readonly APPLY = new Layer(3);
  static readonly TRANSFORM = new Layer(4);

  readonly value: number;

  constructor(value: number) {
    this.value = value;
  }

  /** Plus-one rule: target must be <= frontier + 1. */
  canTransitionTo(target: Layer): boolean {
    return target.value <= this.value + 1;
  }

  /** Minimum delay before entering this layer, in ms. */
  timeGateMs(): number {
    switch (this.value) {
      case 0:
        return 0;
      case 1:
        return 2_000;
      case 2:
        return 5_000;
      case 3:
        return 15_000;
      default:
        return 30_000;
    }
  }

  toString(): string {
    switch (this.value) {
      case 0:
        return "L0:Observe";
      case 1:
        return "L1:Interpret";
      case 2:
        return "L2:Structure";
      case 3:
        return "L3:Apply";
      case 4:
        return "L4:Transform";
      default:
        return `L${this.value}:Unknown`;
    }
  }
}

export interface LayerRange {
  min: Layer;
  max: Layer;
}

export function layerInRange(range: LayerRange, layer: Layer): boolean {
  return layer.value >= range.min.value && layer.value <= range.max.value;
}

export const readOnlyRange = (): LayerRange => ({
  min: Layer.OBSERVE,
  max: Layer.OBSERVE,
});
export const standardRange = (): LayerRange => ({
  min: Layer.OBSERVE,
  max: Layer.APPLY,
});
export const fullRange = (): LayerRange => ({
  min: Layer.OBSERVE,
  max: Layer.TRANSFORM,
});

// --- Scope ---------------------------------------------------------------

export interface ScopeToken {
  scope_id: string;
  project_id: string;
  session_id: string | null;
  /** Empty = all tools within layer range allowed. */
  allowed_tools: string[];
  allowed_layers: LayerRange;
  can_mutate: boolean;
  /** Empty = all permitted paths. Compared with segment boundaries. */
  allowed_roots: string[];
  issued_at: number;
  expires_at: number;
  signature?: number[];
}

export function newScopeToken(
  projectId = crypto.randomUUID(),
  sessionId: string | null = null,
): ScopeToken {
  const now = Date.now();
  return {
    scope_id: crypto.randomUUID(),
    project_id: projectId,
    session_id: sessionId,
    allowed_tools: [],
    allowed_layers: standardRange(),
    can_mutate: false,
    allowed_roots: [],
    issued_at: now,
    expires_at: now + 3_600_000,
  };
}

export function readOnlyScope(projectId = crypto.randomUUID()): ScopeToken {
  return {
    ...newScopeToken(projectId, null),
    allowed_layers: readOnlyRange(),
    can_mutate: false,
  };
}

export function isScopeValid(scope: ScopeToken, now: number): boolean {
  return now >= scope.issued_at && now < scope.expires_at;
}

export function allowsTool(scope: ScopeToken, toolId: string): boolean {
  return (
    scope.allowed_tools.length === 0 || scope.allowed_tools.includes(toolId)
  );
}

export function allowsLayer(scope: ScopeToken, layer: Layer): boolean {
  return layerInRange(scope.allowed_layers, layer);
}

export function allowsPath(scope: ScopeToken, path: string): boolean {
  if (scope.allowed_roots.length === 0) return true;
  const norm = path.replace(/\/+$/, "");
  return scope.allowed_roots.some((root) => {
    const r = root.replace(/\/+$/, "");
    return norm === r || norm.startsWith(r + "/");
  });
}

// --- State ----------------------------------------------------------------

export class TimeGates {
  private earliestEnter = new Map<number, number>();

  isAccessible(layer: Layer, now: number): boolean {
    const earliest = this.earliestEnter.get(layer.value);
    return earliest === undefined || now >= earliest;
  }

  setGate(layer: Layer, earliest: number): void {
    this.earliestEnter.set(layer.value, earliest);
  }

  getGate(layer: Layer): number | undefined {
    return this.earliestEnter.get(layer.value);
  }
}

export interface Budget {
  total_units: number;
  remaining_units: number;
  consumed_units: number;
}

export function newBudget(total: number): Budget {
  return { total_units: total, remaining_units: total, consumed_units: 0 };
}

export function canAfford(budget: Budget, units: number): boolean {
  return units <= budget.remaining_units;
}

export function consumeBudget(budget: Budget, units: number): boolean {
  if (units <= budget.remaining_units) {
    budget.remaining_units -= units;
    budget.consumed_units += units;
    return true;
  }
  return false;
}

export interface KernelState {
  frontier: Layer;
  time_gates: TimeGates;
  budget: Budget;
  monotone_step: number;
  max_steps: number;
  current_snapshot: SnapshotId;
  started_at: number;
}

export function newKernelState(): KernelState {
  return {
    frontier: Layer.OBSERVE,
    time_gates: new TimeGates(),
    budget: newBudget(100_000),
    monotone_step: 0,
    max_steps: 10_000,
    current_snapshot: SnapshotId.zero(),
    started_at: Date.now(),
  };
}

export function kernelStateWithBudget(budgetUnits: number): KernelState {
  return { ...newKernelState(), budget: newBudget(budgetUnits) };
}

export function advanceTo(state: KernelState, layer: Layer): void {
  if (layer.value > state.frontier.value) {
    state.frontier = layer;
    const next = new Layer(layer.value + 1);
    state.time_gates.setGate(next, Date.now() + next.timeGateMs());
  }
}

// --- Cost / mutability ----------------------------------------------------

export type Mutability =
  | "read_only"
  | "propose_only"
  | "reversible"
  | "irreversible";

export function requiresMutationPermission(m: Mutability): boolean {
  return m === "reversible" || m === "irreversible";
}

export function isReadOnly(m: Mutability): boolean {
  return m === "read_only";
}

export interface CostModel {
  worst_case_units: number;
  typical_units: number;
  supports_estimate: boolean;
}

export const cheapCost = (): CostModel => ({
  worst_case_units: 10,
  typical_units: 5,
  supports_estimate: false,
});
export const standardCost = (): CostModel => ({
  worst_case_units: 100,
  typical_units: 50,
  supports_estimate: false,
});
export const expensiveCost = (): CostModel => ({
  worst_case_units: 1000,
  typical_units: 500,
  supports_estimate: true,
});
export const customCost = (worst: number, typical: number): CostModel => ({
  worst_case_units: worst,
  typical_units: typical,
  supports_estimate: false,
});

// --- Snapshot -------------------------------------------------------------

export class SnapshotId {
  readonly hex: string;

  private constructor(hex: string) {
    this.hex = hex;
  }

  static zero(): SnapshotId {
    return new SnapshotId("00".repeat(32));
  }

  static fromHex(s: string): SnapshotId {
    const hex = s.toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hex)) {
      throw new Error(`invalid SnapshotId hex: ${s.slice(0, 32)}…`);
    }
    return new SnapshotId(hex);
  }

  /** Bind a short hex id (e.g. 40-char git sha) by left-padding with zeros. */
  static fromShortHex(s: string): SnapshotId {
    const hex = s.toLowerCase();
    if (!/^[0-9a-f]{1,64}$/.test(hex)) {
      throw new Error(`invalid short hex id: ${s.slice(0, 32)}…`);
    }
    return new SnapshotId(hex.padStart(64, "0"));
  }

  matches(other: SnapshotId): boolean {
    return this.hex === other.hex;
  }

  isZero(): boolean {
    return this.hex === "00".repeat(32);
  }

  toHex(): string {
    return this.hex;
  }

  toString(): string {
    return this.hex.slice(0, 16);
  }
}

// --- Calls ------------------------------------------------------------------

export interface ProposalRef {
  proposal_hash: string;
  proposal_snapshot: SnapshotId;
  proposal_seq: number;
}

export interface ProposedCall {
  call_id: string;
  tool_id: string;
  args: unknown;
  scope: ScopeToken;
  snapshot: SnapshotId;
  proposed_at: number;
  proposal_ref: ProposalRef | null;
}

export function newProposedCall(
  toolId: string,
  args: unknown,
  scope: ScopeToken,
): ProposedCall {
  return {
    call_id: crypto.randomUUID(),
    tool_id: toolId,
    args,
    scope,
    snapshot: SnapshotId.zero(),
    proposed_at: Date.now(),
    proposal_ref: null,
  };
}

// --- Syscall / ledger -------------------------------------------------------

export interface Syscall {
  id: string;
  layer: Layer;
  mutability: Mutability;
  cost: CostModel;
  /** Max proposal age in ms, or null for no freshness requirement. */
  maxSnapshotAgeMs: number | null;
  /** Throw to reject args. */
  validateArgs(args: unknown): void;
}

export interface Ledger {
  hasProposal(hashHex: string): boolean;
}

export class InMemoryLedger implements Ledger {
  private proposals = new Set<string>();

  addProposal(hashHex: string): void {
    this.proposals.add(hashHex.toLowerCase());
  }

  hasProposal(hashHex: string): boolean {
    return this.proposals.has(hashHex.toLowerCase());
  }
}
