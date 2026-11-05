-- Foundry decisions ledger (D1). Created at Paid-spike time via:
--   wrangler d1 create foundry-decisions
-- + `wrangler d1 execute foundry-decisions --file=workers/gate/schema.sql`
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  namespace TEXT NOT NULL,
  repo TEXT NOT NULL,
  ref TEXT NOT NULL,
  before_sha TEXT NOT NULL,
  after_sha TEXT NOT NULL,
  verdict TEXT NOT NULL,          -- merge | reject | conflict
  reason TEXT,                    -- JSON RejectReason when reject
  conflict_files TEXT,            -- JSON string[] when conflict
  files TEXT,                     -- JSON string[] touched on merge/conflict
  merged_sha TEXT,                -- merge commit sha when verdict=merge
  task_id TEXT,
  agent_id TEXT,
  decided_at TEXT NOT NULL,
  -- JSON VerificationReceipt for the admitted proposal, including an explicit
  -- unchecked outcome when no verifier is configured. Historical rows can be
  -- null or contain the earlier verdict shape. Databases lacking this column
  -- need a separately approved migration; CREATE TABLE IF NOT EXISTS does not
  -- upgrade them: `ALTER TABLE decisions ADD COLUMN verification TEXT;`
  verification TEXT
);
CREATE INDEX IF NOT EXISTS idx_decisions_repo ON decisions (namespace, repo);
CREATE INDEX IF NOT EXISTS idx_decisions_verdict ON decisions (verdict);
-- One decision per push event: redelivery is a no-op (INSERT OR IGNORE).
CREATE UNIQUE INDEX IF NOT EXISTS idx_decisions_event
  ON decisions (namespace, repo, ref, before_sha, after_sha);

CREATE TABLE IF NOT EXISTS tickets (
  task_id TEXT NOT NULL,
  base_repo TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  fork_repo TEXT NOT NULL PRIMARY KEY,
  agent_id TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  -- JSON string[] of the PACT chains the task declared (POST /tasks `chains`); null when none.
  -- The gate's plan check (decide.ts step 1b) reads it. Databases lacking this column need a
  -- separately approved migration: `ALTER TABLE tickets ADD COLUMN chains_json TEXT;`
  -- D1TicketStore writes it only for a ticket with chains, so an unmigrated ledger keeps
  -- taking every task that declares none.
  chains_json TEXT
);

-- Applied to foundry-decisions-staging 2026-11-03 (with decisions.verification) before gate 33a0b98c.
CREATE TABLE IF NOT EXISTS verification_receipts (
  sha256 TEXT PRIMARY KEY CHECK(length(sha256)=64),
  receipt TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS verification_receipts_no_update BEFORE UPDATE ON verification_receipts
BEGIN SELECT RAISE(ABORT, 'immutable verification receipt'); END;
CREATE TRIGGER IF NOT EXISTS verification_receipts_no_delete BEFORE DELETE ON verification_receipts
BEGIN SELECT RAISE(ABORT, 'immutable verification receipt'); END;

-- Build/test jobs planned from gate merges (tools/foundry-job). Proposed 2026-11-01;
-- apply only with separate migration approval. One row per (merged_sha, profile_hash):
-- re-planning a merge is a no-op, a changed recipe is a new job. The verified result
-- stays in the compute authority (build_receipts, immutable); this row mirrors its
-- outcome and the manifest hash so the ledger can answer "did this merge build".
CREATE TABLE IF NOT EXISTS build_jobs (
  job_id TEXT PRIMARY KEY,
  decision_id INTEGER NOT NULL,      -- decisions.id of the MERGE
  base_repo TEXT NOT NULL,
  merged_sha TEXT NOT NULL CHECK(length(merged_sha)=40),
  profile_hash TEXT NOT NULL CHECK(length(profile_hash)=64),
  input_hash TEXT CHECK(input_hash IS NULL OR length(input_hash)=64),
  environment TEXT NOT NULL,         -- compute authority environment, e.g. staging
  authority_id TEXT,
  state TEXT NOT NULL CHECK(state IN ('planned','input-approved','submitted','running','succeeded','failed','cancelled')),
  attempt_id TEXT,
  exit_code INTEGER,
  manifest_sha256 TEXT CHECK(manifest_sha256 IS NULL OR length(manifest_sha256)=64),
  verifier TEXT,
  planned_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (merged_sha, profile_hash)
);
CREATE INDEX IF NOT EXISTS idx_build_jobs_base ON build_jobs (base_repo, state);
