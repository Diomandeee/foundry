import { describe, expect, it, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SqliteStore } from "../src/store.js";
import { buildCoordinator, run as runCtx } from "../src/app.js";
import { loadServerKey } from "../src/crypto.js";
import { call } from "./client.js";
import { deviceKey, proveAdmission, provePossession } from "./p256.js";

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
  it("recovery -> sphere -> admission -> consent -> source -> handoff -> session", async () => {
    // 1. actor recovery with a real P-256 device proof
    const dev = await deviceKey();
    const begin = await callf("begin_actor_recovery", { accountHint: "alice@example.com", deviceKey: dev });
    expect(begin.ok).toBe(true);
    const proof = { challengeID: begin.payload.challengeID, purpose: "account_recovery", keyID: dev.keyID, algorithm: "p256-sha256", signatureDERBase64URL: await provePossession(dev._pair, begin.payload) };
    const done = await callf("complete_actor_recovery", { request: { accountHint: "alice@example.com", deviceKey: dev }, proof });
    expect(done.ok).toBe(true);
    expect(done.payload.availableRoles).toEqual(["organizer", "participant", "viewer"]);
    expect(done.payload.recoveredAt).toBe(NOW);

    // 2. create a sphere
    const sphere = await callf("create_sphere", { draft: { seriesID: null, title: "Room 1", summary: "", startsAt: null }, idempotencyKey: "sph-1" });
    expect(sphere.ok).toBe(true);

    // 3. admission for a second device
    const guestDev = await deviceKey();
    const adm = await callf("begin_admission", { invitation: { sphereID: sphere.payload.id, joinAttemptReference: "join-abc", requestedRole: "participant" }, deviceKey: guestDev });
    expect(adm.ok).toBe(true);
    // bind guest device to Alice so admission can resolve an actor
    const cp = { challengeID: adm.payload.challengeID, purpose: "admission", keyID: guestDev.keyID, algorithm: "p256-sha256", signatureDERBase64URL: await proveAdmission(guestDev._pair, adm.payload) };
    await ctx.db.run(`UPDATE devices SET actor_id=? WHERE key_id=?`, [ALICE, guestDev.keyID]);
    const admDone = await callf("complete_admission", cp);
    expect(admDone.ok).toBe(true);
    expect(admDone.payload.grantedScopes).toContain("upload");
    const receipt = admDone.payload;

    // 4. consent instruments + append (append-only revision)
    const instr = await callf("load_consent_instruments", receipt);
    expect(instr.ok).toBe(true);
    expect(instr.payload.length).toBe(12);
    const sel = [{ instrumentID: "capture_video.v1", instrumentVersion: "1", presentedLanguageSHA256: "0".repeat(64), purpose: "capture_video", decision: "granted" }];
    const c1 = await callf("append_consent", { admission: receipt, selections: sel, expectedPredecessors: [], idempotencyKey: "consent-1" });
    expect(c1.ok).toBe(true);
    expect(c1.payload[0].revision).toBe(1);
    const c2 = await callf("append_consent", { admission: receipt, selections: sel, expectedPredecessors: [], idempotencyKey: "consent-2" });
    expect(c2.payload[0].revision).toBe(2);
    const current = await callf("load_current_consent_receipts", receipt);
    expect(current.payload.length).toBe(1);
    expect(current.payload[0].revision).toBe(2);

    // 5. register a source (needs upload scope, present)
    const src = await callf("register_source", { admission: receipt, draft: { label: "iPhone 16 Pro", role: "participant_personal", modalities: ["video", "pose"], previewEnabled: true, localMasterEnabled: true }, idempotencyKey: "src-1" });
    expect(src.ok).toBe(true);
    expect(src.payload.captureState).toBe("registered");

    // 6. handoff prepare -> exchange -> full app session
    const hb = await callf("begin_full_app_handoff_preparation", { admission: receipt, deviceKey: guestDev });
    expect(hb.ok).toBe(true);
    const hp = { challengeID: hb.payload.challengeID, purpose: "app_clip_handoff_preparation", keyID: guestDev.keyID, algorithm: "p256-sha256", signatureDERBase64URL: await provePossession(guestDev._pair, hb.payload) };
    const handoff = await callf("prepare_full_app_handoff", { admission: receipt, proof: hp });
    expect(handoff.ok).toBe(true);
    expect(handoff.payload.serverKeyID).toBeTruthy();
    const ref = { reference: handoff.payload.reference, expiresAt: handoff.payload.expiresAt, serverKeyID: handoff.payload.serverKeyID, signatureBase64URL: handoff.payload.signatureBase64URL };

    const eb = await callf("begin_full_app_handoff_exchange", { reference: ref, deviceKey: guestDev });
    const ep = { challengeID: eb.payload.challengeID, purpose: "full_app_handoff_exchange", keyID: guestDev.keyID, algorithm: "p256-sha256", signatureDERBase64URL: await provePossession(guestDev._pair, eb.payload) };
    const session = await callf("exchange_full_app_handoff", { reference: ref, proof: ep });
    expect(session.ok).toBe(true);
    expect(session.payload.schema).toBe("motionmix.participation.full_app_session.v1");
    expect(session.payload.admission.grantedScopes).toContain("upload");

    // 7. session resume with the returned handle
    const rb = await callf("begin_full_app_session_resume", { recoveryHandle: session.payload.recoveryHandle, deviceKey: guestDev });
    const rp = { challengeID: rb.payload.challengeID, purpose: "full_app_session_resume", keyID: guestDev.keyID, algorithm: "p256-sha256", signatureDERBase64URL: await provePossession(guestDev._pair, rb.payload) };
    const resume = await callf("resume_full_app_session", { recoveryHandle: session.payload.recoveryHandle, proof: rp });
    expect(resume.ok).toBe(true);
    expect(resume.payload.admission.membershipID).toBe(receipt.membershipID);
  });
});
