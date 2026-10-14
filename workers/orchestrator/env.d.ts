// Bindings for the orchestrator worker. Mirrors the bindings and vars
// declared in workers/orchestrator/wrangler.toml.
//
// Committed on purpose: `wrangler types` emits an *uncommitted*
// worker-configuration.d.ts, so a clean clone (and CI) had no `Env` at all
// and `npm run typecheck` failed with "Cannot find name 'Env'". The runtime
// globals (D1Database, Artifacts, …) come from @cloudflare/workers-types.
interface Env {
  DB: D1Database;
  ARTIFACTS: Artifacts;
  // Required by POST /tasks (Bearer). Route fails closed with 503 when unset.
  TASK_TOKEN?: string;
  // Optional integrations: set via `wrangler secret put`, never committed.
  LKG_URL?: string;
  LKG_TOKEN?: string;
  PACT_URL?: string;
}
