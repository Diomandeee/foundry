import type { RejectReason } from "@foundry/gate-ts";

/**
 * Foundry's own outcomes, which are not kernel policy reasons. Keeping them
 * out of `RejectReason` preserves the 1:1 mirror of the Rust kernel.
 */
/**
 * Reasons that come from Foundry's own policy rather than the kernel's
 * `RejectReason` union. `infra_failure` is not a refusal at all — it marks an
 * unfinished evaluation. `verification_failed` is a real refusal: the proposal
 * was admissible, and a repository-declared check then refused it. Keeping
 * both here rather than widening the kernel union leaves the Rust mirror
 * (`cc-kernel::RejectReason`) untouched.
 */
export type FoundryReason =
  | { reason: "infra_failure"; message: string }
  | { reason: "verification_failed"; message: string };

export type DecisionReason = RejectReason | FoundryReason;

/**
 * `error` means the gate could not finish a policy evaluation — repo access,
 * merge transport or a store write failed. It is NOT a refusal: it is
 * retryable, an operator can filter on it, and a later attempt for the same
 * event replaces it with the final verdict.
 */
export interface DecisionRecord {
  id?: number;
  namespace: string;
  repo: string;
  ref: string;
  before_sha: string;
  after_sha: string;
  verdict: "merge" | "reject" | "conflict" | "error";
  reason?: DecisionReason | null;
  conflict_files?: string[] | null;
  files?: string[] | null;
  merged_sha?: string | null;
  task_id?: string | null;
  agent_id?: string | null;
  decided_at: string;
}

export interface DecisionStore {
  record(d: Omit<DecisionRecord, "id" | "decided_at">): Promise<DecisionRecord>;
  list(repo?: string, limit?: number): Promise<DecisionRecord[]>;
  /**
   * One page of the ledger, newest first and strictly older than `beforeId`
   * (omit it for the newest page). Paging happens in the database so history
   * past the first page stays reachable.
   */
  listPage(opts: {
    repo?: string;
    beforeId?: number;
    limit: number;
  }): Promise<DecisionRecord[]>;
  /** The first decision recorded for this exact push event, if any. */
  findByEvent(
    namespace: string,
    repo: string,
    ref: string,
    beforeSha: string,
    afterSha: string,
  ): Promise<DecisionRecord | null>;
  /** The latest decision touching a commit (push head or merge sha). */
  findBySha(sha: string): Promise<DecisionRecord | null>;
}

export class MemoryDecisionStore implements DecisionStore {
  private rows: DecisionRecord[] = [];

  async findByEvent(
    namespace: string,
    repo: string,
    ref: string,
    beforeSha: string,
    afterSha: string,
  ): Promise<DecisionRecord | null> {
    // An `error` row is not a decision: a retry must still be able to run.
    return (
      this.rows.find(
        (r) =>
          r.verdict !== "error" &&
          r.namespace === namespace &&
          r.repo === repo &&
          r.ref === ref &&
          r.before_sha === beforeSha &&
          r.after_sha === afterSha,
      ) ?? null
    );
  }

  async findBySha(sha: string): Promise<DecisionRecord | null> {
    const hit = [...this.rows]
      .reverse()
      .find(
        (r) =>
          r.after_sha === sha ||
          r.before_sha === sha ||
          r.merged_sha === sha,
      );
    return hit ?? null;
  }

  async record(
    d: Omit<DecisionRecord, "id" | "decided_at">,
  ): Promise<DecisionRecord> {
    // Idempotent: a redelivered event returns its first final decision.
    const prior = await this.findByEvent(
      d.namespace,
      d.repo,
      d.ref,
      d.before_sha,
      d.after_sha,
    );
    if (prior) return prior;
    const decided_at = new Date().toISOString();
    // Only an `error` row can be replaced, and it keeps its id: the event has
    // one row from first failure to final verdict.
    const existing = this.rows.find(
      (r) =>
        r.namespace === d.namespace &&
        r.repo === d.repo &&
        r.ref === d.ref &&
        r.before_sha === d.before_sha &&
        r.after_sha === d.after_sha,
    );
    if (existing) {
      Object.assign(existing, d, { decided_at });
      return existing;
    }
    const row: DecisionRecord = {
      ...d,
      id: this.rows.length + 1,
      decided_at,
    };
    this.rows.push(row);
    return row;
  }

  async listPage(opts: {
    repo?: string;
    beforeId?: number;
    limit: number;
  }): Promise<DecisionRecord[]> {
    const { repo, beforeId, limit } = opts;
    return this.rows
      .filter(
        (r) =>
          (!repo || r.repo === repo) &&
          (beforeId === undefined || (r.id ?? 0) < beforeId),
      )
      .slice(-limit)
      .reverse();
  }

  async list(repo?: string, limit = 50): Promise<DecisionRecord[]> {
    const rows = repo ? this.rows.filter((r) => r.repo === repo) : this.rows;
    return rows.slice(-limit).reverse();
  }
}

function mapRow(r: Record<string, unknown>): DecisionRecord {
  return {
    id: r.id as number,
    namespace: r.namespace as string,
    repo: r.repo as string,
    ref: r.ref as string,
    before_sha: r.before_sha as string,
    after_sha: r.after_sha as string,
    verdict: r.verdict as DecisionRecord["verdict"],
    reason: r.reason
      ? (JSON.parse(r.reason as string) as DecisionReason)
      : null,
    conflict_files: r.conflict_files
      ? (JSON.parse(r.conflict_files as string) as string[])
      : null,
    files: r.files ? (JSON.parse(r.files as string) as string[]) : null,
    merged_sha: (r.merged_sha as string | null) ?? null,
    task_id: (r.task_id as string | null) ?? null,
    agent_id: (r.agent_id as string | null) ?? null,
    decided_at: r.decided_at as string,
  };
}

export class D1DecisionStore implements DecisionStore {
  constructor(private db: D1Database) {}

  /** `finalOnly` skips `error` rows — an unfinished attempt is not a decision. */
  private async selectEvent(
    namespace: string,
    repo: string,
    ref: string,
    beforeSha: string,
    afterSha: string,
    finalOnly: boolean,
  ): Promise<DecisionRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM decisions
         WHERE namespace = ? AND repo = ? AND ref = ?
           AND before_sha = ? AND after_sha = ?
           ${finalOnly ? "AND verdict <> 'error'" : ""}
         ORDER BY id ASC LIMIT 1`,
      )
      .bind(namespace, repo, ref, beforeSha, afterSha)
      .first<Record<string, unknown>>();
    return row ? mapRow(row) : null;
  }

  async findByEvent(
    namespace: string,
    repo: string,
    ref: string,
    beforeSha: string,
    afterSha: string,
  ): Promise<DecisionRecord | null> {
    return this.selectEvent(namespace, repo, ref, beforeSha, afterSha, true);
  }

  async record(
    d: Omit<DecisionRecord, "id" | "decided_at">,
  ): Promise<DecisionRecord> {
    const decided_at = new Date().toISOString();
    // One row per push event (UNIQUE event index in schema.sql). The first
    // final decision stands and cannot be overwritten; an `error` row is the
    // one exception, so a retry lands its verdict on the same row.
    await this.db
      .prepare(
        `INSERT INTO decisions
         (namespace, repo, ref, before_sha, after_sha, verdict, reason,
          conflict_files, files, merged_sha, task_id, agent_id, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (namespace, repo, ref, before_sha, after_sha) DO UPDATE SET
           verdict = excluded.verdict,
           reason = excluded.reason,
           conflict_files = excluded.conflict_files,
           files = excluded.files,
           merged_sha = excluded.merged_sha,
           task_id = excluded.task_id,
           agent_id = excluded.agent_id,
           decided_at = excluded.decided_at
         WHERE decisions.verdict = 'error'`,
      )
      .bind(
        d.namespace,
        d.repo,
        d.ref,
        d.before_sha,
        d.after_sha,
        d.verdict,
        d.reason ? JSON.stringify(d.reason) : null,
        d.conflict_files ? JSON.stringify(d.conflict_files) : null,
        d.files ? JSON.stringify(d.files) : null,
        d.merged_sha ?? null,
        d.task_id ?? null,
        d.agent_id ?? null,
        decided_at,
      )
      .run();
    // Read back without the `error` filter: a just-recorded error row is a
    // real row and must come back with its id, so a retry can replace it.
    const row = await this.selectEvent(
      d.namespace,
      d.repo,
      d.ref,
      d.before_sha,
      d.after_sha,
      false,
    );
    return row ?? { ...d, decided_at };
  }

  async findBySha(sha: string): Promise<DecisionRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM decisions
         WHERE after_sha = ? OR before_sha = ? OR merged_sha = ?
         ORDER BY id DESC LIMIT 1`,
      )
      .bind(sha, sha, sha)
      .first<Record<string, unknown>>();
    return row ? mapRow(row) : null;
  }

  async list(repo?: string, limit = 50): Promise<DecisionRecord[]> {
    const query = repo
      ? this.db
          .prepare(
            "SELECT * FROM decisions WHERE repo = ? ORDER BY id DESC LIMIT ?",
          )
          .bind(repo, limit)
      : this.db
          .prepare("SELECT * FROM decisions ORDER BY id DESC LIMIT ?")
          .bind(limit);
    const { results } = await query.all<Record<string, unknown>>();
    return results.map(mapRow);
  }

  async listPage(opts: {
    repo?: string;
    beforeId?: number;
    limit: number;
  }): Promise<DecisionRecord[]> {
    const clauses: string[] = [];
    const binds: unknown[] = [];
    if (opts.repo) {
      clauses.push("repo = ?");
      binds.push(opts.repo);
    }
    if (opts.beforeId !== undefined) {
      clauses.push("id < ?");
      binds.push(opts.beforeId);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    binds.push(opts.limit);
    const { results } = await this.db
      .prepare(`SELECT * FROM decisions ${where} ORDER BY id DESC LIMIT ?`)
      .bind(...binds)
      .all<Record<string, unknown>>();
    return (results ?? []).map(mapRow);
  }
}
