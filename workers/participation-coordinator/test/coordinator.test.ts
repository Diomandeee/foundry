import { describe, expect, it, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SqliteStore } from "../src/store.js";
import { buildCoordinator, run as runCtx } from "../src/app.js";
import { loadServerKey } from "../src/crypto.js";
import { call } from "./client.js";
import { deviceKey, provePossession } from "./p256.js";
import { admitWith, invite, operatorGrant, recoverWith } from "./v2.js";

const here = dirname(fileURLToPath(import.meta.url));
const NOW = "2026-10-11T17:30:00Z";

let ctx: any;
let callf: (op: string, payload: any, bearer?: string) => Promise<any>;
const ALICE = "alice-actor-0001";
const BEARER = `dev:${ALICE}`;

beforeAll(async () => {
  const db = await SqliteStore.open(":memory:");
  await db.exec(readFileSync(join(here, "..", "schema.sql"), "utf8"));
  const key = await loadServerKey();
  ctx = await buildCoordinator(db, { key, now: () => NOW });
  // Seed Alice so load_home has a principal.
  await db.run(`INSERT INTO actors (actor_id,account_id,display_name,roles_json,created_at) VALUES (?,?,?,?,?)`,
    [ALICE, "acct-alice", "Alice", JSON.stringify(["organizer","participant","viewer"]), NOW]);
  callf = (op, payload, bearer = BEARER) => call((b, bb) => runCtx(db, b, bb, ctx), bearer, op, payload);
});

describe("wire contract", () => {
  it("load_home returns zero state for a fresh actor", async () => {
    const r = await callf("load_home", {});
    expect(r.ok).toBe(true);
    expect(r.schema).toBe("motionmix.participation.native_response.v1");
    expect(r.payload).toEqual({ actor: expect.any(Object), series: [], spheres: [], subscriptions: [] });
  });

  it("rejects a missing bearer", async () => {
    const r = await callf("load_home", {}, "");
    expect(r.ok).toBe(false);
    expect(r.failure.code).toBe("unauthorized");
  });

  it("rejects an unknown operation", async () => {
    const r = await callf("do_the_thing", {});
    expect(r.ok).toBe(false);
    expect(r.failure.code).toBe("unknown_operation");
  });
});

describe("full participation flow", () => {
  it("recovery -> sphere -> invitation -> admission -> consent -> source -> handoff -> session", async () => {
    // 1. actor recovery with a real P-256 device proof and an operator grant
    const dev = await deviceKey();
    const { done } = await recoverWith(callf, dev, await operatorGrant(ctx.db, ALICE, NOW), "alice@example.com");
    expect(done.ok).toBe(true);
    expect(done.payload.actorID).toBe(ALICE);
    expect(done.payload.availableRoles).toEqual(["organizer", "participant", "viewer"]);
    expect(done.payload.recoveredAt).toBe(NOW);

    // 2. create a sphere and mint an invitation for it
    const sphere = await callf("create_sphere", { draft: { seriesID: null, title: "Room 1", summary: "", startsAt: null }, idempotencyKey: "sph-1" });
    expect(sphere.ok).toBe(true);
    const inv = await invite(callf, sphere.payload.id);
    expect(inv.url).toBe(`https://join.motionmix.app/s/${sphere.payload.id}?j=${inv.reference}&r=participant`);
    expect(inv.grantedScopes).toEqual(["admission", "media_publish", "playback", "upload"]);

    // 3. a guest device (no actor yet) is admitted; the invitation creates its actor
    const guestDev = await deviceKey();
    const { receipt: admDone } = await admitWith(callf, guestDev, inv);
    expect(admDone.ok).toBe(true);
    expect(admDone.payload.grantedScopes).toContain("upload");
    expect(admDone.payload.actorID).not.toBe(ALICE);
    const receipt = admDone.payload;
    const guest = (op: string, p: any) => callf(op, p, `dev:${receipt.actorID}`);

    // 4. consent instruments + append (append-only revision), as the guest
    const instr = await guest("load_consent_instruments", receipt);
    expect(instr.ok).toBe(true);
    expect(instr.payload.length).toBe(12);
    const sel = [{ instrumentID: "capture_video.v1", instrumentVersion: "1", presentedLanguageSHA256: "0".repeat(64), purpose: "capture_video", decision: "granted" }];
    const c1 = await guest("append_consent", { admission: receipt, selections: sel, expectedPredecessors: [], idempotencyKey: "consent-1" });
    expect(c1.ok).toBe(true);
    expect(c1.payload[0].revision).toBe(1);
    const c2 = await guest("append_consent", { admission: receipt, selections: sel, expectedPredecessors: [], idempotencyKey: "consent-2" });
    expect(c2.payload[0].revision).toBe(2);
    const current = await guest("load_current_consent_receipts", receipt);
    expect(current.payload.length).toBe(1);
    expect(current.payload[0].revision).toBe(2);

    // Alice, who organizes the sphere, still cannot act on the guest's membership.
    const notYours = await callf("load_current_consent_receipts", receipt);
    expect(notYours.ok).toBe(false);
    expect(notYours.failure.code).toBe("membership_not_yours");

    // 5. register a source (needs upload scope, present)
    const src = await guest("register_source", { admission: receipt, draft: { label: "iPhone 16 Pro", role: "participant_personal", modalities: ["video", "pose"], previewEnabled: true, localMasterEnabled: true }, idempotencyKey: "src-1" });
    expect(src.ok).toBe(true);
    expect(src.payload.captureState).toBe("registered");

    // 6. handoff prepare (clip key) -> exchange (the full app's NEW durable key) -> full app session
    const hb = await guest("begin_full_app_handoff_preparation", { admission: receipt, deviceKey: guestDev });
    expect(hb.ok).toBe(true);
    const hp = { challengeID: hb.payload.challengeID, purpose: "app_clip_handoff_preparation", keyID: guestDev.keyID, algorithm: "p256-sha256", signatureDERBase64URL: await provePossession(guestDev._pair, hb.payload) };
    const handoff = await guest("prepare_full_app_handoff", { admission: receipt, proof: hp });
    expect(handoff.ok).toBe(true);
    expect(handoff.payload.serverKeyID).toBeTruthy();
    const ref = { reference: handoff.payload.reference, expiresAt: handoff.payload.expiresAt, serverKeyID: handoff.payload.serverKeyID, signatureBase64URL: handoff.payload.signatureBase64URL };

    const fullDev = await deviceKey();
    const eb = await guest("begin_full_app_handoff_exchange", { reference: ref, deviceKey: fullDev });
    expect(eb.ok).toBe(true);
    const ep = { challengeID: eb.payload.challengeID, purpose: "full_app_handoff_exchange", keyID: fullDev.keyID, algorithm: "p256-sha256", signatureDERBase64URL: await provePossession(fullDev._pair, eb.payload) };
    const session = await guest("exchange_full_app_handoff", { reference: ref, proof: ep });
    expect(session.ok).toBe(true);
    expect(session.payload.schema).toBe("motionmix.participation.full_app_session.v1");
    expect(session.payload.admission.grantedScopes).toContain("upload");
    // the exchange bound the full app's key to the guest actor
    const bound: any = await ctx.db.get(`SELECT actor_id FROM devices WHERE key_id=?`, [fullDev.keyID]);
    expect(bound.actor_id).toBe(receipt.actorID);

    // 7. session resume with the returned handle, from the bound full-app key
    const rb = await guest("begin_full_app_session_resume", { recoveryHandle: session.payload.recoveryHandle, deviceKey: fullDev });
    const rp = { challengeID: rb.payload.challengeID, purpose: "full_app_session_resume", keyID: fullDev.keyID, algorithm: "p256-sha256", signatureDERBase64URL: await provePossession(fullDev._pair, rb.payload) };
    const resume = await guest("resume_full_app_session", { recoveryHandle: session.payload.recoveryHandle, proof: rp });
    expect(resume.ok).toBe(true);
    expect(resume.payload.admission.membershipID).toBe(receipt.membershipID);

    // 8. a stranger's key cannot resume that session
    const stranger = await deviceKey();
    const sb = await guest("begin_full_app_session_resume", { recoveryHandle: session.payload.recoveryHandle, deviceKey: stranger });
    const sp = { challengeID: sb.payload.challengeID, purpose: "full_app_session_resume", keyID: stranger.keyID, algorithm: "p256-sha256", signatureDERBase64URL: await provePossession(stranger._pair, sb.payload) };
    const denied = await guest("resume_full_app_session", { recoveryHandle: session.payload.recoveryHandle, proof: sp });
    expect(denied.ok).toBe(false);
    expect(denied.failure.code).toBe("actor_mismatch");
  });
});
