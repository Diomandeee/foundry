import { describe, expect, it, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SqliteStore } from "../src/store.js";
import { buildCoordinator, run as runCtx } from "../src/app.js";
import { loadServerKey, derToP1363, verifyDeviceProof } from "../src/crypto.js";
import { canonicalJson, iso } from "../src/canonical.js";
import { b64url, b64urlDecode } from "../src/ids.js";
import { call } from "./client.js";
import { deviceKey, proveAdmission, provePossession, sign } from "./p256.js";
import { invite, operatorGrant } from "./v2.js";

const NOW = "2026-10-11T17:30:00Z";
const ALICE = "alice-actor-0001";

let db: SqliteStore;
let callf: (op: string, payload: any, bearer?: string) => Promise<any>;

beforeAll(async () => {
  db = await SqliteStore.open(":memory:");
  await db.exec(readFileSync(join(import.meta.dirname, "../schema.sql"), "utf8"));
  const ctx = await buildCoordinator(db, { key: await loadServerKey(), now: () => NOW });
  await db.run(`INSERT INTO actors (actor_id,account_id,display_name,roles_json,created_at) VALUES (?,?,?,?,?)`,
    [ALICE, "acct-alice", "Alice", JSON.stringify(["organizer", "participant", "viewer"]), NOW]);
  callf = (op, payload, bearer = `dev:${ALICE}`) => call((b, bb) => runCtx(db, b, bb, ctx), bearer, op, payload);
});

describe("canonical encoding matches the Swift client", () => {
  it("sorts keys and drops undefined (JSONEncoder .sortedKeys)", () => {
    expect(canonicalJson({ b: 1, a: 2, c: undefined })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ z: [{ y: 1, x: 2 }] })).toBe('{"z":[{"x":2,"y":1}]}');
  });

  it("emits whole-second iso8601 dates (Foundation .iso8601)", () => {
    expect(iso(new Date("2026-10-11T17:30:00.789Z"))).toBe(NOW);
    expect(iso("2026-10-11T17:30:00Z")).toBe(NOW);
  });
});

describe("DER device signatures (the iOS wire format)", () => {
  it("converts DER to IEEE-P1363 before WebCrypto verify", async () => {
    const dev = await deviceKey();
    const msg = "challenge-string";
    const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, dev._pair.privateKey, new TextEncoder().encode(msg));
    const der = b64urlDecode(await sign(dev._pair, msg));
    const p1363 = derToP1363(der);
    expect(p1363.length).toBe(64);
    const pub = await crypto.subtle.importKey("raw", b64urlDecode(dev.publicKeyBase64URL), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const bytes = new TextEncoder().encode(msg);
    // WebCrypto verifies P1363 raw, not DER — this was the original bug.
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, b64urlDecode(b64url(p1363)), bytes)).toBe(true);
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, der, bytes)).toBe(false);
    // verifyDeviceProof accepts the DER the iOS client actually sends.
    expect(await verifyDeviceProof(dev.publicKeyBase64URL, bytes, b64url(der))).toBe(true);
    expect(b64url(new Uint8Array(sig))).not.toBe("");
  });

  it("passes a raw 64-byte signature through unchanged", () => {
    const raw = new Uint8Array(64).fill(7);
    expect(derToP1363(raw)).toBe(raw);
  });
});

describe("coordinator invariants", () => {
  it("consumes a device challenge exactly once (no proof replay)", async () => {
    const dev = await deviceKey();
    const recoverySecret = await operatorGrant(db, ALICE, NOW);
    const begin = await callf("begin_actor_recovery", { accountHint: "replay@example.com", deviceKey: dev, recoverySecret });
    const proof = { challengeID: begin.payload.challengeID, purpose: "account_recovery", keyID: dev.keyID, algorithm: "p256-sha256", signatureDERBase64URL: await provePossession(dev._pair, begin.payload) };
    const first = await callf("complete_actor_recovery", { request: { accountHint: "replay@example.com", deviceKey: dev }, proof });
    expect(first.ok).toBe(true);
    const replay = await callf("complete_actor_recovery", { request: { accountHint: "replay@example.com", deviceKey: dev }, proof });
    expect(replay.ok).toBe(false);
    expect(["no_challenge", "challenge_consumed"]).toContain(replay.failure.code);
  });

  it("rejects an idempotency key reused with a different payload", async () => {
    const a = await callf("create_sphere", { draft: { seriesID: null, title: "One", summary: "", startsAt: null }, idempotencyKey: "conflict-1" });
    expect(a.ok).toBe(true);
    const b = await callf("create_sphere", { draft: { seriesID: null, title: "Two", summary: "", startsAt: null }, idempotencyKey: "conflict-1" });
    expect(b.ok).toBe(false);
    expect(b.failure.code).toBe("idempotency_conflict");
  });

  it("does not fabricate an actor for an unknown principal", async () => {
    const r = await callf("load_home", {}, "dev:nobody-0002");
    expect(r.ok).toBe(true);
    expect(r.payload.actor).toBeNull();
  });
});

describe("participation -> knowledge graph emission", () => {
  it("emits joinable triples for admission and is a no-op when unconfigured", async () => {
    const db2 = await SqliteStore.open(":memory:");
    await db2.exec(readFileSync(join(import.meta.dirname, "../schema.sql"), "utf8"));
    const { RecordingGraphEmitter, graphTriples } = await import("../src/graph.js");
    const sink = new RecordingGraphEmitter();
    const ctx = await buildCoordinator(db2, { key: await loadServerKey(), now: () => NOW, graph: sink });
    await db2.run(`INSERT INTO actors (actor_id,account_id,display_name,roles_json,created_at) VALUES (?,?,?,?,?)`,
      [ALICE, "acct-alice", "Alice", JSON.stringify(["organizer", "participant"]), NOW]);
    const run2 = (op: string, p: any) => call((b, bb) => runCtx(db2, b, bb, ctx), `dev:${ALICE}`, op, p);

    const sphere = await run2("create_sphere", { draft: { seriesID: null, title: "Graph", summary: "", startsAt: null }, idempotencyKey: "graph-sphere" });
    const sphereId = sphere.payload.id;
    const inv = await invite(run2, sphereId);
    const dev = await deviceKey();
    await run2("begin_admission", { invitation: { sphereID: sphereId, joinAttemptReference: inv.reference, requestedRole: "participant" }, deviceKey: dev });
    const ch: any = await db2.get(`SELECT * FROM challenges WHERE purpose='admission' ORDER BY issued_at DESC LIMIT 1`);
    const proof = { challengeID: ch.challenge_id, purpose: "admission", keyID: dev.keyID, algorithm: "p256-sha256", signatureDERBase64URL: await proveAdmission(dev._pair, { challengeID: ch.challenge_id, joinAttemptID: ch.join_attempt_id, joinAttemptReferenceSHA256: ch.subject_ref_sha256, deviceSessionID: ch.device_session_id, deviceKeyID: ch.device_key_id, challengeSHA256: ch.challenge_sha256, challengeBase64URL: ch.challenge_b64url }) };
    const adm = await run2("complete_admission", proof);
    expect(adm.ok).toBe(true);

    const subjects = sink.triples.map((t) => `${t.subject} ${t.predicate} ${t.object}`);
    expect(subjects).toContain(`actor:${adm.payload.actorID} admitted_to sphere:${sphereId}`);
    expect(subjects.some((s) => s.includes("granted_scope upload"))).toBe(true);
    expect(sink.triples.every((t) => t.source === "participation")).toBe(true);

    // Pure function with no emitter configured -> nothing observed, still works.
    expect(graphTriples("load_home", { actor: null })).toEqual([]);
  });
});
