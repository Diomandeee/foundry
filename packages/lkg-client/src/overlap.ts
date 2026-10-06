// Cross-task overlap oracle over the shared knowledge graph.
// Local path-diff (decide.ts step 2) sees one fork vs base; the oracle sees
// every Foundry task: a fork path ALSO touched by another task's commit is
// contention the local diff cannot observe. Best-effort: per-path failures
// use surviving paths; total outage, timeout, or unreadable scope with no
// contenders yields null (unknown) and the caller falls back to local-only.
//
// Live K11 orients 2-hop paths from the queried path (verified 2026-10-06):
//   {touches, path:P -> commit:C}, {for_task, commit:C -> task:T}.
// Fan-out is parallel: K11 answers 20 concurrent queries in ~280ms wall.
import type { KGClient, TraversalResponse } from "./index.js";

export interface OverlapInput {
  baseRepo: string;
  taskId: string;
  /** Fork-side paths (caller sorts for determinism; first 20 win). */
  paths: string[];
  /** Raw shas the caller already knows (fork + base histories). */
  knownCommits: string[];
}

export interface OverlapOracle {
  /** Contender paths, or null when the graph is unreachable/unknown. */
  findContenders(input: OverlapInput): Promise<string[] | null>;
}

export interface KgOverlapOpts {
  timeoutMs?: number;
  maxPaths?: number;
}

const COMMIT = "commit:";
const TASK = "task:";

function strip(prefix: string, s: string): string {
  return s.startsWith(prefix) ? s.slice(prefix.length) : s;
}

export class KgOverlapOracle implements OverlapOracle {
  constructor(
    private kg: KGClient,
    private opts: KgOverlapOpts = {},
  ) {}

  async findContenders(input: OverlapInput): Promise<string[] | null> {
    const paths = input.paths.slice(0, this.opts.maxPaths ?? 20);
    if (paths.length === 0) return [];
    try {
      const signal = AbortSignal.timeout(this.opts.timeoutMs ?? 2500);
      const settled = await Promise.all(
        paths.map((p) =>
          this.kg
            .traverse(`path:${p}`, 2, { direction: "both", maxResults: 50, signal })
            .then(
              (res) => ({ p, res }),
              () => ({ p, res: null }),
            ),
        ),
      );
      const ok: Array<{ p: string; res: TraversalResponse }> = [];
      for (const s of settled) {
        if (s.res) ok.push({ p: s.p, res: s.res });
      }
      if (ok.length === 0) return null; // total outage: unknown, not clean
      const known = new Set(input.knownCommits);
      const baseEntity = `repo:${input.baseRepo}`;
      const selfTask = `${TASK}${input.taskId}`;
      const scoped = new Map<string, boolean>();
      const contenders: string[] = [];
      let tainted = false;
      for (const { p, res } of ok) {
        const startEntity = `path:${p}`;
        for (const path of res.paths) {
          if (path.edges.length < 2) continue; // no task link: legacy commit
          const [e0, e1] = path.edges;
          if (e0.predicate !== "touches" || e0.subject !== startEntity) continue;
          if (!e0.object.startsWith(COMMIT)) continue;
          if (e1.predicate !== "for_task" || e1.subject !== e0.object) continue;
          if (!e1.object.startsWith(TASK) || e1.object === selfTask) continue;
          const commit = strip(COMMIT, e0.object);
          if (known.has(commit) || known.has(e0.object)) continue;
          // Same-base check: the contender's task must share our base repo.
          // Tasks without on_base predate intake scoping: fail open (skip).
          let sameBase = scoped.get(e1.object);
          if (sameBase === undefined) {
            try {
              const rows = await this.kg.query(e1.object, { signal });
              sameBase = rows.some(
                (r) => r.predicate === "on_base" && r.object === baseEntity,
              );
            } catch {
              tainted = true;
              continue;
            }
            scoped.set(e1.object, sameBase);
          }
          if (sameBase) {
            contenders.push(p);
            break;
          }
        }
      }
      if (tainted && contenders.length === 0) return null;
      return contenders;
    } catch {
      return null;
    }
  }
}
