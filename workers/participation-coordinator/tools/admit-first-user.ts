// Exercise the v2 admission flow end to end over HTTP: an operator grant
// recovers a fresh device into the prescribed actor (the organizer), that
// device mints an INVITATION for the prescribed sphere, and a second, brand-new
// device (no actor) joins with it: begin_admission -> complete_admission creates
// the guest actor, the membership and the admission receipt with the
// invitation's scopes. A random reference without an invitation is refused.
// Each run uses fresh keys and a fresh invitation; it never mutates existing rows.
//
//   OPERATOR_BEARER=... npx tsx tools/admit-first-user.ts https://participation-coordinator.<acct>.workers.dev
import { canonicalJson } from "../src/canonical.js";
import { sha256hex } from "../src/ids.js";
import { issueTokenFor } from "./token-client.js";
import { operatorGrant } from "./operator-grant.js";
import { deviceKey, provePossession, proveAdmission } from "../test/p256.js";

const base = (process.argv[2] ?? "http://localhost:8791").replace(/\/$/, "");
const HINT = process.env.FIRST_USER_HINT ?? "mo-motionmix";
const ACTOR = process.env.FIRST_USER_ACTOR ?? "actor-mo-0001";
const SPHERE = process.env.SPHERE_ID ?? "sphere-mo-studio";
const OPERATOR_BEARER = process.env.OPERATOR_BEARER;

let failures = 0;
const check = (name: string, cond: boolean, detail?: unknown) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${cond || detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`);
  if (!cond) failures++;
};

async function callop(bearer: string, operation: string, payload: unknown): Promise<any> {
  const digest = await sha256hex(new TextEncoder().encode(canonicalJson(payload)));
  const requestId = await sha256hex(`${operation}:${digest}`);
  const res = await fetch(base, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ schema: "motionmix.participation.native_request.v1", operation, request_id: requestId, request_digest_sha256: digest, payload }),
  });
  const body: any = await res.json();
  if (body.ok && (await sha256hex(new TextEncoder().encode(canonicalJson(body.payload)))) !== body.payload_sha256) {
    throw new Error(`payload_sha256 mismatch for ${operation}`);
  }
  return body;
}

async function main() {
  if (!OPERATOR_BEARER) { console.error("OPERATOR_BEARER is required (the server compares its sha256)."); process.exit(2); }

  // 1. the organizer's device: operator grant -> recovery into the prescribed actor
  const org = await deviceKey();
  const orgBearer = await issueTokenFor(base, org);
  check("issuer returned a device-bound token", typeof orgBearer === "string" && orgBearer.startsWith("mmt1."), orgBearer?.slice(0, 8));
  const grant = await operatorGrant(base, OPERATOR_BEARER, ACTOR, 300, "admit-first-user");
  const begin = await callop(orgBearer, "begin_actor_recovery", { accountHint: HINT, deviceKey: org, recoverySecret: grant.recoverySecret });
  check("begin_actor_recovery ok", begin.ok === true, begin.failure);
  const rproof = { challengeID: begin.payload.challengeID, purpose: "account_recovery", keyID: org.keyID, algorithm: "p256-sha256", signatureDERBase64URL: await provePossession(org._pair, begin.payload) };
  const rec = await callop(orgBearer, "complete_actor_recovery", { request: { accountHint: HINT, deviceKey: org, recoverySecret: grant.recoverySecret }, proof: rproof });
  check(`recovered into ${ACTOR}`, rec.ok === true && rec.payload?.actorID === ACTOR, rec.payload ?? rec.failure);

  // 2. the organizer mints an invitation for the prescribed sphere
  const inv = await callop(orgBearer, "create_invitation", { sphereID: SPHERE, role: "participant", maxUses: 1, ttlSeconds: 600, idempotencyKey: `inv-${crypto.randomUUID()}` });
  check("create_invitation ok", inv.ok === true, inv.failure);
  check("invitation link shape", typeof inv.payload?.url === "string" && inv.payload.url.startsWith(`https://join.motionmix.app/s/${SPHERE}?j=`), inv.payload?.url);

  // 3. a guest device with no actor joins with the invitation
  const guest = await deviceKey();
  const guestBearer = await issueTokenFor(base, guest);
  const random = await callop(guestBearer, "begin_admission", { invitation: { sphereID: SPHERE, joinAttemptReference: crypto.randomUUID(), requestedRole: "participant" }, deviceKey: guest });
  check("a random reference is refused", random.ok === false && random.failure?.code === "unknown_invitation", random.failure);
  const adm = await callop(guestBearer, "begin_admission", { invitation: { sphereID: SPHERE, joinAttemptReference: inv.payload.reference, requestedRole: "participant" }, deviceKey: guest });
  check("begin_admission ok", adm.ok === true, adm.failure);
  const aproof = { challengeID: adm.payload.challengeID, purpose: "admission", keyID: guest.keyID, algorithm: "p256-sha256", signatureDERBase64URL: await proveAdmission(guest._pair, adm.payload) };
  const receipt = await callop(guestBearer, "complete_admission", aproof);
  check("complete_admission ok", receipt.ok === true, receipt.failure);
  check("membershipState admitted", receipt.payload?.membershipState === "admitted", receipt.payload?.membershipState);
  check("sphere is the prescribed one", receipt.payload?.sphereID === SPHERE, receipt.payload?.sphereID);
  check("guest got its own actor (not the organizer's)", !!receipt.payload?.actorID && receipt.payload.actorID !== ACTOR, receipt.payload?.actorID);
  check("scopes come from the invitation", JSON.stringify(receipt.payload?.grantedScopes) === JSON.stringify(["admission", "media_publish", "playback", "upload"]), receipt.payload?.grantedScopes);

  // 4. the guest can read its consent instruments; the organizer cannot use the guest's receipt
  const instr = await callop(guestBearer, "load_consent_instruments", receipt.payload);
  check("guest loads consent instruments (12)", instr.ok === true && instr.payload?.length === 12, instr.failure ?? instr.payload?.length);
  const stolen = await callop(orgBearer, "load_consent_instruments", receipt.payload);
  check("organizer cannot replay the guest's receipt", stolen.ok === false && stolen.failure?.code === "membership_not_yours", stolen.failure);

  // 5. the invitation is spent
  const again = await callop((await issueTokenFor(base, await deviceKey())), "begin_admission", { invitation: { sphereID: SPHERE, joinAttemptReference: inv.payload.reference, requestedRole: "participant" }, deviceKey: await deviceKey() });
  check("single-use invitation is exhausted", again.ok === false && ["invitation_exhausted", "key_not_bearer"].includes(again.failure?.code), again.failure);

  console.log(`\nreceipt ${JSON.stringify({ actorID: receipt.payload?.actorID, sphereID: receipt.payload?.sphereID, membershipID: receipt.payload?.membershipID, deviceSessionID: receipt.payload?.deviceSessionID })}`);
  console.log(failures === 0 ? "\nADMIT PASS" : `\nADMIT FAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
