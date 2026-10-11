// Participation coordinator operations — the participation-side deterministic
// core. Pure over (Db, ServerKey). Every durable mutation is idempotency-bound
// to (principal, operation, payload sha256). Consent is append-only. The server
// never trusts a client-asserted proof/consent-authority flag.
import { Db } from "./store.js";
import { ServerKey, verifyDeviceProof } from "./crypto.js";
import { b64url, sha256hex, uuid } from "./ids.js";
import { iso } from "./canonical.js";

export interface Req {
  operation: string;
  payload: any;
  principal: string;             // authenticated actor/device from the bearer
  deviceSessionId?: string;
  now: string;                   // ISO, passed in for deterministic tests
}

export class OpError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

const TTL_MS = 5 * 60 * 1000;
const HANDOFF_TTL_MS = 10 * 60 * 1000;

const isHex64 = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f]{64}$/.test(s);
const sorted = (arr: string[]) => [...new Set(arr)].sort();

// ---- helpers --------------------------------------------------------------

async function baseNonce(): Promise<string> {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

async function issueChallenge(
  db: Db, purpose: string, subjectSha: string, deviceSessionId: string,
  deviceKeyId: string, now: string,
): Promise<any> {
  const challenge = await baseNonce();
  const challengeSha = await sha256hex(challenge);
  const challengeId = await sha256hex(`${purpose}:${subjectSha}:${challenge}`);
  const expiresAt = iso(new Date(new Date(now).getTime() + TTL_MS));
  await db.run(
    `INSERT INTO challenges (challenge_id,purpose,subject_ref_sha256,device_session_id,device_key_id,challenge_b64url,challenge_sha256,issued_at,expires_at,consumed_at)
     VALUES (?,?,?,?,?,?,?,?,?,NULL)`,
    [challengeId, purpose, subjectSha, deviceSessionId, deviceKeyId, challenge, challengeSha, now, expiresAt],
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

async function challengeFor(db: Db, subjectSha: string, purpose: string) {
  const row: any = await db.get(
    `SELECT * FROM challenges WHERE subject_ref_sha256=? AND purpose=? AND consumed_at IS NULL ORDER BY issued_at DESC LIMIT 1`,
    [subjectSha, purpose],
  );
  return row;
}

/** Verify a device proof against the stored challenge and consuming it once. */
async function consumeProof(
  db: Db, purpose: string, subjectSha: string, proof: any, now: string,
): Promise<void> {
  const ch: any = await challengeFor(db, subjectSha, purpose);
  if (!ch) throw new OpError("no_challenge", "No open challenge for this purpose.");
  if (ch.consumed_at) throw new OpError("challenge_consumed", "Challenge already used.");
  if (new Date(ch.expires_at).getTime() < new Date(now).getTime())
    throw new OpError("challenge_expired", "Challenge expired.");
  if (proof?.challengeID !== ch.challenge_id)
    throw new OpError("challenge_mismatch", "Proof references a different challenge.");
  if (proof?.keyID !== ch.device_key_id)
    throw new OpError("key_mismatch", "Proof key does not match the challenge key.");
  const dev: any = await db.get(`SELECT * FROM devices WHERE key_id=?`, [ch.device_key_id]);
  if (!dev) throw new OpError("unknown_device", "Device key is not registered.");
  const ok = await verifyDeviceProof(dev.public_key_b64url, ch.challenge_b64url, proof?.signatureDERBase64URL);
  if (!ok) throw new OpError("proof_invalid", "Device possession proof failed.");
  await db.run(`UPDATE challenges SET consumed_at=? WHERE challenge_id=?`, [now, ch.challenge_id]);
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

async function requireMembership(db: Db, receipt: any): Promise<any> {
  const m: any = await db.get(`SELECT * FROM memberships WHERE membership_id=?`, [receipt?.membershipID]);
  if (!m) throw new OpError("unknown_membership", "Admission receipt does not resolve.");
  if (m.revoked_at) throw new OpError("membership_revoked", "Membership revoked.");
  if (m.actor_id !== receipt.actorID || m.sphere_id !== receipt.sphereID)
    throw new OpError("receipt_mismatch", "Admission receipt does not match server state.");
  return m;
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

  async begin_actor_recovery(db, req) {
    const { accountHint, deviceKey } = req.payload;
    const subject = await sha256hex(`recovery:${accountHint}`);
    await registerDevice(db, deviceKey, null, req.now);
    return issueChallenge(db, "account_recovery", subject, "pending", deviceKey.keyID, req.now);
  },

  async complete_actor_recovery(db, req) {
    const { request, proof } = req.payload;
    const subject = await sha256hex(`recovery:${request.accountHint}`);
    await consumeProof(db, "account_recovery", subject, proof, req.now);
    const dev: any = await db.get(`SELECT * FROM devices WHERE key_id=?`, [proof.keyID]);
    const actorId = dev.actor_id ?? uuid();
    const dsid = await newDeviceSession(db, actorId, proof.keyID, req.now);
    const roles = sorted(["organizer", "participant", "viewer"]);
    await db.run(
      `INSERT INTO actors (actor_id,account_id,display_name,roles_json,created_at) VALUES (?,?,?,?,?)
       ON CONFLICT(actor_id) DO UPDATE SET display_name=excluded.display_name, roles_json=excluded.roles_json`,
      [actorId, uuid(), request.accountHint, JSON.stringify(roles), req.now],
    );
    await db.run(`UPDATE devices SET actor_id=? WHERE key_id=?`, [actorId, proof.keyID]);
    const a: any = await db.get(`SELECT * FROM actors WHERE actor_id=?`, [actorId]);
    return { actorID: actorId, accountID: a.account_id, deviceSessionID: dsid, displayName: a.display_name, availableRoles: roles, recoveredAt: req.now };
  },

  async create_series(db, req) {
    return idempotent(db, req, req.payload.idempotencyKey, async () => {
      const id = uuid();
      await db.run(`INSERT INTO series (series_id,organizer_actor_id,title,summary,next_occurrence_at,created_at) VALUES (?,?,?,?,?,?)`,
        [id, req.principal, req.payload.draft.title, req.payload.draft.summary, null, req.now]);
      return { id, organizerActorID: req.principal, title: req.payload.draft.title, summary: req.payload.draft.summary, nextOccurrenceAt: null };
    });
  },

  async create_sphere(db, req) {
    return idempotent(db, req, req.payload.idempotencyKey, async () => {
      const id = uuid();
      const d = req.payload.draft;
      await db.run(`INSERT INTO spheres (sphere_id,series_id,organizer_actor_id,title,summary,starts_at,capacity_remaining,created_at) VALUES (?,?,?,?,?,?,?,?)`,
        [id, d.seriesID ?? null, req.principal, d.title, d.summary, d.startsAt ?? null, null, req.now]);
      return { id, seriesID: d.seriesID ?? null, organizerActorID: req.principal, title: d.title, summary: d.summary, startsAt: d.startsAt ?? null, membershipState: null, capacityRemaining: null };
    });
  },

  async set_subscription(db, req) {
    return idempotent(db, req, req.payload.idempotencyKey, async () => {
      const { seriesID, isActive } = req.payload;
      const existing: any = await db.get(`SELECT * FROM subscriptions WHERE actor_id=? AND series_id=?`, [req.principal, seriesID]);
      const id = existing?.subscription_id ?? uuid();
      await db.run(
        `INSERT INTO subscriptions (subscription_id,actor_id,series_id,is_active,updated_at) VALUES (?,?,?,?,?)
         ON CONFLICT(subscription_id) DO UPDATE SET is_active=excluded.is_active, updated_at=excluded.updated_at`,
        [id, req.principal, seriesID, isActive ? 1 : 0, req.now]);
      return { id, actorID: req.principal, seriesID, isActive: !!isActive, updatedAt: req.now };
    });
  },

  async begin_admission(db, req) {
    const { invitation, deviceKey } = req.payload;
    await registerDevice(db, deviceKey, null, req.now);
    const refSha = await sha256hex(invitation.joinAttemptReference);
    const jaid = uuid();
    await db.run(`INSERT INTO join_attempts (join_attempt_id,sphere_id,reference_sha256,requested_role,created_at,consumed_at) VALUES (?,?,?,?,?,NULL)`,
      [jaid, invitation.sphereID, refSha, invitation.requestedRole, req.now]);
    const dsid = await newDeviceSession(db, null, deviceKey.keyID, req.now);
    const ch = await issueChallenge(db, "admission", refSha, dsid, deviceKey.keyID, req.now);
    return { challengeID: ch.challengeID, joinAttemptID: jaid, joinAttemptReferenceSHA256: refSha, deviceSessionID: dsid, deviceKeyID: deviceKey.keyID, challengeBase64URL: ch.challengeBase64URL, challengeSHA256: ch.challengeSHA256, issuedAt: ch.issuedAt, expiresAt: ch.expiresAt };
  },

  async complete_admission(db, req) {
    const proof = req.payload;
    const ch: any = await db.get(`SELECT * FROM challenges WHERE challenge_id=?`, [proof.challengeID]);
    if (!ch) throw new OpError("no_challenge", "Unknown admission challenge.");
    const subject = ch.subject_ref_sha256;
    await consumeProof(db, "admission", subject, proof, req.now);
    const ja: any = await db.get(`SELECT * FROM join_attempts WHERE reference_sha256=? ORDER BY created_at DESC LIMIT 1`, [subject]);
    if (!ja) throw new OpError("unknown_invitation", "No join attempt for this invitation.");
    const dev: any = await db.get(`SELECT * FROM devices WHERE key_id=?`, [proof.keyID]);
    const actorId = dev.actor_id; if (!actorId) throw new OpError("unknown_actor", "Device is not bound to an actor.");
    const dsid = ch.device_session_id;
    const membershipId = uuid();
    const scopes = sorted(["admission", "media_publish", "playback", "upload"]);
    await db.run(
      `INSERT INTO memberships (membership_id,sphere_id,actor_id,device_session_id,state,granted_scopes,admitted_at,revoked_at,updated_at)
       VALUES (?,?,?,?,?,?,?,NULL,?)`,
      [membershipId, ja.sphere_id, actorId, dsid, "admitted", JSON.stringify(scopes), req.now, req.now]);
    await db.run(`UPDATE join_attempts SET consumed_at=? WHERE join_attempt_id=?`, [req.now, ja.join_attempt_id]);
    const receipt = { receiptID: uuid(), sphereID: ja.sphere_id, actorID: actorId, membershipID: membershipId, deviceSessionID: dsid, membershipState: "admitted", grantedScopes: scopes, acceptedAt: req.now };
    await db.run(`INSERT INTO admission_receipts (receipt_id,sphere_id,actor_id,membership_id,device_session_id,membership_state,granted_scopes,accepted_at) VALUES (?,?,?,?,?,?,?,?)`,
      [receipt.receiptID, receipt.sphereID, receipt.actorID, receipt.membershipID, receipt.deviceSessionID, receipt.membershipState, JSON.stringify(scopes), receipt.acceptedAt]);
    return receipt;
  },

  async load_consent_instruments(db, req) {
    await requireMembership(db, req.payload);
    const rows = await db.all<any>(`SELECT * FROM consent_instruments ORDER BY purpose, version`);
    return rows.map((r) => ({ id: r.instrument_id, version: r.version, languageSHA256: r.language_sha256, locale: r.locale, purpose: r.purpose, title: r.title, explanation: r.explanation, consequenceOfDenial: r.consequence_of_denial }));
  },

  async append_consent(db, req) {
    const m = await requireMembership(db, req.payload.admission);
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
      return out;
    });
  },

  async load_current_consent_receipts(db, req) {
    const m = await requireMembership(db, req.payload);
    const rows = await db.all<any>(`SELECT * FROM consents WHERE membership_id=? ORDER BY purpose, revision`, [m.membership_id]);
    const latest = new Map<string, any>();
    for (const r of rows) latest.set(r.purpose, r);
    return [...latest.values()].map(rowToConsentReceipt);
  },

  async revoke_consent(db, req) {
    const m = await requireMembership(db, req.payload.admission);
    return idempotent(db, req, req.payload.idempotencyKey, async () => {
      const { consentFactID } = req.payload;
      const prior: any = await db.get(`SELECT * FROM consents WHERE consent_fact_id=? AND membership_id=?`, [consentFactID, m.membership_id]);
      if (!prior) throw new OpError("unknown_consent", "Consent fact does not resolve.");
      const id = uuid();
      const revision = prior.revision + 1;
      await db.run(`INSERT INTO consents (consent_fact_id,membership_id,purpose,decision,instrument_id,instrument_version,language_sha256,revision,decided_at,valid_until,supersedes_consent_fact_id,idempotency_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, m.membership_id, prior.purpose, "revoked", prior.instrument_id, prior.instrument_version, prior.language_sha256, revision, req.now, null, consentFactID, null]);
      return rowToConsentReceipt({ ...prior, consent_fact_id: id, decision: "revoked", revision, decided_at: req.now, supersedes_consent_fact_id: consentFactID });
    });
  },

  async register_source(db, req) {
    const m = await requireMembership(db, req.payload.admission);
    return idempotent(db, req, req.payload.idempotencyKey, async () => {
      const d = req.payload.draft;
      const id = uuid(); const capabilityId = uuid();
      const modalities = sorted([...(d.modalities ?? [])]);
      const dec = req.payload.admission;
      // capability requires upload scope
      if (!dec.grantedScopes?.includes?.("upload") && !dec.grantedScopes?.includes?.("media_publish"))
        throw new OpError("scope_denied", "Membership lacks upload scope.");
      await db.run(`INSERT INTO sources (source_id,sphere_id,membership_id,device_session_id,capability_id,label,role,modalities_json,capture_state,accepted_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [id, m.sphere_id, m.membership_id, dec.deviceSessionID, capabilityId, d.label ?? "My iPhone", d.role, JSON.stringify(modalities), "registered", req.now]);
      return { sourceID: id, sphereID: m.sphere_id, membershipID: m.membership_id, deviceSessionID: dec.deviceSessionID, capabilityID: capabilityId, acceptedAt: req.now, captureState: "registered" };
    });
  },

  async begin_full_app_handoff_preparation(db, req) {
    const dec = req.payload.admission; await requireMembership(db, dec);
    await registerDevice(db, req.payload.deviceKey, dec.actorID, req.now);
    const subject = await sha256hex(`handoff:${dec.receiptID}`);
    return issueChallenge(db, "app_clip_handoff_preparation", subject, dec.deviceSessionID, req.payload.deviceKey.keyID, req.now);
  },

  async prepare_full_app_handoff(db, req, key) {
    const dec = req.payload.admission; await requireMembership(db, dec);
    const subject = await sha256hex(`handoff:${dec.receiptID}`);
    await consumeProof(db, "app_clip_handoff_preparation", subject, req.payload.proof, req.now);
    const reference = uuid();
    const expiresAt = iso(new Date(new Date(req.now).getTime() + HANDOFF_TTL_MS));
    const signatureBase64URL = await key.sign(`${reference}.${expiresAt}`);
    await db.run(`INSERT INTO handoffs (reference,admission_receipt_id,server_key_id,signature_b64url,expires_at,created_at,consumed_at) VALUES (?,?,?,?,?,?,NULL)`,
      [reference, dec.receiptID, key.keyId, signatureBase64URL, expiresAt, req.now]);
    return { reference, expiresAt, serverKeyID: key.keyId, signatureBase64URL };
  },

  async begin_full_app_handoff_exchange(db, req) {
    const ref = req.payload.reference;
    const subject = await sha256hex(`exchange:${ref.reference}`);
    await registerDevice(db, req.payload.deviceKey, null, req.now);
    const dsid = await newDeviceSession(db, null, req.payload.deviceKey.keyID, req.now);
    return issueChallenge(db, "full_app_handoff_exchange", subject, dsid, req.payload.deviceKey.keyID, req.now);
  },

  async exchange_full_app_handoff(db, req, key) {
    const ref = req.payload.reference;
    const subject = await sha256hex(`exchange:${ref.reference}`);
    await consumeProof(db, "full_app_handoff_exchange", subject, req.payload.proof, req.now);
    const h: any = await db.get(`SELECT * FROM handoffs WHERE reference=?`, [ref.reference]);
    if (!h) throw new OpError("unknown_handoff", "Handoff reference does not resolve.");
    if (h.consumed_at) throw new OpError("handoff_consumed", "Handoff already exchanged.");
    if (new Date(h.expires_at).getTime() < new Date(req.now).getTime()) throw new OpError("handoff_expired", "Handoff expired.");
    await db.run(`UPDATE handoffs SET consumed_at=? WHERE reference=?`, [req.now, ref.reference]);
    return sessionFromReceipt(db, h.admission_receipt_id, req.now, key);
  },

  async begin_full_app_session_resume(db, req) {
    const subject = await sha256hex(`resume:${req.payload.recoveryHandle}`);
    await registerDevice(db, req.payload.deviceKey, null, req.now);
    const dsid = await newDeviceSession(db, null, req.payload.deviceKey.keyID, req.now);
    return issueChallenge(db, "full_app_session_resume", subject, dsid, req.payload.deviceKey.keyID, req.now);
  },

  async resume_full_app_session(db, req, key) {
    const rh = req.payload.recoveryHandle;
    const subject = await sha256hex(`resume:${rh}`);
    await consumeProof(db, "full_app_session_resume", subject, req.payload.proof, req.now);
    const s: any = await db.get(`SELECT * FROM sessions WHERE session_id=?`, [rh]);
    if (!s) throw new OpError("unknown_session", "Recovery handle does not resolve.");
    if (new Date(s.expires_at).getTime() < new Date(req.now).getTime()) throw new OpError("session_expired", "Session expired.");
    return sessionFromRow(db, s);
  },
};


async function sessionFromReceipt(db: Db, receiptId: string, now: string, _key: ServerKey): Promise<any> {
  const r: any = await db.get(`SELECT * FROM admission_receipts WHERE receipt_id=?`, [receiptId]);
  if (!r) throw new OpError("unknown_receipt", "Admission receipt does not resolve to server state.");
  const m: any = await db.get(`SELECT * FROM memberships WHERE membership_id=?`, [r.membership_id]);
  if (!m || m.revoked_at) throw new OpError("membership_revoked", "Membership not active.");
  const sessionId = uuid();
  const expiresAt = iso(new Date(new Date(now).getTime() + 30 * 24 * 3600 * 1000));
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

async function registerDevice(db: Db, deviceKey: any, actorId: string | null, now: string) {
  await db.run(
    `INSERT INTO devices (key_id,actor_id,algorithm,public_key_b64url,registered_at) VALUES (?,?,?,?,?)
     ON CONFLICT(key_id) DO UPDATE SET algorithm=excluded.algorithm, public_key_b64url=excluded.public_key_b64url`,
    [deviceKey.keyID, actorId, deviceKey.algorithm, deviceKey.publicKeyBase64URL, now]);
}

async function newDeviceSession(db: Db, actorId: string | null, keyId: string, now: string): Promise<string> {
  const id = uuid();
  await db.run(`INSERT INTO device_sessions (device_session_id,actor_id,key_id,created_at,revoked_at) VALUES (?,?,?,?,NULL)`,
    [id, actorId, keyId, now]);
  return id;
}

async function currentDeviceSession(db: Db, req: Req): Promise<string | null> {
  const row: any = await db.get(`SELECT device_session_id FROM device_sessions WHERE actor_id=? ORDER BY created_at DESC LIMIT 1`, [req.principal]);
  return row?.device_session_id ?? null;
}

export async function dispatch(db: Db, req: Req, key: ServerKey): Promise<any> {
  const handler = OPS[req.operation];
  if (!handler) throw new OpError("unknown_operation", `Unknown operation: ${req.operation}`);
  const result = await handler(db, req, key);
  return result;
}
