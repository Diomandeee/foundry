// Canonical Foundry graph shapes. Single authority for every triple the
// system writes, so readers (overlap oracle, board) can join on them.
// Namespaces: task:<id>, repo:<name>, agent:<id>, commit:<sha>, path:<file>.
import type { NewTriple } from "./index.js";

export interface VerdictRecord {
  after_sha: string;
  merged_sha?: string | null;
  repo: string;
  verdict: "merge" | "reject" | "conflict";
  agent_id?: string | null;
  task_id?: string | null;
}

/** Verdict triples for one recorded push decision. */
export function verdictTriples(r: VerdictRecord): NewTriple[] {
  const triples: NewTriple[] = [
    { subject: `commit:${r.after_sha}`, predicate: "gate_verdict", object: r.verdict, source: "foundry" },
    { subject: `commit:${r.after_sha}`, predicate: "on_repo", object: `repo:${r.repo}`, source: "foundry" },
  ];
  if (r.verdict === "merge" && r.merged_sha) {
    triples.push({ subject: `commit:${r.merged_sha}`, predicate: "merged_from", object: `commit:${r.after_sha}`, source: "foundry" });
  }
  if (r.agent_id) triples.push({ subject: `commit:${r.after_sha}`, predicate: "by_agent", object: `agent:${r.agent_id}`, source: "foundry" });
  if (r.task_id) triples.push({ subject: `commit:${r.after_sha}`, predicate: "for_task", object: `task:${r.task_id}`, source: "foundry" });
  return triples;
}

/** Intake triples linking a task to its base repo and one fork. */
export function intakeTriples(taskId: string, baseRepo: string, forkRepo: string): NewTriple[] {
  return [
    { subject: `task:${taskId}`, predicate: "has_fork", object: `repo:${forkRepo}`, source: "foundry" },
    { subject: `task:${taskId}`, predicate: "on_base", object: `repo:${baseRepo}`, source: "foundry" },
  ];
}

/** Touches triples: every path the decided commit changed (merge/conflict). */
export function touchTriples(afterSha: string, files: readonly string[]): NewTriple[] {
  const seen = [...new Set(files)].sort();
  return seen.map((f) => ({
    subject: `commit:${afterSha}`,
    predicate: "touches",
    object: `path:${f}`,
    source: "foundry",
  }));
}
