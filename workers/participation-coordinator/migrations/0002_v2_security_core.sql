-- v2 security core (2026-10-22). Apply once to a v1 database:
--   wrangler d1 execute participation --remote --file migrations/0002_v2_security_core.sql
-- (or statement by statement through tools/d1-apply.sh if the database refuses files).
ALTER TABLE challenges ADD COLUMN recovery_grant_id TEXT;
ALTER TABLE join_attempts ADD COLUMN invitation_id TEXT;
ALTER TABLE join_attempts ADD COLUMN device_key_id TEXT;
CREATE TABLE IF NOT EXISTS invitations (
  invitation_id   TEXT PRIMARY KEY,
  sphere_id       TEXT NOT NULL,
  organizer_actor_id TEXT NOT NULL,
  role            TEXT NOT NULL,
  scopes_json     TEXT NOT NULL,
  reference_sha256 TEXT NOT NULL UNIQUE,
  max_uses        INTEGER NOT NULL,
  used_count      INTEGER NOT NULL DEFAULT 0,
  expires_at      TEXT NOT NULL,
  revoked_at      TEXT,
  created_at      TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS recovery_grants (
  grant_id        TEXT PRIMARY KEY,
  actor_id        TEXT NOT NULL,
  secret_sha256   TEXT NOT NULL UNIQUE,
  issued_by_kind  TEXT NOT NULL,
  issued_by_ref   TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  consumed_at     TEXT,
  created_at      TEXT NOT NULL
);
