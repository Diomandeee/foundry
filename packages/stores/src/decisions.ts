import type { RejectReason } from "@foundry/gate-ts";

export interface DecisionRecord {
  id?: number;
  namespace: string;
  repo: string;
  ref: string;
  before_sha: string;
  after_sha: string;
  verdict: "merge" | "reject" | "conflict";
  reason?: RejectReason | null;
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
}

export class MemoryDecisionStore implements DecisionStore {
  private rows: DecisionRecord[] = [];

  async record(
    d: Omit<DecisionRecord, "id" | "decided_at">,
  ): Promise<DecisionRecord> {
    const row: DecisionRecord = {
      ...d,
      id: this.rows.length + 1,
      decided_at: new Date().toISOString(),
    };
    this.rows.push(row);
    return row;
  }

  async list(repo?: string, limit = 50): Promise<DecisionRecord[]> {
    const rows = repo ? this.rows.filter((r) => r.repo === repo) : this.rows;
    return rows.slice(-limit).reverse();
  }
}

export class D1DecisionStore implements DecisionStore {
  constructor(private db: D1Database) {}

  async record(
    d: Omit<DecisionRecord, "id" | "decided_at">,
  ): Promise<DecisionRecord> {
    const decided_at = new Date().toISOString();
    const res = await this.db
      .prepare(
        `INSERT INTO decisions
         (namespace, repo, ref, before_sha, after_sha, verdict, reason,
          conflict_files, files, merged_sha, task_id, agent_id, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING id`,
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
      .first<{ id: number }>();
    return { ...d, id: res?.id, decided_at };
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
    return results.map((r) => ({
      id: r.id as number,
      namespace: r.namespace as string,
      repo: r.repo as string,
      ref: r.ref as string,
      before_sha: r.before_sha as string,
      after_sha: r.after_sha as string,
      verdict: r.verdict as DecisionRecord["verdict"],
      reason: r.reason
        ? (JSON.parse(r.reason as string) as RejectReason)
        : null,
      conflict_files: r.conflict_files
        ? (JSON.parse(r.conflict_files as string) as string[])
        : null,
      merged_sha: (r.merged_sha as string | null) ?? null,
      task_id: (r.task_id as string | null) ?? null,
      agent_id: (r.agent_id as string | null) ?? null,
      decided_at: r.decided_at as string,
    }));
  }
}
