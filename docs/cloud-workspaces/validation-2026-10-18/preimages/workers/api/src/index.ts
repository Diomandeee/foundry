import { Hono } from "hono";
import {
  checkClaim,
  recoverTask,
  type MemoryLeg,
} from "@foundry/evidence";
import type { KGClient } from "@foundry/lkg-client";
import {
  D1DecisionStore,
  D1TicketStore,
  type DecisionRecord,
  type DecisionStore,
  type TicketStore,
} from "@foundry/stores";

/**
 * Optional read-path dependencies. The decision feed works without them; the
 * spatial feed and the evidence trail name what they are missing instead of
 * failing quietly.
 */
export interface ApiDeps {
  tickets?: TicketStore;
  kg?: KGClient;
  memory?: MemoryLeg;
}

const VERDICT_LABEL: Record<DecisionRecord["verdict"], string> = {
  merge: "MERGE",
  reject: "REJECT",
  conflict: "CONFLICT",
  error: "ERROR",
};

/**
 * The decision ledger in the shape `substrate/spatial-git/index.html` fetches:
 * `{branches, commits:[{hash, fullHash, author, date, message, branch,
 * parents, files:[{path, type}], additions, deletions}]}`. Serving it here
 * means the vendored viewer can be hosted on this origin unmodified — before
 * this it fetched `git-history.json`, which only `git-to-json.sh` produced from
 * a local checkout, so the endpoint and the viewer were never joined.
 *
 * `verdict`, `proposal_sha`, `merge_sha`, `decision_id` and `task_id` ride along
 * as extra fields. The viewer ignores them; anything Foundry-aware gets the
 * authoritative outcome without re-deriving it from git history.
 *
 * One commit per decision, oldest first, grouped by repo (the viewer's branch
 * axis) because a fork is the meaningful lane in a multi-agent run. A refusal
 * keeps its own identity — `hash` is the proposal sha, not a merge sha, and
 * `merge_sha` is null — so the view can never imply it entered the base.
 */
export function spatialFeed(rows: DecisionRecord[]) {
  const commits = [...rows]
    .sort(
      (a, b) =>
        a.decided_at.localeCompare(b.decided_at) || (a.id ?? 0) - (b.id ?? 0),
    )
    .map((r) => {
      const landed = r.verdict === "merge" ? r.merged_sha : null;
      const sha = landed ?? r.after_sha;
      const branch = r.ref.startsWith("refs/heads/")
        ? r.ref.slice("refs/heads/".length)
        : r.ref;
      const reason = r.reason as { reason?: string } | null | undefined;
      return {
        hash: sha.slice(0, 8),
        fullHash: sha,
        author: r.agent_id ?? "foundry",
        date: r.decided_at,
        message:
          `${VERDICT_LABEL[r.verdict]} ${branch}` +
          (reason?.reason ? ` · ${reason.reason}` : ""),
        branch: r.repo,
        parents: [r.before_sha],
        files: (r.files ?? []).map((path) => ({ path, type: "modified" })),
        additions: 0,
        deletions: 0,
        verdict: r.verdict,
        proposal_sha: r.after_sha,
        merge_sha: landed,
        decision_id: r.id ?? null,
        task_id: r.task_id ?? null,
      };
    });
  return {
    branches: [...new Set(rows.map((r) => r.repo))].sort(),
    commits,
  };
}

const BOARD = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Foundry — decisions</title>
<style>
  :root { color-scheme: dark; }
  body { background: #0b0b10; color: #f4f1ea; font: 15px/1.5 -apple-system, "SF Pro Text", Inter, Helvetica, Arial, sans-serif; margin: 0; }
  main { max-width: 1100px; margin: 0 auto; padding: 40px 24px 80px; }
  h1 { font-size: 28px; font-weight: 800; letter-spacing: -0.5px; margin: 0 0 4px; }
  h1 span { color: #f59e0b; }
  p.sub { color: #8b8b98; margin: 0 0 28px; font-size: 14px; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th { text-align: left; font-weight: 600; color: #8b8b98; font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; padding: 8px 12px; border-bottom: 1px solid #26262f; }
  td { padding: 10px 12px; border-bottom: 1px solid #1a1a22; vertical-align: top; }
  tr:hover td { background: #101016; }
  .mono { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 13px; }
  .chip { display: inline-block; padding: 2px 10px; border-radius: 4px; font-weight: 700; font-size: 12px; letter-spacing: 0.04em; }
  .merge { background: #14532d; color: #4ade80; }
  .reject { background: #450a0a; color: #f87171; }
  .conflict { background: #451a03; color: #fbbf24; }
  /* an unfinished attempt: infrastructure, not a verdict */
  .error { background: #1e1b4b; color: #a5b4fc; }
  a { color: #f59e0b; text-decoration: none; }
  a:hover { text-decoration: underline; }
  #status { color: #8b8b98; font-size: 13px; margin-top: 16px; }
</style>
</head>
<body>
<main>
  <h1>Foundry <span>decisions</span></h1>
  <p class="sub">Every push gets a verdict. Newest first, refreshes every 5 seconds.</p>
  <table>
    <thead><tr><th>#</th><th>Repo</th><th>Verdict</th><th>After</th><th>Merged</th><th>Files / reason</th><th>Decided</th></tr></thead>
    <tbody id="rows"><tr><td colspan="7">loading…</td></tr></tbody>
  </table>
  <p id="status"></p>
</main>
<script>
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
async function load() {
  try {
    const r = await fetch("./decisions?limit=50");
    const { decisions } = await r.json();
    const tb = document.getElementById("rows");
    tb.innerHTML = decisions.map((d) => {
      const detail = d.files && d.files.length
        ? d.files.map((f) => "<div class=\\"mono\\">" + esc(f) + "</div>").join("")
        : esc(d.reason ? d.reason.message || d.reason.reason : "");
      return "<tr><td class=\\"mono\\">" + d.id + "</td>" +
        "<td class=\\"mono\\">" + esc(d.repo) + "</td>" +
        "<td><span class=\\"chip " + d.verdict + "\\">" + d.verdict.toUpperCase() + "</span></td>" +
        "<td class=\\"mono\\"><a href=\\"./why/" + d.after_sha.slice(0, 12) + "\\">" + d.after_sha.slice(0, 8) + "</a></td>" +
        "<td class=\\"mono\\">" + (d.merged_sha ? d.merged_sha.slice(0, 8) : "—") + "</td>" +
        "<td>" + detail + "</td>" +
        "<td class=\\"mono\\">" + (d.decided_at || "").replace("T", " ").slice(0, 19) + "</td></tr>";
    }).join("") || "<tr><td colspan=\\"7\\">no decisions yet</td></tr>";
    document.getElementById("status").textContent =
      decisions.length + " decisions · updated " + new Date().toLocaleTimeString();
  } catch (e) {
    document.getElementById("status").textContent = "fetch failed: " + e;
  }
}
load();
setInterval(load, 5000);
</script>
</body>
</html>`;

export function createApi(store: DecisionStore, deps: ApiDeps = {}) {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true, worker: "api" }));
  app.get("/", (c) => c.html(BOARD));

  app.get("/decisions", async (c) => {
    const repo = c.req.query("repo") || undefined;
    const limit = Math.min(
      Math.max(parseInt(c.req.query("limit") ?? "50", 10) || 50, 1),
      200,
    );
    return c.json({ decisions: await store.list(repo, limit) });
  });

  app.get("/why/:sha", async (c) => {
    const prefix = c.req.param("sha");
    if (!/^[0-9a-f]{4,40}$/i.test(prefix)) {
      return c.json({ error: "invalid sha prefix" }, 400);
    }
    // Prefix lookup: scan recent rows (D1 has no prefix index; limit 200).
    const rows = await store.list(undefined, 200);
    const hit =
      rows.find(
        (r) =>
          r.after_sha.startsWith(prefix) ||
          (r.merged_sha ?? "").startsWith(prefix),
      ) ?? (prefix.length >= 40 ? await store.findBySha(prefix) : null);
    if (!hit) return c.json({ error: "no decision for sha" }, 404);
    return c.json({ decision: hit });
  });

  // Machine feed for the Spatial Git view (substrate/spatial-git).
  // Paging happens in the database (id cursor), so history older than the
  // first page stays reachable: the feed used to read 200 rows and page
  // inside those, silently truncating everything past row 200.
  //
  // A proposal and the commit that landed are different identifiers, and a
  // refused proposal has no merge sha at all. `sha` is kept for existing
  // consumers; both halves are named explicitly beside it.
  app.get("/history.json", async (c) => {
    const repo = c.req.query("repo") || undefined;
    const limit = Math.min(
      Math.max(parseInt(c.req.query("limit") ?? "50", 10) || 50, 1),
      200,
    );
    const rawCursor = c.req.query("cursor") ?? "";
    const cursor = parseInt(rawCursor, 10);
    if (rawCursor !== "" && !(cursor > 0)) {
      return c.json({ error: "cursor must be a positive decision id" }, 400);
    }
    // One row past the page: its presence is what "more history" means, which
    // also stops the last full page from advertising another one.
    const rows = await store.listPage({
      repo,
      beforeId: cursor > 0 ? cursor : undefined,
      limit: limit + 1,
    });
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    return c.json({
      commits: page.map((r) => ({
        sha: r.merged_sha ?? r.after_sha,
        proposal_sha: r.after_sha,
        merge_sha: r.merged_sha ?? null,
        verdict: r.verdict,
        repo: r.repo,
        files: r.files ?? [],
        decided_at: r.decided_at,
      })),
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
    });
  });

  // The vendored Spatial Git viewer fetches this exact path. Same rows as
  // /history.json, rendered in the viewer's schema (see `spatialFeed`).
  app.get("/git-history.json", async (c) => {
    const repo = c.req.query("repo") || undefined;
    const limit = Math.min(
      Math.max(parseInt(c.req.query("limit") ?? "200", 10) || 200, 1),
      500,
    );
    const rows = await store.list(repo, limit);
    return c.json({
      ...spatialFeed(rows),
      // The viewer reads one shot and stops; say so rather than let a full
      // page look like the whole history.
      truncated: rows.length >= limit,
    });
  });

  // Evidence recovery: the read path that reconstructs why a task's decisions
  // exist (`packages/evidence`). Unconfigured is 503 with the missing leg
  // named — never a 200 with an empty chain, which would read as "no evidence
  // needed" rather than "not wired".
  app.get("/evidence/:taskId", async (c) => {
    if (!deps.tickets) {
      return c.json(
        { error: "evidence read path not configured: no ticket store" },
        503,
      );
    }
    const taskId = c.req.param("taskId");
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(taskId)) {
      return c.json({ error: "invalid task id" }, 400);
    }
    const chain = await recoverTask(
      {
        tickets: deps.tickets,
        decisions: store,
        kg: deps.kg,
        memory: deps.memory,
      },
      taskId,
    );
    const claim = checkClaim(chain);
    // 404 when nothing at all was recovered; 200 with `gaps` when the chain is
    // partial — a partial chain is real information, and it is labelled.
    return c.json({ ...chain, claim }, chain.unrecoverable ? 404 : 200);
  });

  return app;
}

export default {
  fetch: (req: Request, env: { DB: D1Database }) =>
    createApi(new D1DecisionStore(env.DB), {
      // Same D1 database holds tickets; the evidence trail reads from it.
      tickets: new D1TicketStore(env.DB),
    }).fetch(req),
};
