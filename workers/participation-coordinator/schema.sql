-- Participation coordinator schema. Works on D1 (Cloudflare) and node:sqlite.
-- This is the "participation" side of the one deterministic core: identity,
-- consent, membership, admission, sources, receipts, handoffs. Append-only for
-- consent; versioned for aggregates. No table stores a client-asserted
-- proof_verified or consent-authority flag.

CREATE TABLE IF NOT EXISTS actors (
  actor_id      TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  roles_json    TEXT NOT NULL,          -- stable-sorted JSON array of Role rawValues
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  key_id        TEXT PRIMARY KEY,       -- sha256(pubkey) from the client descriptor
  actor_id      TEXT,
  algorithm     TEXT NOT NULL,          -- "p256-sha256"
  public_key_b64url TEXT NOT NULL,
  registered_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS device_sessions (
  device_session_id TEXT PRIMARY KEY,
  actor_id      TEXT,
  key_id        TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  revoked_at    TEXT
);

CREATE TABLE IF NOT EXISTS spheres (
  sphere_id         TEXT PRIMARY KEY,
  series_id         TEXT,
  organizer_actor_id TEXT NOT NULL,
  title             TEXT NOT NULL,
  summary           TEXT NOT NULL,
  starts_at         TEXT,
  capacity_remaining INTEGER,
  created_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS series (
  series_id         TEXT PRIMARY KEY,
  organizer_actor_id TEXT NOT NULL,
  title             TEXT NOT NULL,
  summary           TEXT NOT NULL,
  next_occurrence_at TEXT,
  created_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memberships (
  membership_id  TEXT PRIMARY KEY,
  sphere_id      TEXT NOT NULL,
  actor_id       TEXT NOT NULL,
  device_session_id TEXT NOT NULL,
  state          TEXT NOT NULL,         -- invited|admitted|active|left|revoked
  granted_scopes TEXT NOT NULL,         -- sorted JSON array of CapabilityScope
  admitted_at    TEXT,
  revoked_at     TEXT,
  updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS join_attempts (
  join_attempt_id  TEXT PRIMARY KEY,
  sphere_id        TEXT NOT NULL,
  reference_sha256 TEXT NOT NULL,       -- sha256 of the client-issued reference
  requested_role   TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  consumed_at      TEXT
);

CREATE TABLE IF NOT EXISTS challenges (
  challenge_id   TEXT PRIMARY KEY,
  purpose        TEXT NOT NULL,
  subject_ref_sha256 TEXT NOT NULL,
  device_session_id  TEXT NOT NULL,
  device_key_id      TEXT NOT NULL,
  challenge_b64url   TEXT NOT NULL,
  challenge_sha256   TEXT NOT NULL,
  issued_at      TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  consumed_at    TEXT,
  join_attempt_id TEXT              -- admission challenges only (bound into the signed message)
);

CREATE TABLE IF NOT EXISTS consents (          -- append-only; a new row per decision
  consent_fact_id TEXT PRIMARY KEY,
  membership_id   TEXT NOT NULL,
  purpose         TEXT NOT NULL,
  decision        TEXT NOT NULL,         -- granted|denied|revoked
  instrument_id   TEXT NOT NULL,
  instrument_version TEXT NOT NULL,
  language_sha256 TEXT NOT NULL,
  revision        INTEGER NOT NULL,
  decided_at      TEXT NOT NULL,
  valid_until     TEXT,
  supersedes_consent_fact_id TEXT,
  idempotency_key TEXT UNIQUE
);

CREATE TABLE IF NOT EXISTS consent_instruments (
  instrument_id   TEXT NOT NULL,
  version         TEXT NOT NULL,
  purpose         TEXT NOT NULL,
  locale          TEXT NOT NULL,
  language_sha256 TEXT NOT NULL,
  title           TEXT NOT NULL,
  explanation     TEXT NOT NULL,
  consequence_of_denial TEXT NOT NULL,
  PRIMARY KEY (instrument_id, version, locale)
);

CREATE TABLE IF NOT EXISTS sources (
  source_id        TEXT PRIMARY KEY,
  sphere_id        TEXT NOT NULL,
  membership_id    TEXT NOT NULL,
  device_session_id TEXT NOT NULL,
  capability_id    TEXT NOT NULL,
  label            TEXT NOT NULL,
  role             TEXT NOT NULL,
  modalities_json  TEXT NOT NULL,
  capture_state    TEXT NOT NULL,
  accepted_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS handoffs (
  reference      TEXT PRIMARY KEY,
  admission_receipt_id TEXT NOT NULL,
  server_key_id  TEXT NOT NULL,
  signature_b64url TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  consumed_at    TEXT
);

CREATE TABLE IF NOT EXISTS idempotency (
  idem_key        TEXT PRIMARY KEY,
  operation       TEXT NOT NULL,
  principal       TEXT NOT NULL,
  payload_sha256  TEXT NOT NULL,
  response_json   TEXT NOT NULL,
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (        -- why-trail; nothing deletes it
  id             TEXT PRIMARY KEY,
  at             TEXT NOT NULL,
  operation      TEXT NOT NULL,
  actor_id       TEXT,
  device_session_id TEXT,
  detail_json    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS subscriptions (
  subscription_id TEXT PRIMARY KEY,
  actor_id      TEXT NOT NULL,
  series_id     TEXT NOT NULL,
  is_active     INTEGER NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE(actor_id, series_id)
);

CREATE TABLE IF NOT EXISTS sessions (          -- full-app sessions issued by handoff/resume
  session_id        TEXT PRIMARY KEY,          -- the recoveryHandle
  admission_receipt_id TEXT NOT NULL,
  membership_id     TEXT NOT NULL,
  actor_id          TEXT NOT NULL,
  sphere_id         TEXT NOT NULL,
  device_session_id TEXT NOT NULL,
  granted_scopes    TEXT NOT NULL,
  issued_at         TEXT NOT NULL,
  expires_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admission_receipts ( -- server-side truth for issued receipts
  receipt_id     TEXT PRIMARY KEY,
  sphere_id      TEXT NOT NULL,
  actor_id       TEXT NOT NULL,
  membership_id  TEXT NOT NULL,
  device_session_id TEXT NOT NULL,
  membership_state TEXT NOT NULL,
  granted_scopes TEXT NOT NULL,
  accepted_at    TEXT NOT NULL
);
