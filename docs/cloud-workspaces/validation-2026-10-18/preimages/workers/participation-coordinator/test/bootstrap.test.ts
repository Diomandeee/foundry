// "First user" prescription: a fresh database already contains the account, its
// series and home sphere, and every device that recovers with the matching hint
// lands in that same actor — no client-side naming, no lazy actor creation.
import { describe, expect, it, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SqliteStore } from "../src/store.js";
import { buildCoordinator, run as runCtx } from "../src/app.js";
import { loadServerKey } from "../src/crypto.js";
import { b64url } from "../src/ids.js";
import { deviceTokenAuth, issueDeviceToken } from "../src/token.js";
import { DEFAULT_FIRST_USER, bootstrapFirstUser, bootstrapStatements, resetStatements, firstUserExists, ensureFirstUser } from "../src/bootstrap.js";
import { call } from "./client.js";
import { deviceKey, provePossession, proveAdmission } from "./p256.js";
import { tokenRequestMessage } from "../src/token.js";
import { signBytes } from "./p256.js";

const SECRET = b64url(crypto.getRandomValues(new Uint8Array(32)));
const NOW_S = 1791780000;
const NOW_ISO = new Date(NOW_S * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

let db: SqliteStore;
let ctx: any;

async function freshDb() {
  const d = await SqliteStore.open(":memory:");
  await d.exec(readFileSync(join(import.meta.dirname, "../schema.sql"), "utf8"));
  return d;
}

async function token(dev: any): Promise<string> {
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(24)));
  const sig = await signBytes(dev._pair, tokenRequestMessage(dev.keyID, dev.publicKeyBase64URL, nonce, NOW_ISO));
  const issued = await issueDeviceToken(db, {
    deviceKey: { keyID: dev.keyID, algorithm: dev.algorithm, publicKeyBase64URL: dev.publicKeyBase64URL },
    nonce, issuedAt: NOW_ISO, signatureDERBase64URL: sig,
  }, SECRET, NOW_S);
  return issued.accessToken;
}

async function recover(hint: string, dev: any): Promise<any> {
  const bearer = await token(dev);
  const callf = (op: string, payload: any) => call((b, bb) => runCtx(db, b, bb, ctx), bearer, op, payload);
  const begin = await callf("begin_actor_recovery", { accountHint: hint, deviceKey: dev });
  const proof = {
    challengeID: begin.payload.challengeID, purpose: "account_recovery", keyID: dev.keyID,
    algorithm: "p256-sha256", signatureDERBase64URL: await provePossession(dev._pair, begin.payload),
  };
  const done = await callf("complete_actor_recovery", { request: { accountHint: hint, deviceKey: dev }, proof });
  return { bearer, callf, done };
}

beforeAll(async () => {
  db = await freshDb();
  ctx = await buildCoordinator(db, { key: await loadServerKey(), now: () => NOW_ISO, auth: deviceTokenAuth(db, SECRET, () => NOW_S) });
});

describe("prescribed first user", () => {
  it("bootstraps an account, series, sphere, and subscription", async () => {
    expect(await firstUserExists(db)).toBe(false);
    const report = await bootstrapFirstUser(db, DEFAULT_FIRST_USER, NOW_ISO);
    expect(report.actorID).toBe("actor-mo-0001");
    expect(await firstUserExists(db)).toBe(true);

    const actor: any = await db.get(`SELECT * FROM actors WHERE actor_id=?`, ["actor-mo-0001"]);
    expect(actor.display_name).toBe("mo-motionmix");
    expect(JSON.parse(actor.roles_json)).toEqual(["organizer", "participant", "viewer"]);
    expect(await db.get(`SELECT 1 FROM series WHERE series_id=?`, ["series-mo-0001"])).toBeTruthy();
    expect(await db.get(`SELECT 1 FROM spheres WHERE sphere_id=?`, ["sphere-mo-studio"])).toBeTruthy();
    expect(await db.get(`SELECT 1 FROM subscriptions WHERE actor_id=?`, ["actor-mo-0001"])).toBeTruthy();
  });

  it("is idempotent: re-running never duplicates", async () => {
    for (let i = 0; i < 3; i++) await bootstrapFirstUser(db, DEFAULT_FIRST_USER, NOW_ISO);
    const count = async (sql: string) => (await db.get<any>(sql))?.n;
    expect(await count(`SELECT count(*) n FROM actors WHERE actor_id='actor-mo-0001'`)).toBe(1);
    expect(await count(`SELECT count(*) n FROM series WHERE series_id='series-mo-0001'`)).toBe(1);
    expect(await count(`SELECT count(*) n FROM spheres WHERE sphere_id='sphere-mo-studio'`)).toBe(1);
    expect(await count(`SELECT count(*) n FROM subscriptions WHERE actor_id='actor-mo-0001'`)).toBe(1);
    expect(bootstrapStatements().length).toBe(4);
  });

  it("reset clears derived tables but keeps consent instruments", async () => {
    const d = await freshDb();
    await d.run(`INSERT INTO consent_instruments (instrument_id,version,purpose,locale,language_sha256,title,explanation,consequence_of_denial) VALUES ('x','1','capture_video','en-US','h','t','e','c')`);
    await bootstrapFirstUser(d, DEFAULT_FIRST_USER, NOW_ISO);
    expect(await firstUserExists(d)).toBe(true);
    for (const s of resetStatements()) await d.run(s.sql, s.params);
    expect(await firstUserExists(d)).toBe(false);
    expect(await d.get(`SELECT 1 FROM consent_instruments WHERE instrument_id='x'`)).toBeTruthy();
  });
});

describe("the first user's devices land in the prescribed account", () => {
  it("recovering with the default hint binds to actor-mo-0001 and shows the seeded home", async () => {
    const dev = await deviceKey();
    const { bearer, callf, done } = await recover(DEFAULT_FIRST_USER.displayName, dev);
    expect(done.ok).toBe(true);
    expect(done.payload.actorID).toBe("actor-mo-0001");
    expect(done.payload.accountID).toBe("account-mo-0001");

    const home = await callf("load_home", {});
    expect(home.ok).toBe(true);
    expect(home.payload.actor?.actorID).toBe("actor-mo-0001");
    expect(home.payload.series.map((s: any) => s.id)).toContain("series-mo-0001");
    expect(home.payload.spheres.map((s: any) => s.id)).toContain("sphere-mo-studio");
    expect(home.payload.subscriptions.map((s: any) => s.seriesID)).toContain("series-mo-0001");
    expect(typeof bearer).toBe("string");
  });

  it("a second iPhone recovers into the same prescribed actor, its own device session", async () => {
    const first = await deviceKey();
    const a = await recover(DEFAULT_FIRST_USER.displayName, first);
    const second = await deviceKey();
    const b = await recover(DEFAULT_FIRST_USER.displayName, second);
    expect(b.done.payload.actorID).toBe(a.done.payload.actorID);
    expect(b.done.payload.actorID).toBe("actor-mo-0001");
    expect(b.done.payload.deviceSessionID).not.toBe(a.done.payload.deviceSessionID);
  });
});

describe("ensureFirstUser (auto-prescription on a fresh database)", () => {
  it("prescribes once, then no-ops while any actor exists", async () => {
    const d = await freshDb();
    const first = await ensureFirstUser(d, DEFAULT_FIRST_USER, NOW_ISO);
    expect(first?.actorID).toBe("actor-mo-0001");
    expect(await ensureFirstUser(d, DEFAULT_FIRST_USER, NOW_ISO)).toBeNull();
  });

  it("never overwrites a database that already has a real actor", async () => {
    const d = await freshDb();
    await d.run(
      `INSERT INTO actors (actor_id,account_id,display_name,roles_json,created_at) VALUES (?,?,?,?,?)`,
      ["actor-real-0002", "account-real-0002", "someone-else", '["participant"]', NOW_ISO],
    );
    expect(await ensureFirstUser(d, DEFAULT_FIRST_USER, NOW_ISO)).toBeNull();
    expect(await firstUserExists(d)).toBe(false);
    expect(await d.get(`SELECT 1 FROM actors WHERE actor_id='actor-real-0002'`)).toBeTruthy();
  });
});

describe("account recovery binds the challenged device session", () => {
  it("complete_actor_recovery returns the same deviceSessionID the challenge carried (no 'pending' placeholder)", async () => {
    const dev = await deviceKey();
    const bearer = await token(dev);
    const callf = (op: string, payload: any) => call((b, bb) => runCtx(db, b, bb, ctx), bearer, op, payload);
    const begin = await callf("begin_actor_recovery", {
      accountHint: DEFAULT_FIRST_USER.displayName, deviceKey: dev,
    });
    expect(begin.ok).toBe(true);
    // The iOS client rejects recovery when the challenge carries a placeholder.
    expect(begin.payload.deviceSessionID).not.toBe("pending");
    expect(typeof begin.payload.deviceSessionID).toBe("string");
    expect(begin.payload.deviceSessionID.length).toBeGreaterThan(8);

    const proof = {
      challengeID: begin.payload.challengeID, purpose: "account_recovery", keyID: dev.keyID,
      algorithm: "p256-sha256", signatureDERBase64URL: await provePossession(dev._pair, begin.payload),
    };
    const done = await callf("complete_actor_recovery", {
      request: { accountHint: DEFAULT_FIRST_USER.displayName, deviceKey: dev }, proof,
    });
    expect(done.ok).toBe(true);
    // ParticipationStore.recoverActor guards this equality; a mismatch surfaces
    // on device as "Participation unavailable" even though the server succeeded.
    expect(done.payload.deviceSessionID).toBe(begin.payload.deviceSessionID);

    const row: any = await db.get(`SELECT actor_id FROM device_sessions WHERE device_session_id=?`, [done.payload.deviceSessionID]);
    expect(row?.actor_id).toBe("actor-mo-0001");
  });
});

describe("the first user can be admitted to the prescribed sphere", () => {
  it("begin_admission -> complete_admission creates the first membership", async () => {
    const dev = await deviceKey();
    const { callf } = await recover(DEFAULT_FIRST_USER.displayName, dev);

    const adm = await callf("begin_admission", {
      invitation: { sphereID: "sphere-mo-studio", joinAttemptReference: "first-admission-test", requestedRole: "participant" },
      deviceKey: dev,
    });
    expect(adm.ok).toBe(true);

    const proof = {
      challengeID: adm.payload.challengeID, purpose: "admission", keyID: dev.keyID,
      algorithm: "p256-sha256", signatureDERBase64URL: await proveAdmission(dev._pair, adm.payload),
    };
    const receipt = await callf("complete_admission", proof);
    expect(receipt.ok).toBe(true);
    expect(receipt.payload.actorID).toBe("actor-mo-0001");
    expect(receipt.payload.sphereID).toBe("sphere-mo-studio");
    expect(receipt.payload.membershipState).toBe("admitted");
    expect(receipt.payload.grantedScopes).toEqual(["admission", "media_publish", "playback", "upload"]);

    const m: any = await db.get(`SELECT * FROM memberships WHERE membership_id=?`, [receipt.payload.membershipID]);
    expect(m?.actor_id).toBe("actor-mo-0001");
    expect(m?.sphere_id).toBe("sphere-mo-studio");
    expect(m?.state).toBe("admitted");

    // the join attempt is consumed exactly once
    const consumed = (await db.get<any>(`SELECT count(*) n FROM join_attempts WHERE consumed_at IS NOT NULL`))?.n;
    expect(consumed).toBe(1);
  });
});
