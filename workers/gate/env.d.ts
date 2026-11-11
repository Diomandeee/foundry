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
  /** Workers VPC binding to the private pact-server; PACT_URL is then fetched through it. */
  PACT_SERVICE?: Fetcher;
  /** When "1", a declared chain that is unknown or does not typecheck rejects the merge. */
  PACT_ENFORCE?: string;
  /** Required-check server (`packages/verify`, POST /api/verify). */
  VERIFY_URL?: string;
  /** When "1", a failed required check blocks the merge. Default advisory. */
  VERIFY_ENFORCE?: string;
  VERIFY_REQUIRE_CHECKED?: string;
  /** How long to wait for the verifier, in ms (default 120000, capped at 840000). */
  VERIFY_TIMEOUT_MS?: string;
  /** Workers VPC binding to a private verifier; VERIFY_URL is then fetched through it. */
  VERIFY_SERVICE?: Fetcher;
  DEBUG?: string;
}
