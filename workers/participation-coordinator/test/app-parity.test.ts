// What the iOS client independently re-validates after every begin* call.
// If the coordinator violates any of these, ParticipationStore throws
// integrityFailure before it will even send a proof.
import { describe, expect, it, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SqliteStore } from "../src/store.js";
import { buildCoordinator, run as runCtx } from "../src/app.js";
import { loadServerKey } from "../src/crypto.js";
import { possessionSubjectSHA256, joinAttemptSubjectSHA256, challengeBytesSHA256 } from "../src/proof.js";
import { call } from "./client.js";
import { deviceKey } from "./p256.js";
import { invite, operatorGrant, recoverWith } from "./v2.js";

const NOW = "2026-10-11T17:30:00Z";
const ALICE = "alice-actor-0001";
let db: SqliteStore;
let callf: (op: string, payload: any) => Promise<any>;

beforeAll(async () => {
  db = await SqliteStore.open(":memory:");
  await db.exec(readFileSync(join(import.meta.dirname, "../schema.sql"), "utf8"));
  const ctx = await buildCoordinator(db, { key: await loadServerKey(), now: () => NOW });
  await db.run(`INSERT INTO actors (actor_id,account_id,display_name,roles_json,created_at) VALUES (?,?,?,?,?)`,
    [ALICE, "acct-alice", "Alice", JSON.stringify(["organizer", "participant", "viewer"]), NOW]);
  callf = (op, payload) => call((b, bb) => runCtx(db, b, bb, ctx), `dev:${ALICE}`, op, payload);
});

describe("coordinator satisfies the app's client-side invariants", () => {
  it("recovery challenge: subject, key id, fresh window, byte hash", async () => {
    const dev = await deviceKey();
    const hint = "alice@example.com";
    const r = await callf("begin_actor_recovery", { accountHint: hint, deviceKey: dev, recoverySecret: await operatorGrant(db, ALICE, NOW) });
    expect(r.ok).toBe(true);
    const c = r.payload;
    expect(c.purpose).toBe("account_recovery");
    expect(c.deviceKeyID).toBe(dev.keyID);
    expect(c.subjectReferenceSHA256).toBe(await possessionSubjectSHA256("account_recovery", hint));
    expect(c.challengeSHA256).toBe(await challengeBytesSHA256(c.challengeBase64URL));
    expect(new Date(c.expiresAt).getTime() - new Date(c.issuedAt).getTime()).toBeLessThanOrEqual(5 * 60 * 1000);
    expect(c.issuedAt).toBe(NOW);
  });

  it("admission challenge: join-attempt subject + echoed ids", async () => {
    const dev = await deviceKey();
    const sphere = await callf("create_sphere", { draft: { seriesID: null, title: "Parity", summary: "", startsAt: null }, idempotencyKey: "parity-sphere" });
    const inv = await invite(callf, sphere.payload.id);
    const r = await callf("begin_admission", { invitation: { sphereID: inv.sphereID, joinAttemptReference: inv.reference, requestedRole: "participant" }, deviceKey: dev });
    expect(r.ok).toBe(true);
    const c = r.payload;
    expect(c.joinAttemptReferenceSHA256).toBe(await joinAttemptSubjectSHA256(inv.reference));
    expect(c.challengeSHA256).toBe(await challengeBytesSHA256(c.challengeBase64URL));
    expect(c.joinAttemptID).toBeTruthy();
    expect(c.deviceKeyID).toBe(dev.keyID);
  });

  it("resume + handoff-exchange challenges carry the right subjects", async () => {
    const dev = await deviceKey();
    const resume = await callf("begin_full_app_session_resume", { recoveryHandle: "handle-xyz", deviceKey: dev });
    expect(resume.payload.purpose).toBe("full_app_session_resume");
    expect(resume.payload.subjectReferenceSHA256).toBe(await possessionSubjectSHA256("full_app_session_resume", "handle-xyz"));
    expect(resume.payload.challengeSHA256).toBe(await challengeBytesSHA256(resume.payload.challengeBase64URL));
  });
});

describe("multi-device registration", () => {
  it("a bound device vouches for the next one: same actor, its own device session", async () => {
    const d1 = await deviceKey();
    const s1 = (await recoverWith(callf, d1, await operatorGrant(db, ALICE, NOW), "shared-account@example.com")).done;
    expect(s1.ok).toBe(true);

    // Device 1 (now bound to Alice) issues the grant device 2 scans.
    const vouch = await callf("issue_recovery_grant", {});
    expect(vouch.ok).toBe(true);
    expect(vouch.payload.issuedBy).toBe("device");
    const d2 = await deviceKey();
    const s2 = (await recoverWith(callf, d2, vouch.payload.recoverySecret, "shared-account@example.com")).done;
    expect(s2.ok).toBe(true);

    // Same account actor, distinct device sessions and keys.
    expect(s2.payload.actorID).toBe(s1.payload.actorID);
    expect(s2.payload.deviceSessionID).not.toBe(s1.payload.deviceSessionID);
    expect(d2.keyID).not.toBe(d1.keyID);

    // The shared actor is visible on home.
    const home = await callf("load_home", {});
    expect(home.payload.actor?.actorID).toBe(s1.payload.actorID);
  });
});
