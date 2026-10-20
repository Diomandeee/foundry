// Stateless handoff packet v1: the one handoff format of the agent fabric
// (docs/AGENT-FABRIC.md §5, contracts/agent/handoff-packet.v1.schema.json).
//
// `checkPacket` is a behaviour-identical port of UCTM Studio's rule engine
// (bridge/handoff/validate_handoff.py, rules R1-R5): same violation strings,
// same order, so verdicts can be compared against the Python corpus run.
// `gateWrite` is the write gate from bridge/handoff/gate.py: validate before a
// packet lands in the store; a packet that still fails is written FLAGGED, never
// into the store, never silently.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export const REQUIRED_KEYS = [
  "handoff_id", "generated_at", "objective", "evidence",
  "still_false", "open_questions", "next_prompt", "stop_condition",
] as const;
export const OVERCLAIM_WORDS = ["proved", "proven", "done", "complete", "verified"] as const;

export type HandoffPacket = Record<string, unknown>;
type Dict = Record<string, unknown>;

const isDict = (v: unknown): v is Dict => typeof v === "object" && v !== null && !Array.isArray(v);
// Python's `(x or '').strip()` on the values these packets carry.
const text = (v: unknown): string => (v === null || v === undefined || v === false || v === 0 || v === "" ? "" : String(v)).trim();
const expandUser = (p: string): string => (p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p);

/** Python 3.11 `datetime.fromisoformat` after `replace('Z', '+00:00')`, for the shapes that occur in packets. */
function parsesAsIso(value: string): boolean {
  const s = value.replace("Z", "+00:00");
  const re = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,6})?)?(?:[+-]\d{2}:?\d{2})?)?$/;
  const m = re.exec(s);
  if (!m) return false;
  const [, y, mo, d, hh, mm, ss] = m;
  const month = Number(mo), day = Number(d);
  if (month < 1 || month > 12 || day < 1) return false;
  if (day > new Date(Date.UTC(Number(y), month, 0)).getUTCDate()) return false;
  if (hh !== undefined && (Number(hh) > 23 || Number(mm) > 59)) return false;
  if (ss !== undefined && Number(ss) > 59) return false;
  return true;
}

/** Python `json.dumps(...)` lowered, close enough for an ASCII word search. */
const dumpsLower = (v: unknown): string => JSON.stringify(v === undefined ? {} : v).toLowerCase();

/**
 * Rules R1-R5. Returns violations; [] means PASS.
 * `root` resolves repo-relative artifact paths, as the Python `--root`.
 */
export function checkPacket(packet: unknown, root?: string): string[] {
  const v: string[] = [];
  if (!isDict(packet)) return ["NOT_AN_OBJECT"];
  let d: Dict = packet;
  const ev0: Dict = isDict(d.evidence) ? d.evidence : {};
  for (const k of REQUIRED_KEYS) {
    if (!(k in d) && !(k in ev0)) v.push(`MISSING_KEY: ${k}`);
  }
  for (const k of ["still_false", "open_questions"] as const) {
    if (k in ev0 && !Array.isArray(ev0[k])) v.push(`BAD_${k.toUpperCase()}_TYPE`);
    else if (k in ev0) d = { ...d, [k]: ev0[k] };
  }
  const objective = d.objective;
  if (!isDict(objective) || text(objective.statement) === "") v.push("BAD_OBJECTIVE_STATEMENT");
  const ev = d.evidence;
  const items: unknown = isDict(ev) ? (ev.items ?? []) : Array.isArray(ev) ? ev : null;
  if (!Array.isArray(items) || items.length === 0) {
    v.push("NO_EVIDENCE_ITEMS");
  } else {
    items.forEach((it, i) => {
      if (!isDict(it)) { v.push(`ITEM_${i}_NOT_OBJECT`); return; }
      if (text(it.claim) === "") v.push(`ITEM_${i}_NO_CLAIM`);
      const art = text(it.artifact);
      if (art === "") { v.push(`ITEM_${i}_NO_ARTIFACT`); return; }
      let p = expandUser(art);
      if (!isAbsolute(p) && root) p = join(root, p);
      if (!existsSync(p)) v.push(`ITEM_${i}_ARTIFACT_MISSING: ${art}`);
    });
  }
  for (const k of ["still_false", "open_questions"] as const) {
    if (k in d && !Array.isArray(d[k])) v.push(`BAD_${k.toUpperCase()}_TYPE`);
  }
  for (const k of ["next_prompt", "stop_condition"] as const) {
    if (k in d && text(d[k]) === "") v.push(`EMPTY_${k.toUpperCase()}`);
  }
  if (!parsesAsIso(String(d.generated_at ?? ""))) v.push("BAD_GENERATED_AT");
  const low = dumpsLower(d.evidence);
  const stillFalse = d.still_false;
  const hasBounds = Array.isArray(stillFalse) ? stillFalse.length > 0 : Boolean(stillFalse);
  if (OVERCLAIM_WORDS.some(w => low.includes(w)) && !hasBounds) v.push("OVERCLAIM_WITHOUT_BOUNDS");
  return v;
}

/**
 * The fabric's full check: R1-R5 plus the v1 schema's lifecycle rule. A packet
 * that claims continuity is rejected: a worker that cannot remember cannot
 * misremember, and a packet is the only memory it gets.
 */
export function validateHandoff(packet: unknown, root?: string): string[] {
  const v = checkPacket(packet, root);
  if (!isDict(packet)) return v;
  const life = packet.lifecycle;
  if (!isDict(life) || life.continuity_assumed !== false) v.push("CONTINUITY_ASSUMED");
  const lookup = packet.lookup_policy;
  if (isDict(lookup) && "backward_lookup" in lookup
      && !["default-off", "named-artifact-only"].includes(String(lookup.backward_lookup))) {
    v.push("BAD_LOOKUP_POLICY");
  }
  return v;
}

/** 'ITEM_3_ARTIFACT_MISSING: /tmp/x' -> 'ITEM_ARTIFACT_MISSING'; 'MISSING_KEY: x' -> 'MISSING_KEY'. */
export function violationClass(violation: string): string {
  const head = violation.split(":", 1)[0].trim();
  if (head.startsWith("ITEM_")) {
    const rest = head.slice("ITEM_".length);
    const idx = rest.indexOf("_");
    if (idx > 0 && /^\d+$/.test(rest.slice(0, idx))) return "ITEM_" + rest.slice(idx + 1);
  }
  return head;
}

/**
 * Deterministic shape repair (gate.py `shape_repair`): fixes what the writer
 * provably has and mis-nested, never invents content. Returns a new packet.
 */
export function shapeRepair(packet: HandoffPacket, now: () => string = () => new Date().toISOString()): HandoffPacket {
  const out: Dict = structuredClone(packet);
  if (isDict(out.evidence)) {
    for (const k of ["still_false", "open_questions"] as const) {
      if (k in out.evidence && !(k in out)) { out[k] = out.evidence[k]; }
    }
  }
  for (const k of ["still_false", "open_questions"] as const) {
    if (!(k in out)) out[k] = [];
  }
  if (typeof out.objective === "string") out.objective = { statement: out.objective };
  if (!parsesAsIso(String(out.generated_at ?? ""))) out.generated_at = now();
  if (!isDict(out.lifecycle)) out.lifecycle = { continuity_assumed: false };
  return out;
}

export interface GateOutcome {
  written: boolean;
  path: string;
  attempts: number;
  violations: string[];
  packet: HandoffPacket;
}

/**
 * The write gate. Validates, repairs shape up to `maxAttempts`, and writes the
 * packet to `storeDir/<handoff_id>.json` on PASS or to `flaggedDir` on FAIL.
 * The packet carries a `validation` record either way. Never fails open.
 */
export function gateWrite(
  packet: HandoffPacket,
  opts: { storeDir: string; flaggedDir?: string; root?: string; maxAttempts?: number; now?: () => string },
): GateOutcome {
  const now = opts.now ?? (() => new Date().toISOString());
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
  const flaggedDir = opts.flaggedDir ?? join(opts.storeDir, "_flagged");
  let current: HandoffPacket = structuredClone(packet);
  let violations: string[] = [];
  let attempts = 0;
  for (; attempts < maxAttempts; attempts++) {
    violations = validateHandoff(current, opts.root);
    if (violations.length === 0) break;
    const repaired = shapeRepair(current, now);
    if (JSON.stringify(repaired) === JSON.stringify(current)) { attempts++; break; }
    current = repaired;
  }
  const ok = violations.length === 0;
  const id = text(current.handoff_id) || `unnamed-${now().replace(/[^0-9]/g, "")}`;
  const safeId = id.replace(/[^A-Za-z0-9._-]/g, "_");
  const dir = ok ? opts.storeDir : flaggedDir;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${safeId}.json`);
  const record = { ...current, validation: { at: now(), verdict: ok ? "PASS" : "FAIL", attempts, violations } };
  writeFileSync(path, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
  return { written: ok, path, attempts, violations, packet: record };
}
