// Bindings for the gate worker. Mirrors the bindings and vars declared in
// workers/gate/wrangler.toml for dev/staging/production.
//
// Committed on purpose: `wrangler types` emits an *uncommitted*
// worker-configuration.d.ts, so a clean clone (and CI) had no `Env` at all
// and `npm run typecheck` failed with "Cannot find name 'Env'". The runtime
// globals (D1Database, Artifacts, …) come from @cloudflare/workers-types.
interface Env {
  DB: D1Database;
  ARTIFACTS: Artifacts;
  ARTIFACTS_NS: "foundry-staging" | "foundry-prod" | "foundry-dev";
  // Optional integrations: set via `wrangler secret put`, never committed.
  LKG_URL?: string;
  LKG_TOKEN?: string;
  PACT_URL?: string;
  /** Required-check server (`packages/verify`, POST /api/verify). */
  VERIFY_URL?: string;
  /** When "1", a failed required check blocks the merge. Default advisory. */
  VERIFY_ENFORCE?: string;
  DEBUG?: string;
}
