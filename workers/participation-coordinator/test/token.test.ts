// The real token issuer: a signed, expiring, device-bound bearer replaces the
// temporary `dev:<actorId>` prefix. These tests prove the properties that made
// the dev prefix a bypass are gone — you cannot mint a token without the Worker
// secret, cannot name an arbitrary actor, cannot replay or forge a request, and
// a leaked token goes stale.
import { describe, expect, it, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SqliteStore } from "../src/store.js";
import { buildCoordinator, run as runCtx } from "../src/app.js";
import { loadServerKey } from "../src/crypto.js";
import { b64url } from "../src/ids.js";
import {
  deviceTokenAuth, issueDeviceToken, mintToken, verifyToken, tokenRequestMessage,
  bootstrapPrincipal, TokenError, type TokenClaims,
} from "../src/token.js";
import { call } from "./client.js";
import { deviceKey, signBytes, provePossession } from "./p256.js";
import { operatorGrant } from "./v2.js";

const SECRET = b64url(crypto.getRandomValues(new Uint8Array(32)));
const OTHER_SECRET = b64url(crypto.getRandomValues(new Uint8Array(32)));
const NOW_S = 1791780000; // fixed clock
const NOW_ISO = new Date(NOW_S * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
const HINT = "recover@example.com";
const ACTOR = "actor-0001";

let db: SqliteStore;
let ctx: any;

const isoAt = (s: number) => new Date(s * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

async function tokenRequest(dev: any, opts: { issuedAt?: string; nonce?: string; pair?: CryptoKeyPair } = {}) {
  const nonce = opts.nonce ?? b64url(crypto.getRandomValues(new Uint8Array(24)));
  const issuedAt = opts.issuedAt ?? NOW_ISO;
  const msg = tokenRequestMessage(dev.keyID, dev.publicKeyBase64URL, nonce, issuedAt);
  const signatureDERBase64URL = await signBytes(opts.pair ?? dev._pair, msg);
  return {
    deviceKey: { keyID: dev.keyID, algorithm: dev.algorithm, publicKeyBase64URL: dev.publicKeyBase64URL },
    nonce, issuedAt, signatureDERBase64URL,
  };
}

beforeAll(async () => {
  db = await SqliteStore.open(":memory:");
  await db.exec(readFileSync(join(import.meta.dirname, "../schema.sql"), "utf8"));
  ctx = await buildCoordinator(db, {
    key: await loadServerKey(),
    now: () => NOW_ISO,
    auth: deviceTokenAuth(db, SECRET, () => NOW_S),
  });
  await db.run(`INSERT INTO actors (actor_id,account_id,display_name,roles_json,created_at) VALUES (?,?,?,?,?)`,
    [ACTOR, "acct-1", HINT, JSON.stringify(["organizer", "participant", "viewer"]), NOW_ISO]);
});

describe("token request framing matches the app's Swift", () => {
  // tools/token-vectors.swift (a copy of the app's framing) prints exactly this
  // for these inputs; the coordinator must sign/verify the same bytes.
  it("pins the length-prefixed, domain-separated message", () => {
    const msg = tokenRequestMessage("abc123", "BAmMsample", "nonce-xyz", "2026-10-11T19:00:00Z");
    const hex = [...msg].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(msg.length).toBe(102);
    expect(hex).toBe(
      "6d6f74696f6e6d69782e70617274696369706174696f6e2e746f6b656e5f726571756573742e7631" +
      "00000000066162633132330000000a42416d4d73616d706c65000000096e6f6e63652d78797a00" +
      "000014323032362d31302d31315431393a30303a30305a"
    );
  });
});

describe("token issuer: signed, expiring, device-bound", () => {
  it("mints a token for a proven device key and verifies it", async () => {
    const dev = await deviceKey();
    const issued = await issueDeviceToken(db, await tokenRequest(dev), SECRET, NOW_S);
    expect(issued.tokenType).toBe("Bearer");
    expect(issued.expiresIn).toBe(3600);
    expect(issued.actorID).toBe(bootstrapPrincipal(dev.keyID));
    const claims = await verifyToken(SECRET, issued.accessToken, NOW_S);
    expect(claims).toMatchObject({ v: 1, aud: "participation-coordinator", dk: dev.keyID });
    expect(claims!.exp - claims!.iat).toBe(3600);
  });

  it("rejects a token signed with any other secret (not forgeable)", async () => {
    const dev = await deviceKey();
    const issued = await issueDeviceToken(db, await tokenRequest(dev), SECRET, NOW_S);
    expect(await verifyToken(OTHER_SECRET, issued.accessToken, NOW_S)).toBeNull();
    // a hand-rolled token with the wrong secret is refused
    const forged = await mintToken(OTHER_SECRET, { v: 1, aud: "participation-coordinator", sub: ACTOR, dk: dev.keyID, iat: NOW_S, exp: NOW_S + 3600 });
    expect(await verifyToken(SECRET, forged, NOW_S)).toBeNull();
  });

  it("rejects a tampered payload", async () => {
    const dev = await deviceKey();
    const issued = await issueDeviceToken(db, await tokenRequest(dev), SECRET, NOW_S);
    const [, payload, sig] = issued.accessToken.split(".");
    const evil = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(payload.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))));
    evil.sub = "someone-else";
    const tampered = `mmt1.${b64url(new TextEncoder().encode(JSON.stringify(evil)))}.${sig}`;
    expect(await verifyToken(SECRET, tampered, NOW_S)).toBeNull();
  });

  it("rejects an expired token and a stale-issued request", async () => {
    const dev = await deviceKey();
    const issued = await issueDeviceToken(db, await tokenRequest(dev), SECRET, NOW_S, 60);
    expect(await verifyToken(SECRET, issued.accessToken, NOW_S + 61)).toBeNull();
    await expect(issueDeviceToken(db, await tokenRequest(dev, { issuedAt: isoAt(NOW_S - 600) }), SECRET, NOW_S))
      .rejects.toMatchObject({ code: "stale_request" });
  });

  it("rejects a reused nonce, a mismatched key id, and a wrong-key signature", async () => {
    const dev = await deviceKey();
    const req = await tokenRequest(dev);
    await issueDeviceToken(db, req, SECRET, NOW_S);

    const reused = await tokenRequest(dev, { nonce: req.nonce });
    await expect(issueDeviceToken(db, reused, SECRET, NOW_S)).rejects.toMatchObject({ code: "nonce_reused" });

    const other = await deviceKey();
    const mismatched = await tokenRequest(other);
    mismatched.deviceKey.keyID = dev.keyID; // claim dev's key id with other's key
    await expect(issueDeviceToken(db, mismatched, SECRET, NOW_S)).rejects.toMatchObject({ code: "key_id_mismatch" });

    const wrongSigner = await tokenRequest(dev, { pair: other._pair });
    await expect(issueDeviceToken(db, wrongSigner, SECRET, NOW_S)).rejects.toMatchObject({ code: "proof_invalid" });
  });

  it("fails closed when no issuer secret is configured", async () => {
    const dev = await deviceKey();
    const issued = await issueDeviceToken(db, await tokenRequest(dev), SECRET, NOW_S);
    const noIssuer = await buildCoordinator(db, { key: await loadServerKey(), now: () => NOW_ISO, auth: async () => null });
    const r = await call((b, bb) => runCtx(db, b, bb, noIssuer), issued.accessToken, "load_home", {});
    expect(r.ok).toBe(false);
    expect(r.failure.code).toBe("unauthorized");
  });
});

describe("token issuer: authenticates real operations", () => {
  it("a device-bound token runs recovery and the SAME token then resolves to the bound actor", async () => {
    const dev = await deviceKey();
    const token = (await issueDeviceToken(db, await tokenRequest(dev), SECRET, NOW_S)).accessToken;
    const callf = (op: string, payload: any) => call((b, bb) => runCtx(db, b, bb, ctx), token, op, payload);

    // Pre-recovery the principal is the device-derived bootstrap id (no actor fabricated).
    const before = await callf("load_home", {});
    expect(before.ok).toBe(true);
    expect(before.payload.actor).toBeNull();

    // Recover into the seeded actor with an operator grant (the hint is a label only).
    const recoverySecret = await operatorGrant(db, ACTOR, NOW_ISO);
    const begin = await callf("begin_actor_recovery", { accountHint: HINT, deviceKey: dev, recoverySecret });
    expect(begin.ok).toBe(true);
    const proof = {
      challengeID: begin.payload.challengeID, purpose: "account_recovery", keyID: dev.keyID,
      algorithm: "p256-sha256", signatureDERBase64URL: await provePossession(dev._pair, begin.payload),
    };
    const done = await callf("complete_actor_recovery", { request: { accountHint: HINT, deviceKey: dev, recoverySecret }, proof });
    expect(done.ok).toBe(true);
    expect(done.payload.actorID).toBe(ACTOR);

    // The token minted BEFORE binding still works and now resolves to the actor,
    // because auth reads the live device row.
    const after = await callf("load_home", {});
    expect(after.ok).toBe(true);
    expect(after.payload.actor?.actorID).toBe(ACTOR);
  });

  it("a token for an unrelated device cannot act as the recovered actor", async () => {
    const other = await deviceKey();
    const token = (await issueDeviceToken(db, await tokenRequest(other), SECRET, NOW_S)).accessToken;
    const r = await call((b, bb) => runCtx(db, b, bb, ctx), token, "load_home", {});
    expect(r.ok).toBe(true);
    expect(r.payload.actor).toBeNull();
  });
});
