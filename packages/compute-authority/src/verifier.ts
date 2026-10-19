// Reference byte checker + in-memory append-only audit cursor.
// Not durable storage or a transactional outbox implementation.
// A worker's hash proves nothing by itself: the verifier re-checks the
// result against the workload's expectation, and only a verified result
// can be accepted by the authority. Audit drain redelivers until acknowledged.
import type { ExecResult } from "./executor.js";
import { createHash } from "node:crypto";

export interface VerificationExpectation {
  kind: string;
  exitCode?: number;
  stdoutSha256?: string;
  minBytes?: number;
}

export interface Verification {
  verified: boolean;
  reason: string;
}

/** Pure checker. trustedBytes must come from a separately authorized immutable
 * artifact reader, never the worker payload. Authority binds exp at intake.
 */
export function verifyResult(
  result: Pick<ExecResult, "outcome" | "exitCode" | "stdoutSha256" | "stdoutBytes">,
  exp: VerificationExpectation,
  trustedBytes?: Uint8Array,
): Verification {
  // R07: outcomes other than clean exit never verify.
  if (result.outcome !== "exited") return { verified: false, reason: `exec-${result.outcome}` };
  // R07: an expectation with no checks verifies nothing.
  if (exp.exitCode === undefined && exp.stdoutSha256 === undefined && exp.minBytes === undefined) {
    return { verified: false, reason: "no-policy" };
  }
  if (!(trustedBytes instanceof Uint8Array)) return { verified: false, reason: "no-artifact-bytes" };
  if (!exp.stdoutSha256 || !/^[a-f0-9]{64}$/.test(exp.stdoutSha256)) return { verified: false, reason: "no-content-policy" };
  if (trustedBytes.byteLength > 4 * 1024 * 1024 || trustedBytes.byteLength !== result.stdoutBytes ||
      createHash("sha256").update(trustedBytes).digest("hex") !== result.stdoutSha256) {
    return { verified: false, reason: "artifact-mismatch" };
  }
  if (exp.exitCode !== undefined && result.exitCode !== exp.exitCode) {
    return { verified: false, reason: `exit ${result.exitCode} != ${exp.exitCode}` };
  }
  if (exp.stdoutSha256 !== undefined && result.stdoutSha256 !== exp.stdoutSha256) {
    return { verified: false, reason: "sha-mismatch" };
  }
  if (exp.minBytes !== undefined && result.stdoutBytes < exp.minBytes) {
    return { verified: false, reason: "too-few-bytes" };
  }
  return { verified: true, reason: "artifact-check-passed" };
}

export interface AuditEvent {
  seq: number;
  at: number;
  kind: string;
  detail: string;
}

/** Append-only audit log with an outbox cursor for the read projection. */
export class AuditLog {
  private events: AuditEvent[] = [];
  private outboxCursor = 0;
  /** Highest seq ever handed out by drainOutbox. Acks beyond it are rejected. */
  private drainedHighWater = -1;

  append(kind: string, detail: string, at: number = Date.now()): AuditEvent {
    const ev: AuditEvent = Object.freeze({ seq: this.events.length, at, kind, detail });
    this.events.push(ev);
    return ev;
  }

  /** Drain unprojected events as frozen copies; records the high-water mark. */
  drainOutbox(): AuditEvent[] {
    const batch = this.events.slice(this.outboxCursor).map((e) => Object.freeze({ ...e }));
    if (batch.length > 0) this.drainedHighWater = this.events.length - 1;
    return batch;
  }

  /**
   * Advance the cursor only for already-drained events. Acks past the
   * high-water mark (never delivered) are rejected — no silent skips.
   */
  ackOutbox_through(seq: number): boolean {
    if (!Number.isInteger(seq) || seq < this.outboxCursor) return false;
    if (seq > this.drainedHighWater) return false;
    this.outboxCursor = seq + 1;
    return true;
  }

  get pendingOutbox(): number {
    return this.events.length - this.outboxCursor;
  }

  all(): AuditEvent[] {
    return [...this.events];
  }
}
