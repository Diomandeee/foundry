// v2 security core: the properties the 2026-10-22 review found missing.
// Each test is one attack the v1 coordinator allowed.
import { describe, expect, it, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SqliteStore } from "../src/store.js";
import { buildCoordinator, run as runCtx } from "../src/app.js";
import { loadServerKey } from "../src/crypto.js";
import { b64url } from "../src/ids.js";
import { deviceTokenAuth, issueDeviceToken, tokenRequestMessage } from "../src/token.js";
import { DEFAULT_FIRST_USER, ensureFirstUser } from "../src/bootstrap.js";
import { gcExpired } from "../src/security.js";
import { call } from "./client.js";
import { deviceKey, provePossession, signBytes } from "./p256.js";
import { admitWith, invite, operatorGrant, recoverWith } from "./v2.js";

const SECRET = b64url(crypto.getRandomValues(new Uint8Array(32)));
const NOW_S = 1791780000;
const NOW_ISO = new Date(NOW_S * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
const LATER_ISO = new Date((NOW_S + 2 * 3600) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
const MO = DEFAULT_FIRST_USER.actorID;

let db: SqliteStore;
let ctx: any;
let clock = NOW_ISO;

async function token(dev: any): Promise<string> {
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(24)));
  const sig = await signBytes(dev._pair, tokenRequestMessage(dev.keyID, dev.publicKeyBase64URL, nonce, NOW_ISO));
  return (await issueDeviceToken(db, {
    deviceKey: { keyID: dev.keyID, algorithm: dev.algorithm, publicKeyBase64URL: dev.publicKeyBase64URL },
    nonce, issuedAt: NOW_ISO, signatureDERBase64URL: sig,
  }, SECRET, NOW_S)).accessToken;
}

/** A callf bound to a real device-bound bearer (what the app does). */
async function asDevice(dev: any) {
  const bearer = await token(dev);
  return (op: string, payload: any) => call((b, bb) => runCtx(db, b, bb, ctx), bearer, op, payload);
}

beforeAll(async () => {
  db = await SqliteStore.open(":memory:");
  await db.exec(readFileSync(join(import.meta.dirname, "../schema.sql"), "utf8"));
  await ensureFirstUser(db, DEFAULT_FIRST_USER, NOW_ISO);
  ctx = await buildCoordinator(db, { key: await loadServerKey(), now: () => clock, auth: deviceTokenAuth(db, SECRET, () => NOW_S) });
});

describe("C1: nobody becomes an existing actor without a grant", () => {
  it("recovery with only the account hint is refused (the v1 takeover)", async () => {
    const attacker = await deviceKey();
    const callf = await asDevice(attacker);
    const r = await callf("begin_actor_recovery", { accountHint: DEFAULT_FIRST_USER.displayName, deviceKey: attacker });
    expect(r.ok).toBe(false);
    expect(r.failure.code).toBe("recovery_grant_required");
    expect(await db.get(`SELECT 1 FROM devices WHERE key_id=?`, [attacker.keyID])).toBeNull();
  });

  it("a guessed or malformed secret is refused and registers nothing", async () => {
    const attacker = await deviceKey();
    const callf = await asDevice(attacker);
    const r = await callf("begin_actor_recovery", { accountHint: "x", deviceKey: attacker, recoverySecret: "mmrg1.not-a-real-grant-aaaaaaaaaaaaaaaaaaaa" });
    expect(r.failure.code).toBe("recovery_grant_invalid");
    expect(await db.get(`SELECT 1 FROM devices WHERE key_id=?`, [attacker.keyID])).toBeNull();
  });

  it("a grant is single-use and binds exactly the device that proved possession", async () => {
    const secret = await operatorGrant(db, MO, NOW_ISO);
    const phone = await deviceKey();
    const first = await recoverWith(await asDevice(phone), phone, secret);
    expect(first.done.ok).toBe(true);
    expect(first.done.payload.actorID).toBe(MO);

    const second = await deviceKey();
    const replay = await recoverWith(await asDevice(second), second, secret);
    expect(replay.done.ok).toBe(false);
    expect(replay.done.failure.code).toBe("recovery_grant_consumed");
    expect((await db.get<any>(`SELECT actor_id FROM devices WHERE key_id=?`, [second.keyID]))?.actor_id ?? null).toBeNull();
  });

  it("an expired grant is refused", async () => {
    const secret = await operatorGrant(db, MO, NOW_ISO, 60);
    clock = LATER_ISO;
    try {
      const phone = await deviceKey();
      const r = await recoverWith(await asDevice(phone), phone, secret);
      expect(r.done.ok).toBe(false);
      expect(r.done.failure.code).toBe("recovery_grant_expired");
    } finally { clock = NOW_ISO; }
  });

  it("only a device already bound to the actor can vouch for another", async () => {
    const stranger = await deviceKey();
    const r = await (await asDevice(stranger))("issue_recovery_grant", {});
    expect(r.ok).toBe(false);
    expect(r.failure.code).toBe("actor_required");

    const bound = await deviceKey();
    await recoverWith(await asDevice(bound), bound, await operatorGrant(db, MO, NOW_ISO));
    const vouch = await (await asDevice(bound))("issue_recovery_grant", {});
    expect(vouch.ok).toBe(true);
    const next = await deviceKey();
    const r2 = await recoverWith(await asDevice(next), next, vouch.payload.recoverySecret);
    expect(r2.done.ok).toBe(true);
    expect(r2.done.payload.actorID).toBe(MO);
  });

  it("a device bound to one actor cannot be re-bound to another by a grant", async () => {
    await db.run(`INSERT INTO actors (actor_id,account_id,display_name,roles_json,created_at) VALUES (?,?,?,?,?)`,
      ["actor-other", "account-other", "other", '["organizer","participant","viewer"]', NOW_ISO]);
    const phone = await deviceKey();
    const callf = await asDevice(phone);
    expect((await recoverWith(callf, phone, await operatorGrant(db, MO, NOW_ISO))).done.ok).toBe(true);
    const r = await recoverWith(callf, phone, await operatorGrant(db, "actor-other", NOW_ISO));
    expect(r.done.ok).toBe(false);
    expect(r.done.failure.code).toBe("device_bound_elsewhere");
  });
});

describe("device keys are insert-only and must be the bearer's own", () => {
  it("re-registering a key id with different bytes is refused", async () => {
    const phone = await deviceKey();
    const callf = await asDevice(phone);
    expect((await recoverWith(callf, phone, await operatorGrant(db, MO, NOW_ISO))).done.ok).toBe(true);
    const forged = { ...phone, publicKeyBase64URL: (await deviceKey()).publicKeyBase64URL };
    const r = await callf("begin_actor_recovery", { accountHint: "x", deviceKey: forged, recoverySecret: await operatorGrant(db, MO, NOW_ISO) });
    expect(r.ok).toBe(false);
    expect(r.failure.code).toBe("key_id_mismatch");
    const row: any = await db.get(`SELECT public_key_b64url FROM devices WHERE key_id=?`, [phone.keyID]);
    expect(row.public_key_b64url).toBe(phone.publicKeyBase64URL);
  });

  it("a bearer may not introduce someone else's key", async () => {
    const mine = await deviceKey();
    const theirs = await deviceKey();
    const r = await (await asDevice(mine))("begin_actor_recovery", { accountHint: "x", deviceKey: theirs, recoverySecret: await operatorGrant(db, MO, NOW_ISO) });
    expect(r.ok).toBe(false);
    expect(r.failure.code).toBe("key_not_bearer");
  });
});

describe("admission needs a server-issued invitation; scopes come from it", () => {
  async function organizer() {
    const phone = await deviceKey();
    const callf = await asDevice(phone);
    expect((await recoverWith(callf, phone, await operatorGrant(db, MO, NOW_ISO))).done.ok).toBe(true);
    return callf;
  }

  it("any high-entropy string no longer admits (the v1 join)", async () => {
    const guest = await deviceKey();
    const r = await (await asDevice(guest))("begin_admission", { invitation: { sphereID: "sphere-mo-studio", joinAttemptReference: crypto.randomUUID(), requestedRole: "participant" }, deviceKey: guest });
    expect(r.ok).toBe(false);
    expect(r.failure.code).toBe("unknown_invitation");
  });

  it("a viewer invitation admits a guest with viewer scopes only, creating the guest actor", async () => {
    const mo = await organizer();
    const inv = await invite(mo, "sphere-mo-studio", { role: "viewer" });
    expect(inv.grantedScopes).toEqual(["admission", "playback"]);
    const guest = await deviceKey();
    const g = await asDevice(guest);
    const { receipt } = await admitWith(g, guest, inv);
    expect(receipt.ok).toBe(true);
    expect(receipt.payload.grantedScopes).toEqual(["admission", "playback"]);
    expect(receipt.payload.actorID).not.toBe(MO);
    const actor: any = await db.get(`SELECT roles_json FROM actors WHERE actor_id=?`, [receipt.payload.actorID]);
    expect(JSON.parse(actor.roles_json)).toEqual(["viewer"]);
    // and a viewer cannot register a media source, whatever the client claims
    const src = await g("register_source", { admission: { ...receipt.payload, grantedScopes: ["upload"] }, draft: { label: "x", role: "participant_personal", modalities: ["video"] }, idempotencyKey: "src-viewer" });
    expect(src.ok).toBe(false);
    expect(src.failure.code).toBe("scope_denied");
  });

  it("the invited role is the only role accepted", async () => {
    const mo = await organizer();
    const inv = await invite(mo, "sphere-mo-studio", { role: "viewer" });
    const guest = await deviceKey();
    const r = await (await asDevice(guest))("begin_admission", { invitation: { sphereID: inv.sphereID, joinAttemptReference: inv.reference, requestedRole: "participant" }, deviceKey: guest });
    expect(r.failure.code).toBe("role_mismatch");
    const org = await mo("create_invitation", { sphereID: "sphere-mo-studio", role: "organizer", idempotencyKey: "inv-org" });
    expect(org.failure.code).toBe("invalid_role");
  });

  it("uses are counted and revocation takes effect", async () => {
    const mo = await organizer();
    const inv = await invite(mo, "sphere-mo-studio", { maxUses: 1 });
    const a = await deviceKey();
    expect((await admitWith(await asDevice(a), a, inv)).receipt.ok).toBe(true);
    const b = await deviceKey();
    const second = await admitWith(await asDevice(b), b, inv);
    expect(second.adm.failure.code).toBe("invitation_exhausted");

    const inv2 = await invite(mo, "sphere-mo-studio", { maxUses: 5 });
    expect((await mo("revoke_invitation", { invitationID: inv2.invitationID, idempotencyKey: "rev-1" })).ok).toBe(true);
    const c = await deviceKey();
    expect((await admitWith(await asDevice(c), c, inv2)).adm.failure.code).toBe("invitation_revoked");
  });

  it("only the sphere's organizer can mint invitations", async () => {
    const mo = await organizer();
    const inv = await invite(mo, "sphere-mo-studio");
    const guest = await deviceKey();
    const g = await asDevice(guest);
    const { receipt } = await admitWith(g, guest, inv);
    expect(receipt.ok).toBe(true);
    const r = await g("create_invitation", { sphereID: "sphere-mo-studio", role: "participant", idempotencyKey: "inv-guest" });
    expect(r.ok).toBe(false);
    expect(r.failure.code).toBe("role_denied");
  });
});

describe("a membership is checked against the authenticated principal", () => {
  it("another member cannot replay a receipt that is not theirs", async () => {
    const mo = await deviceKey();
    const moCall = await asDevice(mo);
    await recoverWith(moCall, mo, await operatorGrant(db, MO, NOW_ISO));
    const inv = await invite(moCall, "sphere-mo-studio", { maxUses: 2 });
    const a = await deviceKey(); const aCall = await asDevice(a);
    const b = await deviceKey(); const bCall = await asDevice(b);
    const ra = (await admitWith(aCall, a, inv)).receipt.payload;
    const rb = (await admitWith(bCall, b, inv)).receipt.payload;
    expect(ra.actorID).not.toBe(rb.actorID);

    const stolen = await bCall("load_consent_instruments", ra);
    expect(stolen.ok).toBe(false);
    expect(stolen.failure.code).toBe("membership_not_yours");
    const forgedSession = await bCall("append_consent", { admission: { ...rb, deviceSessionID: ra.deviceSessionID }, selections: [], idempotencyKey: "forge" });
    expect(forgedSession.failure.code).toBe("receipt_mismatch");
    const own = await bCall("load_consent_instruments", rb);
    expect(own.ok).toBe(true);
  });
});

describe("audit and garbage collection", () => {
  it("every mutation leaves an audit row naming the actor and the operation", async () => {
    const before = Number((await db.get<any>(`SELECT count(*) n FROM audit_log`)).n);
    const phone = await deviceKey();
    const callf = await asDevice(phone);
    await recoverWith(callf, phone, await operatorGrant(db, MO, NOW_ISO));
    await invite(callf, "sphere-mo-studio");
    const rows = await db.all<any>(`SELECT operation, actor_id FROM audit_log ORDER BY rowid`);
    expect(rows.length).toBeGreaterThan(before);
    const ops = rows.slice(before).map((r) => r.operation);
    expect(ops).toContain("complete_actor_recovery");
    expect(ops).toContain("create_invitation");
    expect(rows.slice(before).every((r) => r.actor_id === MO)).toBe(true);
  });

  it("gcExpired removes stale nonces, challenges and grants and nothing else", async () => {
    const memberships = Number((await db.get<any>(`SELECT count(*) n FROM memberships`)).n);
    await operatorGrant(db, MO, NOW_ISO, 60); // will be long expired two days on
    const twoDaysOn = new Date((NOW_S + 2 * 86400) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
    const report = await gcExpired(db, twoDaysOn);
    expect(report.nonces).toBeGreaterThan(0);
    expect(report.challenges).toBeGreaterThan(0);
    expect(report.grants).toBeGreaterThan(0);
    expect(Number((await db.get<any>(`SELECT count(*) n FROM token_nonces`)).n)).toBe(0);
    expect(Number((await db.get<any>(`SELECT count(*) n FROM memberships`)).n)).toBe(memberships);
    expect(Number((await db.get<any>(`SELECT count(*) n FROM audit_log`)).n)).toBeGreaterThan(0);
  });
});
