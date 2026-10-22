// v2 security core (security review 2026-10-22, C1 and its neighbours).
//
// The rules this module enforces, in one place so the operations layer cannot
// drift from them:
//
//   1. A device key is INSERT-ONLY. A key id is the sha256 of the presented
//      public key, and once a key is registered its public key never changes.
//      Re-registering with different bytes is `device_key_conflict`.
//   2. A caller may only introduce the key it holds: with a device-bound bearer,
//      `payload.deviceKey.keyID` must equal the bearer's `dk`.
//   3. Joining an existing actor (recovery) needs a RECOVERY GRANT: a single-use,
//      short-lived secret issued either by a device already bound to that actor
//      ("vouch") or by the operator path. Nothing resolves an actor by name.
//   4. Admission needs a server-issued INVITATION: the organizer mints it, the
//      server stores only its hash, and the scopes come from the invitation.
//   5. Every mutation leaves an audit row.
//   6. Expired challenges, nonces and grants are garbage-collected.
import { Db } from "./store.js";
import { OpError } from "./errors.js";
import { b64url, b64urlDecode, sha256hex, uuid } from "./ids.js";
import { iso } from "./canonical.js";

export interface DeviceKeyDescriptor {
  keyID: string;
  algorithm: string;
  publicKeyBase64URL: string;
}

const boundedASCII = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= 192 && /^[\x21-\x7e]+$/.test(v);

/** Shape + key-id binding. Throws a stable code on any failure. */
export async function validateDeviceKey(deviceKey: any): Promise<DeviceKeyDescriptor> {
  if (!deviceKey || !boundedASCII(deviceKey.keyID) || !boundedASCII(deviceKey.publicKeyBase64URL))
    throw new OpError("bad_device_key", "Missing or malformed device key.");
  if (deviceKey.algorithm !== "p256-sha256")
    throw new OpError("unsupported_algorithm", "Only p256-sha256 device keys are accepted.");
  let pub: Uint8Array<ArrayBuffer>;
  try { pub = b64urlDecode(deviceKey.publicKeyBase64URL); } catch { throw new OpError("bad_device_key", "Device key is not base64url."); }
  if (pub.length !== 65 || pub[0] !== 0x04)
    throw new OpError("bad_device_key", "Device key is not an uncompressed P-256 point.");
  if ((await sha256hex(pub)) !== deviceKey.keyID)
    throw new OpError("key_id_mismatch", "Device key id is not the hash of the presented key.");
  return { keyID: deviceKey.keyID, algorithm: deviceKey.algorithm, publicKeyBase64URL: deviceKey.publicKeyBase64URL };
}

export interface DeviceRow {
  key_id: string;
  actor_id: string | null;
  algorithm: string;
  public_key_b64url: string;
  registered_at: string;
}

/**
 * Insert-only registration. Never updates an existing row: a second
 * registration must present the same public key or it is refused.
 */
export async function registerDeviceInsertOnly(db: Db, deviceKey: any, now: string): Promise<DeviceRow> {
  const k = await validateDeviceKey(deviceKey);
  await db.run(
    `INSERT INTO devices (key_id,actor_id,algorithm,public_key_b64url,registered_at) VALUES (?,?,?,?,?)
     ON CONFLICT(key_id) DO NOTHING`,
    [k.keyID, null, k.algorithm, k.publicKeyBase64URL, now]);
  const row = await db.get<DeviceRow>(`SELECT * FROM devices WHERE key_id=?`, [k.keyID]);
  if (!row) throw new OpError("internal", "Device registration did not persist.");
  if (row.public_key_b64url !== k.publicKeyBase64URL || row.algorithm !== k.algorithm)
    throw new OpError("device_key_conflict", "A different public key is already registered under this key id.");
  return row;
}

/** With a device-bound bearer, the caller may only act for the key it holds. */
export function requireOwnKey(bearerKeyId: string | undefined, keyID: unknown): void {
  if (bearerKeyId === undefined) return; // dev/test auth carries no device key
  if (keyID !== bearerKeyId)
    throw new OpError("key_not_bearer", "The device key in the payload is not the key that minted this bearer.");
}

/** Bind a device (and its session) to an actor; refuse if it belongs to another actor. */
export async function bindDeviceToActor(db: Db, keyID: string, deviceSessionId: string | null, actorId: string): Promise<void> {
  const dev = await db.get<DeviceRow>(`SELECT * FROM devices WHERE key_id=?`, [keyID]);
  if (!dev) throw new OpError("unknown_device", "Device key is not registered.");
  if (dev.actor_id && dev.actor_id !== actorId)
    throw new OpError("device_bound_elsewhere", "This device key is already bound to another actor.");
  if (!dev.actor_id) await db.run(`UPDATE devices SET actor_id=? WHERE key_id=? AND actor_id IS NULL`, [actorId, keyID]);
  if (deviceSessionId)
    await db.run(`UPDATE device_sessions SET actor_id=? WHERE device_session_id=? AND key_id=?`, [actorId, deviceSessionId, keyID]);
}

// ---- audit ------------------------------------------------------------------

export async function audit(
  db: Db, now: string, operation: string, actorId: string | null, deviceSessionId: string | null, detail: Record<string, unknown>,
): Promise<void> {
  await db.run(
    `INSERT INTO audit_log (id,at,operation,actor_id,device_session_id,detail_json) VALUES (?,?,?,?,?,?)`,
    [uuid(), now, operation, actorId, deviceSessionId, JSON.stringify(detail)]);
}

// ---- recovery grants --------------------------------------------------------

export const RECOVERY_GRANT_TTL_SECONDS = 10 * 60;
export const RECOVERY_GRANT_MAX_TTL_SECONDS = 60 * 60;
const SECRET_PREFIX = "mmrg1";

export interface IssuedGrant {
  grantID: string;
  actorID: string;
  recoverySecret: string;
  expiresAt: string;
  issuedBy: "device" | "operator";
}

function clampTtl(requested: unknown, dflt: number, max: number): number {
  const n = typeof requested === "number" && Number.isFinite(requested) ? Math.floor(requested) : dflt;
  return Math.max(30, Math.min(max, n));
}

/**
 * Mint a single-use recovery grant for an actor. The secret leaves the server
 * exactly once (in this return value); only its hash is stored.
 */
export async function issueRecoveryGrant(
  db: Db, actorId: string, issuedBy: "device" | "operator", issuedByRef: string, now: string, ttlSeconds?: number,
): Promise<IssuedGrant> {
  const actor = await db.get<{ actor_id: string }>(`SELECT actor_id FROM actors WHERE actor_id=?`, [actorId]);
  if (!actor) throw new OpError("unknown_actor", "No such actor.");
  const ttl = clampTtl(ttlSeconds, RECOVERY_GRANT_TTL_SECONDS, RECOVERY_GRANT_MAX_TTL_SECONDS);
  const secret = `${SECRET_PREFIX}.${b64url(crypto.getRandomValues(new Uint8Array(32)))}`;
  const grantID = uuid();
  const expiresAt = iso(new Date(new Date(now).getTime() + ttl * 1000));
  await db.run(
    `INSERT INTO recovery_grants (grant_id,actor_id,secret_sha256,issued_by_kind,issued_by_ref,expires_at,consumed_at,created_at)
     VALUES (?,?,?,?,?,?,NULL,?)`,
    [grantID, actorId, await sha256hex(secret), issuedBy, issuedByRef, expiresAt, now]);
  return { grantID, actorID: actorId, recoverySecret: secret, expiresAt, issuedBy };
}

export interface GrantRow {
  grant_id: string;
  actor_id: string;
  secret_sha256: string;
  issued_by_kind: string;
  issued_by_ref: string;
  expires_at: string;
  consumed_at: string | null;
  created_at: string;
}

/** Resolve a presented secret to a live (unconsumed, unexpired) grant. */
export async function resolveRecoveryGrant(db: Db, secret: unknown, now: string): Promise<GrantRow> {
  if (!boundedASCII(secret) || !secret.startsWith(`${SECRET_PREFIX}.`))
    throw new OpError("recovery_grant_required", "Account recovery requires a recovery grant.");
  const row = await db.get<GrantRow>(`SELECT * FROM recovery_grants WHERE secret_sha256=?`, [await sha256hex(secret)]);
  if (!row) throw new OpError("recovery_grant_invalid", "Recovery grant does not resolve.");
  return assertGrantLive(row, now);
}

export function assertGrantLive(row: GrantRow, now: string): GrantRow {
  if (row.consumed_at) throw new OpError("recovery_grant_consumed", "Recovery grant already used.");
  if (new Date(row.expires_at).getTime() < new Date(now).getTime())
    throw new OpError("recovery_grant_expired", "Recovery grant expired.");
  return row;
}

// ---- invitations ------------------------------------------------------------

export const INVITATION_TTL_SECONDS = 24 * 3600;
export const INVITATION_MAX_TTL_SECONDS = 30 * 24 * 3600;
export const INVITATION_MAX_USES = 500;
export const JOIN_LINK_HOST = "join.motionmix.app";

/** Scopes an invitation may carry, by role. The organizer role is never invited. */
export const ROLE_SCOPES: Record<string, string[]> = {
  participant: ["admission", "media_publish", "playback", "upload"],
  viewer: ["admission", "playback"],
};

export interface InvitationRow {
  invitation_id: string;
  sphere_id: string;
  organizer_actor_id: string;
  role: string;
  scopes_json: string;
  reference_sha256: string;
  max_uses: number;
  used_count: number;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
}

export interface IssuedInvitation {
  invitationID: string;
  sphereID: string;
  role: string;
  grantedScopes: string[];
  reference: string;
  expiresAt: string;
  maxUses: number;
  url: string;
}

const sorted = (xs: string[]) => [...new Set(xs)].sort();

export async function createInvitation(
  db: Db, sphereId: string, organizerActorId: string, now: string,
  opts: { role?: unknown; scopes?: unknown; maxUses?: unknown; ttlSeconds?: unknown },
): Promise<IssuedInvitation> {
  const role = typeof opts.role === "string" ? opts.role : "participant";
  const allowed = ROLE_SCOPES[role];
  if (!allowed) throw new OpError("invalid_role", "Invitations may carry the participant or viewer role only.");
  let scopes = allowed;
  if (opts.scopes !== undefined) {
    if (!Array.isArray(opts.scopes) || !opts.scopes.every((s) => typeof s === "string" && allowed.includes(s)))
      throw new OpError("invalid_scopes", "Requested scopes exceed what the role allows.");
    if (!opts.scopes.includes("admission")) throw new OpError("invalid_scopes", "An invitation must grant admission.");
    scopes = opts.scopes as string[];
  }
  const maxUses = typeof opts.maxUses === "number" && Number.isInteger(opts.maxUses)
    ? Math.max(1, Math.min(INVITATION_MAX_USES, opts.maxUses)) : 1;
  const ttl = clampTtl(opts.ttlSeconds, INVITATION_TTL_SECONDS, INVITATION_MAX_TTL_SECONDS);
  const reference = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const invitationID = uuid();
  const expiresAt = iso(new Date(new Date(now).getTime() + ttl * 1000));
  const granted = sorted(scopes);
  await db.run(
    `INSERT INTO invitations (invitation_id,sphere_id,organizer_actor_id,role,scopes_json,reference_sha256,max_uses,used_count,expires_at,revoked_at,created_at)
     VALUES (?,?,?,?,?,?,?,0,?,NULL,?)`,
    [invitationID, sphereId, organizerActorId, role, JSON.stringify(granted), await sha256hex(reference), maxUses, expiresAt, now]);
  const url = `https://${JOIN_LINK_HOST}/s/${encodeURIComponent(sphereId)}?j=${reference}&r=${role}`;
  return { invitationID, sphereID: sphereId, role, grantedScopes: granted, reference, expiresAt, maxUses, url };
}

/** Resolve a presented join reference to a live invitation for the given sphere. */
export async function resolveInvitation(db: Db, reference: unknown, sphereId: unknown, now: string): Promise<InvitationRow> {
  if (!boundedASCII(reference) || reference.length < 16)
    throw new OpError("invitation_required", "Admission requires a server-issued invitation.");
  const row = await db.get<InvitationRow>(`SELECT * FROM invitations WHERE reference_sha256=?`, [await sha256hex(reference)]);
  if (!row) throw new OpError("unknown_invitation", "Invitation does not resolve.");
  if (row.sphere_id !== sphereId) throw new OpError("invitation_sphere_mismatch", "Invitation is for a different Sphere.");
  return assertInvitationLive(row, now);
}

export function assertInvitationLive(row: InvitationRow, now: string): InvitationRow {
  if (row.revoked_at) throw new OpError("invitation_revoked", "Invitation was revoked.");
  if (new Date(row.expires_at).getTime() < new Date(now).getTime())
    throw new OpError("invitation_expired", "Invitation expired.");
  if (row.used_count >= row.max_uses) throw new OpError("invitation_exhausted", "Invitation has no uses left.");
  return row;
}

// ---- garbage collection -----------------------------------------------------

export interface GcReport { nonces: number; challenges: number; grants: number; invitations: number }

/**
 * Remove rows that can never be used again. Consent, memberships, receipts,
 * sessions and the audit log are never touched.
 */
export async function gcExpired(db: Db, now: string): Promise<GcReport> {
  const t = new Date(now).getTime();
  const dayAgo = iso(new Date(t - 24 * 3600 * 1000));
  const monthAgo = iso(new Date(t - 30 * 24 * 3600 * 1000));
  const count = async (sql: string, p: unknown[]) => Number((await db.get<{ n: number }>(sql, p))?.n ?? 0);
  const nonces = await count(`SELECT count(*) n FROM token_nonces WHERE issued_at < ?`, [dayAgo]);
  await db.run(`DELETE FROM token_nonces WHERE issued_at < ?`, [dayAgo]);
  const challenges = await count(`SELECT count(*) n FROM challenges WHERE expires_at < ?`, [dayAgo]);
  await db.run(`DELETE FROM challenges WHERE expires_at < ?`, [dayAgo]);
  const grants = await count(`SELECT count(*) n FROM recovery_grants WHERE expires_at < ? OR consumed_at < ?`, [dayAgo, dayAgo]);
  await db.run(`DELETE FROM recovery_grants WHERE expires_at < ? OR consumed_at < ?`, [dayAgo, dayAgo]);
  const invitations = await count(`SELECT count(*) n FROM invitations WHERE expires_at < ?`, [monthAgo]);
  await db.run(`DELETE FROM invitations WHERE expires_at < ?`, [monthAgo]);
  return { nonces, challenges, grants, invitations };
}

/** Constant-time equality for bearer digests. */
export function digestEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
