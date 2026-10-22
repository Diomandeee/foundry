// Participation coordinator operations — the participation-side deterministic
// core. Pure over (Db, ServerKey). Every durable mutation is idempotency-bound
// to (principal, operation, payload sha256). Consent is append-only. The server
// never trusts a client-asserted proof/consent-authority flag.
//
// v2 (security review 2026-10-22): device keys are insert-only and must be the
// bearer's own key; recovery needs a single-use grant (vouched by a bound device
// or issued by the operator); admission needs a server-issued invitation whose
// scopes the server applies; membership is checked against the authenticated
// principal; every mutation is audited. See src/security.ts.
import { Db } from "./store.js";
import { ServerKey, verifyDeviceProof } from "./crypto.js";
import { b64url, b64urlDecode, sha256hex, uuid } from "./ids.js";
import { possessionSubjectSHA256, joinAttemptSubjectSHA256, possessionProofMessage, admissionProofMessage, challengeBytesSHA256 } from "./proof.js";
import { iso } from "./canonical.js";
import { OpError } from "./errors.js";
import {
  audit, assertGrantLive, assertInvitationLive, bindDeviceToActor, createInvitation, GrantRow, InvitationRow,
  issueRecoveryGrant, registerDeviceInsertOnly, requireOwnKey, resolveInvitation, resolveRecoveryGrant,
} from "./security.js";

export { OpError } from "./errors.js";

export interface Req {
  operation: string;
  payload: any;
  principal: string;             // authenticated actor/device from the bearer
  /** The P-256 key id the bearer was minted for (absent under dev/test auth). */
  deviceKeyId?: string;
  deviceSessionId?: string;
  now: string;                   // ISO, passed in for deterministic tests
}

const TTL_MS = 5 * 60 * 1000;
const HANDOFF_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

const sorted = (arr: string[]) => [...new Set(arr)].sort();

// ---- helpers --------------------------------------------------------------

async function baseNonce(): Promise<string> {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

async function issueChallenge(
  db: Db, purpose: string, subjectSha: string, deviceSessionId: string,
  deviceKeyId: string, now: string, joinAttemptId: string | null = null, recoveryGrantId: string | null = null,
): Promise<any> {
  const challenge = await baseNonce();
  // The client verifies sha256(decode(challengeBase64URL)) == challengeSHA256 and
  // binds that hash into the signed message, so it must hash the raw bytes.
  const challengeSha = await challengeBytesSHA256(challenge);
  const challengeId = await sha256hex(`${purpose}:${subjectSha}:${challenge}`);
  const expiresAt = iso(new Date(new Date(now).getTime() + TTL_MS));
  await db.run(
    `INSERT INTO challenges (challenge_id,purpose,subject_ref_sha256,device_session_id,device_key_id,challenge_b64url,challenge_sha256,issued_at,expires_at,consumed_at,join_attempt_id,recovery_grant_id)
     VALUES (?,?,?,?,?,?,?,?,?,NULL,?,?)`,
    [challengeId, purpose, subjectSha, deviceSessionId, deviceKeyId, challenge, challengeSha, now, expiresAt, joinAttemptId, recoveryGrantId],
  );
  return {
    challengeID: challengeId,
    purpose,
    subjectReferenceSHA256: subjectSha,
    deviceSessionID: deviceSessionId,
    deviceKeyID: deviceKeyId,
    challengeBase64URL: challenge,
    challengeSHA256: challengeSha,
    issuedAt: now,
    expiresAt,
  };
}

/**
 * Verify a device proof against the challenge it names, consuming it once.
 * The challenge is looked up by id and must match the purpose and subject the
 * operation expects, so a proof for one purpose can never satisfy another.
 */
async function consumeProof(
  db: Db, req: Req, purpose: string, subjectSha: string | null, proof: any,
): Promise<any> {
  if (typeof proof?.challengeID !== "string") throw new OpError("no_challenge", "Proof names no challenge.");
  const ch: any = await db.get(`SELECT * FROM challenges WHERE challenge_id=?`, [proof.challengeID]);
  if (!ch) throw new OpError("no_challenge", "Unknown challenge.");
  if (ch.purpose !== purpose) throw new OpError("challenge_mismatch", "Proof references a challenge for another purpose.");
  if (subjectSha !== null && ch.subject_ref_sha256 !== subjectSha)
    throw new OpError("challenge_mismatch", "Proof references a challenge for another subject.");
  if (ch.consumed_at) throw new OpError("challenge_consumed", "Challenge already used.");
  if (new Date(ch.expires_at).getTime() < new Date(req.now).getTime())
    throw new OpError("challenge_expired", "Challenge expired.");
  if (proof?.keyID !== ch.device_key_id)
    throw new OpError("key_mismatch", "Proof key does not match the challenge key.");
  requireOwnKey(req.deviceKeyId, ch.device_key_id);
  const dev: any = await db.get(`SELECT * FROM devices WHERE key_id=?`, [ch.device_key_id]);
  if (!dev) throw new OpError("unknown_device", "Device key is not registered.");
  // Rebuild the domain-separated, length-prefixed message the iOS client signed.
  const challengeBytes = b64urlDecode(ch.challenge_b64url);
  const common = {
    challengeID: ch.challenge_id,
    deviceSessionID: ch.device_session_id,
    deviceKeyID: ch.device_key_id,
    challengeSHA256: ch.challenge_sha256,
  };
  const message = purpose === "admission"
    ? admissionProofMessage({ ...common, joinAttemptID: ch.join_attempt_id ?? "", joinAttemptReferenceSHA256: ch.subject_ref_sha256 }, challengeBytes)
    : possessionProofMessage({ ...common, purpose: ch.purpose, subjectReferenceSHA256: ch.subject_ref_sha256 }, challengeBytes);
  const ok = await verifyDeviceProof(dev.public_key_b64url, message, proof?.signatureDERBase64URL);
  if (!ok) throw new OpError("proof_invalid", "Device possession proof failed.");
  await db.run(`UPDATE challenges SET consumed_at=? WHERE challenge_id=?`, [req.now, ch.challenge_id]);
  return ch;
}

async function idempotent<T>(
  db: Db, req: Req, key: string | undefined, produce: () => Promise<T>,
): Promise<T> {
  if (!key) return produce();
  const payloadSha = await sha256hex(JSON.stringify(req.payload));
  const prior: any = await db.get(`SELECT * FROM idempotency WHERE idem_key=?`, [key]);
  if (prior) {
    if (prior.operation !== req.operation || prior.principal !== req.principal || prior.payload_sha256 !== payloadSha)
      throw new OpError("idempotency_conflict", "Idempotency key reused with a different payload.");
    return JSON.parse(prior.response_json) as T;
  }
  const result = await produce();
  await db.run(
    `INSERT INTO idempotency (idem_key,operation,principal,payload_sha256,response_json,created_at) VALUES (?,?,?,?,?,?)`,
    [key, req.operation, req.principal, payloadSha, JSON.stringify(result), req.now],
  );
  return result;
}

/** The principal must be an existing actor; optionally with a role. */
async function requireActor(db: Db, req: Req, role?: string): Promise<any> {
  const actor: any = await db.get(`SELECT * FROM actors WHERE actor_id=?`, [req.principal]);
  if (!actor) throw new OpError("actor_required", "This operation needs a recovered or admitted actor.");
  if (role && !JSON.parse(actor.roles_json).includes(role))
    throw new OpError("role_denied", `This operation needs the ${role} role.`);
  return actor;
}

/**
 * The admission receipt the client presents must resolve to a live membership
 * that belongs to the authenticated principal. Nothing in the receipt is
 * trusted beyond its ids; the stored row is the truth.
 */
async function requireMembership(db: Db, req: Req, receipt: any): Promise<any> {
  const m: any = await db.get(`SELECT * FROM memberships WHERE membership_id=?`, [receipt?.membershipID]);
  if (!m) throw new OpError("unknown_membership", "Admission receipt does not resolve.");
  if (m.revoked_at) throw new OpError("membership_revoked", "Membership revoked.");
  if (m.actor_id !== req.principal) throw new OpError("membership_not_yours", "Admission receipt belongs to another actor.");
  if (m.actor_id !== receipt.actorID || m.sphere_id !== receipt.sphereID || m.device_session_id !== receipt.deviceSessionID)
    throw new OpError("receipt_mismatch", "Admission receipt does not match server state.");
  return m;
}

async function organizedSphere(db: Db, req: Req, sphereId: unknown): Promise<any> {
  const s: any = await db.get(`SELECT * FROM spheres WHERE sphere_id=?`, [sphereId]);
  if (!s) throw new OpError("unknown_sphere", "Sphere does not resolve.");
  if (s.organizer_actor_id !== req.principal) throw new OpError("not_organizer", "Only the Sphere's organizer may do this.");
  return s;
}

// ---- operation handlers ----------------------------------------------------

type Handler = (db: Db, req: Req, key: ServerKey) => Promise<any>;
const OPS: Record<string, Handler> = {
  async load_home(db, req) {
    const actor: any = await db.get(`SELECT * FROM actors WHERE actor_id=?`, [req.principal]);
    const series = (await db.all<any>(`SELECT * FROM series WHERE organizer_actor_id=? ORDER BY created_at`, [req.principal]))
      .map((s) => ({ id: s.series_id, organizerActorID: s.organizer_actor_id, title: s.title, summary: s.summary, nextOccurrenceAt: s.next_occurrence_at ?? null }));
    const spheres = (await db.all<any>(`SELECT * FROM spheres WHERE organizer_actor_id=? ORDER BY created_at`, [req.principal]))
      .map((s) => ({ id: s.sphere_id, seriesID: s.series_id ?? null, organizerActorID: s.organizer_actor_id, title: s.title, summary: s.summary, startsAt: s.starts_at ?? null, membershipState: null, capacityRemaining: s.capacity_remaining ?? null }));
    const subs = (await db.all<any>(`SELECT s.* FROM subscriptions s WHERE s.actor_id=? ORDER BY s.updated_at`, [req.principal]).catch(() => []));
    const actorOut = actor
      ? { actorID: actor.actor_id, accountID: actor.account_id, deviceSessionID: (await currentDeviceSession(db, req)) ?? "", displayName: actor.display_name, availableRoles: sorted(JSON.parse(actor.roles_json)), recoveredAt: actor.created_at }
      : null;
    return { actor: actorOut, series, spheres, subscriptions: (subs as any[]).map((x) => ({
      id: x.subscription_id, actorID: x.actor_id, seriesID: x.series_id, isActive: !!x.is_active, updatedAt: x.updated_at,
    })) };
  },

  // ---- recovery: a bound device vouches for the next one --------------------

  async issue_recovery_grant(db, req) {
    await requireActor(db, req);
    if (req.deviceKeyId) {
      const dev: any = await db.get(`SELECT actor_id FROM devices WHERE key_id=?`, [req.deviceKeyId]);
      if (dev?.actor_id !== req.principal)
        throw new OpError("device_not_bound", "Only a device already bound to this actor can vouch for another.");
    }
    const grant = await issueRecoveryGrant(db, req.principal, "device", req.deviceKeyId ?? "dev-auth", req.now, req.payload?.ttlSeconds);
    await audit(db, req.now, req.operation, req.principal, null, { grantID: grant.grantID, issuedBy: "device", by: req.deviceKeyId ?? "dev-auth" });
    return grant;
  },

  async begin_actor_recovery(db, req) {
    const { accountHint, deviceKey, recoverySecret } = req.payload ?? {};
    requireOwnKey(req.deviceKeyId, deviceKey?.keyID);
    const grant = await resolveRecoveryGrant(db, recoverySecret, req.now);
    const dev = await registerDeviceInsertOnly(db, deviceKey, req.now);
    if (dev.actor_id && dev.actor_id !== grant.actor_id)
      throw new OpError("device_bound_elsewhere", "This device key is already bound to another actor.");
    // The subject the app re-derives is the account hint it sent; it is a label
    // here, never an identity. The grant is what names the actor.
    const subject = await possessionSubjectSHA256("account_recovery", typeof accountHint === "string" ? accountHint : "");
    // Open the device session now and challenge against it. The iOS client
    // requires complete_actor_recovery to return the SAME deviceSessionID it was
    // challenged with (ParticipationStore.recoverActor), so this must never be a
    // placeholder like "pending".
    const dsid = await newDeviceSession(db, null, dev.key_id, req.now);
    return issueChallenge(db, "account_recovery", subject, dsid, dev.key_id, req.now, null, grant.grant_id);
  },

  async complete_actor_recovery(db, req) {
    const { request, proof } = req.payload ?? {};
    const subject = await possessionSubjectSHA256("account_recovery", typeof request?.accountHint === "string" ? request.accountHint : "");
    const ch = await consumeProof(db, req, "account_recovery", subject, proof);
    if (!ch.recovery_grant_id) throw new OpError("recovery_grant_required", "This challenge carries no recovery grant.");
    const grant = await db.get<GrantRow>(`SELECT * FROM recovery_grants WHERE grant_id=?`, [ch.recovery_grant_id]);
    if (!grant) throw new OpError("recovery_grant_invalid", "Recovery grant does not resolve.");
    assertGrantLive(grant, req.now);
    await db.run(`UPDATE recovery_grants SET consumed_at=? WHERE grant_id=? AND consumed_at IS NULL`, [req.now, grant.grant_id]);
    // Bind the device session opened at begin. Never mint a new one: the client
    // checks that the returned deviceSessionID equals the one it was challenged
    // with, so a fresh id here is reported as an integrity failure.
    const dsid = ch.device_session_id;
    await bindDeviceToActor(db, proof.keyID, dsid, grant.actor_id);
    const a: any = await db.get(`SELECT * FROM actors WHERE actor_id=?`, [grant.actor_id]);
    if (!a) throw new OpError("unknown_actor", "The granted actor no longer exists.");
    await audit(db, req.now, req.operation, a.actor_id, dsid, { keyID: proof.keyID, grantID: grant.grant_id, issuedBy: grant.issued_by_kind });
    return { actorID: a.actor_id, accountID: a.account_id, deviceSessionID: dsid, displayName: a.display_name, availableRoles: sorted(JSON.parse(a.roles_json)), recoveredAt: req.now };
  },

  // ---- organizer objects -----------------------------------------------------

  async create_series(db, req) {
    await requireActor(db, req, "organizer");
    return idempotent(db, req, req.payload.idempotencyKey, async () => {
      const id = uuid();
      await db.run(`INSERT INTO series (series_id,organizer_actor_id,title,summary,next_occurrence_at,created_at) VALUES (?,?,?,?,?,?)`,
        [id, req.principal, req.payload.draft.title, req.payload.draft.summary, null, req.now]);
      await audit(db, req.now, req.operation, req.principal, null, { seriesID: id });
      return { id, organizerActorID: req.principal, title: req.payload.draft.title, summary: req.payload.draft.summary, nextOccurrenceAt: null };
    });
  },

  async create_sphere(db, req) {
    await requireActor(db, req, "organizer");
    return idempotent(db, req, req.payload.idempotencyKey, async () => {
      const id = uuid();
      const d = req.payload.draft;
      await db.run(`INSERT INTO spheres (sphere_id,series_id,organizer_actor_id,title,summary,starts_at,capacity_remaining,created_at) VALUES (?,?,?,?,?,?,?,?)`,
        [id, d.seriesID ?? null, req.principal, d.title, d.summary, d.startsAt ?? null, null, req.now]);
      await audit(db, req.now, req.operation, req.principal, null, { sphereID: id });
      return { id, seriesID: d.seriesID ?? null, organizerActorID: req.principal, title: d.title, summary: d.summary, startsAt: d.startsAt ?? null, membershipState: null, capacityRemaining: null };
    });
  },

  async set_subscription(db, req) {
    await requireActor(db, req);
    return idempotent(db, req, req.payload.idempotencyKey, async () => {
      const { seriesID, isActive } = req.payload;
      const existing: any = await db.get(`SELECT * FROM subscriptions WHERE actor_id=? AND series_id=?`, [req.principal, seriesID]);
      const id = existing?.subscription_id ?? uuid();
      await db.run(
        `INSERT INTO subscriptions (subscription_id,actor_id,series_id,is_active,updated_at) VALUES (?,?,?,?,?)
         ON CONFLICT(subscription_id) DO UPDATE SET is_active=excluded.is_active, updated_at=excluded.updated_at`,
        [id, req.principal, seriesID, isActive ? 1 : 0, req.now]);
      await audit(db, req.now, req.operation, req.principal, null, { seriesID, isActive: !!isActive });
      return { id, actorID: req.principal, seriesID, isActive: !!isActive, updatedAt: req.now };
    });
  },

  // ---- invitations: the organizer mints, the server keeps only the hash ------

  async create_invitation(db, req) {
    await requireActor(db, req, "organizer");
    const sphere = await organizedSphere(db, req, req.payload?.sphereID);
    return idempotent(db, req, req.payload.idempotencyKey, async () => {
      const inv = await createInvitation(db, sphere.sphere_id, req.principal, req.now, {
        role: req.payload.role, scopes: req.payload.scopes, maxUses: req.payload.maxUses, ttlSeconds: req.payload.ttlSeconds,
      });
      await audit(db, req.now, req.operation, req.principal, null, { invitationID: inv.invitationID, sphereID: inv.sphereID, role: inv.role, maxUses: inv.maxUses, expiresAt: inv.expiresAt });
      return inv;
    });
  },

  async revoke_invitation(db, req) {
    await requireActor(db, req, "organizer");
    const inv = await db.get<InvitationRow>(`SELECT * FROM invitations WHERE invitation_id=?`, [req.payload?.invitationID]);
    if (!inv) throw new OpError("unknown_invitation", "Invitation does not resolve.");
    if (inv.organizer_actor_id !== req.principal) throw new OpError("not_organizer", "Only the issuing organizer may revoke an invitation.");
    return idempotent(db, req, req.payload.idempotencyKey, async () => {
      if (!inv.revoked_at) await db.run(`UPDATE invitations SET revoked_at=? WHERE invitation_id=? AND revoked_at IS NULL`, [req.now, inv.invitation_id]);
      await audit(db, req.now, req.operation, req.principal, null, { invitationID: inv.invitation_id });
      return { invitationID: inv.invitation_id, sphereID: inv.sphere_id, revokedAt: inv.revoked_at ?? req.now };
    });
  },

  // ---- admission --------------------------------------------------------------

  async begin_admission(db, req) {
    const { invitation, deviceKey } = req.payload ?? {};
    requireOwnKey(req.deviceKeyId, deviceKey?.keyID);
    const inv = await resolveInvitation(db, invitation?.joinAttemptReference, invitation?.sphereID, req.now);
    if (invitation?.requestedRole !== inv.role)
      throw new OpError("role_mismatch", `This invitation admits the ${inv.role} role.`);
    const dev = await registerDeviceInsertOnly(db, deviceKey, req.now);
    const refSha = await joinAttemptSubjectSHA256(invitation.joinAttemptReference);
    const jaid = uuid();
    await db.run(`INSERT INTO join_attempts (join_attempt_id,sphere_id,reference_sha256,requested_role,created_at,consumed_at,invitation_id,device_key_id) VALUES (?,?,?,?,?,NULL,?,?)`,
      [jaid, inv.sphere_id, refSha, inv.role, req.now, inv.invitation_id, dev.key_id]);
    const dsid = await newDeviceSession(db, null, dev.key_id, req.now);
    const ch = await issueChallenge(db, "admission", refSha, dsid, dev.key_id, req.now, jaid);
    return { challengeID: ch.challengeID, joinAttemptID: jaid, joinAttemptReferenceSHA256: refSha, deviceSessionID: dsid, deviceKeyID: dev.key_id, challengeBase64URL: ch.challengeBase64URL, challengeSHA256: ch.challengeSHA256, issuedAt: ch.issuedAt, expiresAt: ch.expiresAt };
  },

  async complete_admission(db, req) {
    const proof = req.payload;
    const ch = await consumeProof(db, req, "admission", null, proof);
    const ja: any = await db.get(`SELECT * FROM join_attempts WHERE join_attempt_id=?`, [ch.join_attempt_id]);
    if (!ja) throw new OpError("unknown_invitation", "No join attempt for this challenge.");
    if (ja.consumed_at) throw new OpError("invitation_consumed", "This join attempt was already completed.");
    if (ja.device_key_id && ja.device_key_id !== proof.keyID)
      throw new OpError("key_mismatch", "This join attempt was begun by another device.");
    const inv = await db.get<InvitationRow>(`SELECT * FROM invitations WHERE invitation_id=?`, [ja.invitation_id]);
    if (!inv) throw new OpError("unknown_invitation", "The invitation behind this join attempt no longer exists.");
    assertInvitationLive(inv, req.now);
    const dev: any = await db.get(`SELECT * FROM devices WHERE key_id=?`, [proof.keyID]);
    if (!dev) throw new OpError("unknown_device", "Device key is not registered.");
    const dsid = ch.device_session_id;
    // A device with no actor is a guest joining for the first time: the
    // invitation creates its actor, with exactly the invited role.
    let actorId: string = dev.actor_id;
    if (!actorId) {
      actorId = `actor-${uuid()}`;
      await db.run(
        `INSERT INTO actors (actor_id,account_id,display_name,roles_json,created_at) VALUES (?,?,?,?,?)`,
        [actorId, `account-${uuid()}`, `guest-${proof.keyID.slice(0, 8)}`, JSON.stringify([inv.role]), req.now]);
    }
    await bindDeviceToActor(db, proof.keyID, dsid, actorId);
    const scopes = sorted(JSON.parse(inv.scopes_json));
    const membershipId = uuid();
    await db.run(
      `INSERT INTO memberships (membership_id,sphere_id,actor_id,device_session_id,state,granted_scopes,admitted_at,revoked_at,updated_at)
       VALUES (?,?,?,?,?,?,?,NULL,?)`,
      [membershipId, ja.sphere_id, actorId, dsid, "admitted", JSON.stringify(scopes), req.now, req.now]);
    await db.run(`UPDATE join_attempts SET consumed_at=? WHERE join_attempt_id=?`, [req.now, ja.join_attempt_id]);
    await db.run(`UPDATE invitations SET used_count=used_count+1 WHERE invitation_id=?`, [inv.invitation_id]);
    const receipt = { receiptID: uuid(), sphereID: ja.sphere_id, actorID: actorId, membershipID: membershipId, deviceSessionID: dsid, membershipState: "admitted", grantedScopes: scopes, acceptedAt: req.now };
    await db.run(`INSERT INTO admission_receipts (receipt_id,sphere_id,actor_id,membership_id,device_session_id,membership_state,granted_scopes,accepted_at) VALUES (?,?,?,?,?,?,?,?)`,
      [receipt.receiptID, receipt.sphereID, receipt.actorID, receipt.membershipID, receipt.deviceSessionID, receipt.membershipState, JSON.stringify(scopes), receipt.acceptedAt]);
    await audit(db, req.now, req.operation, actorId, dsid, { membershipID: membershipId, sphereID: ja.sphere_id, invitationID: inv.invitation_id, keyID: proof.keyID, scopes });
    return receipt;
  },

  // ---- consent (append-only) ---------------------------------------------------

  async load_consent_instruments(db, req) {
    await requireMembership(db, req, req.payload);
    const rows = await db.all<any>(`SELECT * FROM consent_instruments ORDER BY purpose, version`);
    return rows.map((r) => ({ id: r.instrument_id, version: r.version, languageSHA256: r.language_sha256, locale: r.locale, purpose: r.purpose, title: r.title, explanation: r.explanation, consequenceOfDenial: r.consequence_of_denial }));
  },

  async append_consent(db, req) {
    const m = await requireMembership(db, req, req.payload.admission);
    return idempotent(db, req, req.payload.idempotencyKey, async () => {
      const out: any[] = [];
      for (const sel of req.payload.selections) {
        const prev = await db.get<any>(`SELECT * FROM consents WHERE membership_id=? AND purpose=? ORDER BY revision DESC LIMIT 1`, [m.membership_id, sel.purpose]);
        const revision = (prev?.revision ?? 0) + 1;
        const id = uuid();
        await db.run(`INSERT INTO consents (consent_fact_id,membership_id,purpose,decision,instrument_id,instrument_version,language_sha256,revision,decided_at,valid_until,supersedes_consent_fact_id,idempotency_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [id, m.membership_id, sel.purpose, sel.decision, sel.instrumentID, sel.instrumentVersion, sel.presentedLanguageSHA256, revision, req.now, null, prev?.consent_fact_id ?? null, null]);
        out.push({ id, membershipID: m.membership_id, purpose: sel.purpose, decision: sel.decision, instrumentID: sel.instrumentID, instrumentVersion: sel.instrumentVersion, presentedLanguageSHA256: sel.presentedLanguageSHA256, revision, decidedAt: req.now, validUntil: null, supersedesConsentFactID: prev?.consent_fact_id ?? null });
      }
      await audit(db, req.now, req.operation, m.actor_id, m.device_session_id, { membershipID: m.membership_id, purposes: out.map((o) => `${o.purpose}:${o.decision}@${o.revision}`) });
      return out;
    });
  },

  async load_current_consent_receipts(db, req) {
    const m = await requireMembership(db, req, req.payload);
    const rows = await db.all<any>(`SELECT * FROM consents WHERE membership_id=? ORDER BY purpose, revision`, [m.membership_id]);
    const latest = new Map<string, any>();
    for (const r of rows) latest.set(r.purpose, r);
    return [...latest.values()].map(rowToConsentReceipt);
  },

  async revoke_consent(db, req) {
    const m = await requireMembership(db, req, req.payload.admission);
    return idempotent(db, req, req.payload.idempotencyKey, async () => {
      const { consentFactID } = req.payload;
      const prior: any = await db.get(`SELECT * FROM consents WHERE consent_fact_id=? AND membership_id=?`, [consentFactID, m.membership_id]);
      if (!prior) throw new OpError("unknown_consent", "Consent fact does not resolve.");
      const id = uuid();
      const revision = prior.revision + 1;
      await db.run(`INSERT INTO consents (consent_fact_id,membership_id,purpose,decision,instrument_id,instrument_version,language_sha256,revision,decided_at,valid_until,supersedes_consent_fact_id,idempotency_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, m.membership_id, prior.purpose, "revoked", prior.instrument_id, prior.instrument_version, prior.language_sha256, revision, req.now, null, consentFactID, null]);
      await audit(db, req.now, req.operation, m.actor_id, m.device_session_id, { membershipID: m.membership_id, purpose: prior.purpose, revision });
      return rowToConsentReceipt({ ...prior, consent_fact_id: id, decision: "revoked", revision, decided_at: req.now, supersedes_consent_fact_id: consentFactID });
    });
  },

  // ---- sources ----------------------------------------------------------------

  async register_source(db, req) {
    const m = await requireMembership(db, req, req.payload.admission);
    return idempotent(db, req, req.payload.idempotencyKey, async () => {
      const d = req.payload.draft;
      const id = uuid(); const capabilityId = uuid();
      const modalities = sorted([...(d.modalities ?? [])]);
      // Scopes come from the stored membership, never from the receipt the client sent.
      const granted: string[] = JSON.parse(m.granted_scopes);
      if (!granted.includes("upload") && !granted.includes("media_publish"))
        throw new OpError("scope_denied", "Membership lacks upload scope.");
      await db.run(`INSERT INTO sources (source_id,sphere_id,membership_id,device_session_id,capability_id,label,role,modalities_json,capture_state,accepted_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [id, m.sphere_id, m.membership_id, m.device_session_id, capabilityId, d.label ?? "My iPhone", d.role, JSON.stringify(modalities), "registered", req.now]);
      await audit(db, req.now, req.operation, m.actor_id, m.device_session_id, { sourceID: id, sphereID: m.sphere_id, modalities });
      return { sourceID: id, sphereID: m.sphere_id, membershipID: m.membership_id, deviceSessionID: m.device_session_id, capabilityID: capabilityId, acceptedAt: req.now, captureState: "registered" };
    });
  },

  // ---- App Clip -> full app handoff -------------------------------------------

  async begin_full_app_handoff_preparation(db, req) {
    const dec = req.payload.admission; const m = await requireMembership(db, req, dec);
    requireOwnKey(req.deviceKeyId, req.payload.deviceKey?.keyID);
    const dev = await registerDeviceInsertOnly(db, req.payload.deviceKey, req.now);
    const subject = await possessionSubjectSHA256("app_clip_handoff_preparation", m.membership_id);
    return issueChallenge(db, "app_clip_handoff_preparation", subject, m.device_session_id, dev.key_id, req.now);
  },

  async prepare_full_app_handoff(db, req, key) {
    const dec = req.payload.admission; const m = await requireMembership(db, req, dec);
    const subject = await possessionSubjectSHA256("app_clip_handoff_preparation", m.membership_id);
    await consumeProof(db, req, "app_clip_handoff_preparation", subject, req.payload.proof);
    const receipt: any = await db.get(`SELECT receipt_id FROM admission_receipts WHERE receipt_id=? AND membership_id=?`, [dec.receiptID, m.membership_id]);
    if (!receipt) throw new OpError("unknown_receipt", "Admission receipt does not resolve to server state.");
    const reference = uuid();
    const expiresAt = iso(new Date(new Date(req.now).getTime() + HANDOFF_TTL_MS));
    const signatureBase64URL = await key.sign(`${reference}.${expiresAt}`);
    await db.run(`INSERT INTO handoffs (reference,admission_receipt_id,server_key_id,signature_b64url,expires_at,created_at,consumed_at) VALUES (?,?,?,?,?,?,NULL)`,
      [reference, receipt.receipt_id, key.keyId, signatureBase64URL, expiresAt, req.now]);
    await audit(db, req.now, req.operation, m.actor_id, m.device_session_id, { membershipID: m.membership_id, expiresAt });
    return { reference, expiresAt, serverKeyID: key.keyId, signatureBase64URL };
  },

  async begin_full_app_handoff_exchange(db, req) {
    const ref = req.payload.reference;
    requireOwnKey(req.deviceKeyId, req.payload.deviceKey?.keyID);
    const h: any = await db.get(`SELECT * FROM handoffs WHERE reference=?`, [ref?.reference]);
    if (!h) throw new OpError("unknown_handoff", "Handoff reference does not resolve.");
    if (h.consumed_at) throw new OpError("handoff_consumed", "Handoff already exchanged.");
    if (new Date(h.expires_at).getTime() < new Date(req.now).getTime()) throw new OpError("handoff_expired", "Handoff expired.");
    const subject = await possessionSubjectSHA256("full_app_handoff_exchange", ref.reference);
    const dev = await registerDeviceInsertOnly(db, req.payload.deviceKey, req.now);
    const dsid = await newDeviceSession(db, null, dev.key_id, req.now);
    return issueChallenge(db, "full_app_handoff_exchange", subject, dsid, dev.key_id, req.now);
  },

  async exchange_full_app_handoff(db, req, key) {
    const ref = req.payload.reference;
    const subject = await possessionSubjectSHA256("full_app_handoff_exchange", ref?.reference);
    const ch = await consumeProof(db, req, "full_app_handoff_exchange", subject, req.payload.proof);
    const h: any = await db.get(`SELECT * FROM handoffs WHERE reference=?`, [ref.reference]);
    if (!h) throw new OpError("unknown_handoff", "Handoff reference does not resolve.");
    if (h.consumed_at) throw new OpError("handoff_consumed", "Handoff already exchanged.");
    if (new Date(h.expires_at).getTime() < new Date(req.now).getTime()) throw new OpError("handoff_expired", "Handoff expired.");
    await db.run(`UPDATE handoffs SET consumed_at=? WHERE reference=?`, [req.now, ref.reference]);
    const r: any = await db.get(`SELECT * FROM admission_receipts WHERE receipt_id=?`, [h.admission_receipt_id]);
    if (!r) throw new OpError("unknown_receipt", "Admission receipt does not resolve to server state.");
    // The handoff is the one legitimate path that introduces the full app's
    // durable key: bind it to the admitted actor now.
    await bindDeviceToActor(db, req.payload.proof.keyID, ch.device_session_id, r.actor_id);
    const session = await sessionFromReceipt(db, r, req.now, key);
    await audit(db, req.now, req.operation, r.actor_id, ch.device_session_id, { membershipID: r.membership_id, keyID: req.payload.proof.keyID });
    return session;
  },

  async begin_full_app_session_resume(db, req) {
    requireOwnKey(req.deviceKeyId, req.payload.deviceKey?.keyID);
    const subject = await possessionSubjectSHA256("full_app_session_resume", req.payload.recoveryHandle);
    const dev = await registerDeviceInsertOnly(db, req.payload.deviceKey, req.now);
    const dsid = await newDeviceSession(db, null, dev.key_id, req.now);
    return issueChallenge(db, "full_app_session_resume", subject, dsid, dev.key_id, req.now);
  },

  async resume_full_app_session(db, req) {
    const rh = req.payload.recoveryHandle;
    const subject = await possessionSubjectSHA256("full_app_session_resume", rh);
    const ch = await consumeProof(db, req, "full_app_session_resume", subject, req.payload.proof);
    const s: any = await db.get(`SELECT * FROM sessions WHERE session_id=?`, [rh]);
    if (!s) throw new OpError("unknown_session", "Recovery handle does not resolve.");
    if (new Date(s.expires_at).getTime() < new Date(req.now).getTime()) throw new OpError("session_expired", "Session expired.");
    // Only a device already bound to the session's actor may resume it.
    const dev: any = await db.get(`SELECT actor_id FROM devices WHERE key_id=?`, [req.payload.proof.keyID]);
    if (dev?.actor_id !== s.actor_id) throw new OpError("actor_mismatch", "This device is not bound to the session's actor.");
    await db.run(`UPDATE device_sessions SET actor_id=? WHERE device_session_id=? AND actor_id IS NULL`, [s.actor_id, ch.device_session_id]);
    return sessionFromRow(db, s);
  },
};


async function sessionFromReceipt(db: Db, r: any, now: string, _key: ServerKey): Promise<any> {
  const m: any = await db.get(`SELECT * FROM memberships WHERE membership_id=?`, [r.membership_id]);
  if (!m || m.revoked_at) throw new OpError("membership_revoked", "Membership not active.");
  const sessionId = uuid();
  const expiresAt = iso(new Date(new Date(now).getTime() + SESSION_TTL_MS));
  await db.run(`INSERT INTO sessions (session_id,admission_receipt_id,membership_id,actor_id,sphere_id,device_session_id,granted_scopes,issued_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    [sessionId, r.receipt_id, r.membership_id, r.actor_id, r.sphere_id, r.device_session_id, r.granted_scopes, now, expiresAt]);
  const s: any = await db.get(`SELECT * FROM sessions WHERE session_id=?`, [sessionId]);
  return sessionFromRow(db, s);
}

// ParticipationDomain.FullAppSession: { schema, admission, recoveryHandle,
// recoveryExpiresAt, notificationRegistrationEligible }. The recovery handle is
// the server-issued session id (opaque, 36 chars); the client vault revalidates
// it and requires an admitted/active membership carrying the admission scope.
async function admissionReceiptFromId(db: Db, receiptId: string): Promise<any> {
  const r: any = await db.get(`SELECT * FROM admission_receipts WHERE receipt_id=?`, [receiptId]);
  if (!r) throw new OpError("unknown_receipt", "Admission receipt does not resolve to server state.");
  return {
    receiptID: r.receipt_id, sphereID: r.sphere_id, actorID: r.actor_id,
    membershipID: r.membership_id, deviceSessionID: r.device_session_id,
    membershipState: r.membership_state, grantedScopes: sorted(JSON.parse(r.granted_scopes)),
    acceptedAt: r.accepted_at,
  };
}

// Eligibility is a coordinator-owned hint (not an APNs receipt). A membership is
// eligible once the participant has recorded at least one granted consent fact.
async function notificationRegistrationEligible(db: Db, membershipId: string): Promise<boolean> {
  const g: any = await db.get(
    `SELECT COUNT(*) AS n FROM consents WHERE membership_id=? AND decision='granted'`,
    [membershipId],
  );
  return Number(g?.n ?? 0) > 0;
}

async function sessionFromRow(db: Db, s: any): Promise<any> {
  if (!s) throw new OpError("unknown_session", "Session does not resolve.");
  return {
    schema: "motionmix.participation.full_app_session.v1",
    admission: await admissionReceiptFromId(db, s.admission_receipt_id),
    recoveryHandle: s.session_id,
    recoveryExpiresAt: s.expires_at,
    notificationRegistrationEligible: await notificationRegistrationEligible(db, s.membership_id),
  };
}

function rowToConsentReceipt(r: any) {
  return {
    id: r.consent_fact_id, membershipID: r.membership_id, purpose: r.purpose, decision: r.decision,
    instrumentID: r.instrument_id, instrumentVersion: r.instrument_version,
    presentedLanguageSHA256: r.language_sha256, revision: r.revision, decidedAt: r.decided_at,
    validUntil: r.valid_until ?? null, supersedesConsentFactID: r.supersedes_consent_fact_id ?? null,
  };
}

async function newDeviceSession(db: Db, actorId: string | null, keyId: string, now: string): Promise<string> {
  const id = uuid();
  await db.run(`INSERT INTO device_sessions (device_session_id,actor_id,key_id,created_at,revoked_at) VALUES (?,?,?,?,NULL)`,
    [id, actorId, keyId, now]);
  return id;
}

/** The bearer's own latest session for this actor; falls back to the actor's latest under dev auth. */
async function currentDeviceSession(db: Db, req: Req): Promise<string | null> {
  const row: any = req.deviceKeyId
    ? await db.get(`SELECT device_session_id FROM device_sessions WHERE actor_id=? AND key_id=? ORDER BY created_at DESC LIMIT 1`, [req.principal, req.deviceKeyId])
    : await db.get(`SELECT device_session_id FROM device_sessions WHERE actor_id=? ORDER BY created_at DESC LIMIT 1`, [req.principal]);
  return row?.device_session_id ?? null;
}

export async function dispatch(db: Db, req: Req, key: ServerKey): Promise<any> {
  const handler = OPS[req.operation];
  if (!handler) throw new OpError("unknown_operation", `Unknown operation: ${req.operation}`);
  const result = await handler(db, req, key);
  return result;
}
