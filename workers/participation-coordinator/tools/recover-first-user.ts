// Live proof that the prescribed first user is reachable from a device under v2:
// device 1 recovers with an OPERATOR grant (the Fabric path), lands in the
// prescribed actor with its own device session, and sees the prescribed
// series/sphere/subscription in load_home. Device 1 then VOUCHES for device 2,
// which recovers into the same actor with its own session. A third device that
// tries the v1 hint-only recovery is refused.
//
//   OPERATOR_BEARER=... npx tsx tools/recover-first-user.ts https://participation-coordinator.<acct>.workers.dev
import { canonicalJson } from "../src/canonical.js";
import { sha256hex } from "../src/ids.js";
import { issueTokenFor } from "./token-client.js";
import { operatorGrant } from "./operator-grant.js";
import { deviceKey, provePossession } from "../test/p256.js";

const base = (process.argv[2] ?? "http://localhost:8791").replace(/\/$/, "");
const HINT = process.env.FIRST_USER_HINT ?? "mo-motionmix";
const ACTOR = process.env.FIRST_USER_ACTOR ?? "actor-mo-0001";
const OPERATOR_BEARER = process.env.OPERATOR_BEARER;

let failures = 0;
const check = (name: string, cond: boolean, detail?: unknown) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${cond || detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`);
  if (!cond) failures++;
};

async function callop(bearer: string, operation: string, payload: unknown): Promise<any> {
  const payloadData = canonicalJson(payload);
  const digest = await sha256hex(new TextEncoder().encode(payloadData));
  const requestId = await sha256hex(`${operation}:${digest}`);
  const envelope = { schema: "motionmix.participation.native_request.v1", operation, request_id: requestId, request_digest_sha256: digest, payload };
  const res = await fetch(base, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` }, body: JSON.stringify(envelope) });
  const body: any = await res.json();
  if (body.ok) {
    const reenc = await sha256hex(new TextEncoder().encode(canonicalJson(body.payload)));
    if (reenc !== body.payload_sha256) throw new Error(`payload_sha256 mismatch for ${operation}`);
  }
  return body;
}

async function recover(recoverySecret: string | undefined) {
  const dev = await deviceKey();
  const bearer = await issueTokenFor(base, dev);
  const begin = await callop(bearer, "begin_actor_recovery", { accountHint: HINT, deviceKey: dev, ...(recoverySecret ? { recoverySecret } : {}) });
  if (!begin.ok) return { bearer, keyID: dev.keyID, begin, done: begin };
  const proof = {
    challengeID: begin.payload.challengeID, purpose: "account_recovery", keyID: dev.keyID,
    algorithm: "p256-sha256", signatureDERBase64URL: await provePossession(dev._pair, begin.payload),
  };
  const done = await callop(bearer, "complete_actor_recovery", {
    request: { accountHint: HINT, deviceKey: dev, recoverySecret }, proof,
  });
  return { bearer, keyID: dev.keyID, begin, done };
}

async function main() {
  if (!OPERATOR_BEARER) { console.error("OPERATOR_BEARER is required (the server compares its sha256)."); process.exit(2); }

  const refused = await recover(undefined);
  check("v1 hint-only recovery is refused", refused.done.ok === false && refused.done.failure?.code === "recovery_grant_required", refused.done.failure);

  const grant = await operatorGrant(base, OPERATOR_BEARER, ACTOR, 300, "recover-first-user");
  check("operator grant issued", grant.issuedBy === "operator" && grant.actorID === ACTOR, grant);

  const a = await recover(grant.recoverySecret);
  check("device 1 recovery ok", a.done.ok === true, a.done.failure);
  check("challenge deviceSessionID is real (not 'pending')", a.begin.payload?.deviceSessionID !== "pending", a.begin.payload?.deviceSessionID);
  check("returned deviceSessionID equals the challenge's", a.done.payload?.deviceSessionID === a.begin.payload?.deviceSessionID, { challenge: a.begin.payload?.deviceSessionID, done: a.done.payload?.deviceSessionID });
  check(`lands in prescribed actor ${ACTOR}`, a.done.payload?.actorID === ACTOR, a.done.payload?.actorID);

  const replay = await recover(grant.recoverySecret);
  check("the grant is single-use", replay.done.ok === false && replay.done.failure?.code === "recovery_grant_consumed", replay.done.failure);

  const home = await callop(a.bearer, "load_home", {});
  check("load_home ok", home.ok === true, home.failure);
  check("home is the prescribed actor", home.payload?.actor?.actorID === ACTOR);
  check("prescribed series present", (home.payload?.series ?? []).map((s: any) => s.id).includes("series-mo-0001"), home.payload?.series);
  check("prescribed sphere present", (home.payload?.spheres ?? []).map((s: any) => s.id).includes("sphere-mo-studio"), home.payload?.spheres);
  check("subscription present", (home.payload?.subscriptions ?? []).map((s: any) => s.seriesID).includes("series-mo-0001"), home.payload?.subscriptions);

  const vouch = await callop(a.bearer, "issue_recovery_grant", {});
  check("device 1 vouches (issue_recovery_grant)", vouch.ok === true && vouch.payload?.issuedBy === "device", vouch.failure);
  const b = await recover(vouch.payload?.recoverySecret);
  check("device 2 recovery ok", b.done.ok === true, b.done.failure);
  check("device 2 shares the actor", b.done.payload?.actorID === a.done.payload?.actorID, { a: a.done.payload?.actorID, b: b.done.payload?.actorID });
  check("device 2 has its own device session", !!b.done.payload?.deviceSessionID && b.done.payload.deviceSessionID !== a.done.payload?.deviceSessionID);
  check("device 2 has its own key", a.keyID !== b.keyID);

  console.log(failures === 0 ? "\nRECOVER PASS" : `\nRECOVER FAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
