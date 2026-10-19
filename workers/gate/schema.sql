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
  scope_json TEXT NOT NULL
);

-- Local source preparation only. Apply only with separate migration approval.
CREATE TABLE IF NOT EXISTS verification_receipts (
  sha256 TEXT PRIMARY KEY CHECK(length(sha256)=64),
  receipt TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS verification_receipts_no_update BEFORE UPDATE ON verification_receipts
BEGIN SELECT RAISE(ABORT, 'immutable verification receipt'); END;
CREATE TRIGGER IF NOT EXISTS verification_receipts_no_delete BEFORE DELETE ON verification_receipts
BEGIN SELECT RAISE(ABORT, 'immutable verification receipt'); END;
