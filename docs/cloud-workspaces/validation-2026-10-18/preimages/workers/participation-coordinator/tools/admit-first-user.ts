// Exercise the participation admission flow for the prescribed first user:
// recover a fresh device into the prescribed actor (default hint "mo-motionmix"),
// then begin_admission -> complete_admission into the prescribed sphere, creating
// the first membership + admission receipt. Each run uses a fresh device key and a
// fresh join-attempt reference, so it is safe to re-run and never mutates existing rows.
//
//   npx tsx tools/admit-first-user.ts https://participation-coordinator.<acct>.workers.dev
import { canonicalJson } from "../src/canonical.js";
import { sha256hex } from "../src/ids.js";
import { issueTokenFor } from "./token-client.js";
import { deviceKey, provePossession, proveAdmission } from "../test/p256.js";

const base = (process.argv[2] ?? "http://localhost:8791").replace(/\/$/, "");
const HINT = process.env.FIRST_USER_HINT ?? "mo-motionmix";
const SPHERE = process.env.SPHERE_ID ?? "sphere-mo-studio";
const REF = process.env.JOIN_REF ?? `first-admission-${Date.now()}`;

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
  const dev = await deviceKey();
  const bearer = await issueTokenFor(base, dev);
  check("issuer returned a device-bound token", typeof bearer === "string" && bearer.startsWith("mmt1."), bearer?.slice(0, 8));

  // 1. recover -> binds this device to the prescribed actor
  const begin = await callop(bearer, "begin_actor_recovery", { accountHint: HINT, deviceKey: dev });
  check("begin_actor_recovery ok", begin.ok === true, begin.failure);
  const rproof = { challengeID: begin.payload.challengeID, purpose: "account_recovery", keyID: dev.keyID, algorithm: "p256-sha256", signatureDERBase64URL: await provePossession(dev._pair, begin.payload) };
  const rec = await callop(bearer, "complete_actor_recovery", { request: { accountHint: HINT, deviceKey: dev }, proof: rproof });
  check("recovered into actor-mo-0001", rec.ok === true && rec.payload?.actorID === "actor-mo-0001", rec.payload ?? rec.failure);

  // 2. begin_admission into the prescribed sphere
  const adm = await callop(bearer, "begin_admission", { invitation: { sphereID: SPHERE, joinAttemptReference: REF, requestedRole: "participant" }, deviceKey: dev });
  check("begin_admission ok", adm.ok === true, adm.failure);

  // 3. complete_admission -> membership + admission receipt
  const aproof = { challengeID: adm.payload.challengeID, purpose: "admission", keyID: dev.keyID, algorithm: "p256-sha256", signatureDERBase64URL: await proveAdmission(dev._pair, adm.payload) };
  const receipt = await callop(bearer, "complete_admission", aproof);
  check("complete_admission ok", receipt.ok === true, receipt.failure);
  check("membershipState admitted", receipt.payload?.membershipState === "admitted", receipt.payload?.membershipState);
  check("sphere is the prescribed one", receipt.payload?.sphereID === SPHERE, receipt.payload?.sphereID);
  check("scopes exact", JSON.stringify(receipt.payload?.grantedScopes) === JSON.stringify(["admission", "media_publish", "playback", "upload"]), receipt.payload?.grantedScopes);

  // 4. load_home lists the sphere for this actor
  const home = await callop(bearer, "load_home", {});
  const sphereRow = (home.payload?.spheres ?? []).find((s: any) => s.id === SPHERE);
  check("load_home is the prescribed actor + lists the sphere", home.ok === true && home.payload?.actor?.actorID === "actor-mo-0001" && !!sphereRow, {
    actor: home.payload?.actor?.actorID, spheres: (home.payload?.spheres ?? []).map((s: any) => s.id),
  });

  console.log(`\nreceipt ${JSON.stringify({ actorID: receipt.payload?.actorID, sphereID: receipt.payload?.sphereID, membershipID: receipt.payload?.membershipID, receiptID: receipt.payload?.receiptID, deviceSessionID: receipt.payload?.deviceSessionID })}`);
  console.log(failures === 0 ? "\nADMIT PASS" : `\nADMIT FAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
