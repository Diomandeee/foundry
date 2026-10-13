// Live proof that the prescribed first user is reachable from a device:
// a fresh device key recovers with the app's default account hint and lands in
// the prescribed actor (not a new one), its own device session, and sees the
// prescribed series/sphere/subscription in load_home. Two devices share the actor.
//
//   npx tsx tools/recover-first-user.ts https://participation-coordinator.<acct>.workers.dev
import { canonicalJson } from "../src/canonical.js";
import { sha256hex } from "../src/ids.js";
import { issueTokenFor } from "./token-client.js";
import { deviceKey, provePossession } from "../test/p256.js";

const base = (process.argv[2] ?? "http://localhost:8791").replace(/\/$/, "");
const HINT = process.env.FIRST_USER_HINT ?? "mo-motionmix";

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

async function recover(hint: string) {
  const dev = await deviceKey();
  const bearer = await issueTokenFor(base, dev);
  const begin = await callop(bearer, "begin_actor_recovery", { accountHint: hint, deviceKey: dev });
  if (!begin.ok) throw new Error(`begin_actor_recovery failed: ${JSON.stringify(begin.failure)}`);
  const proof = {
    challengeID: begin.payload.challengeID, purpose: "account_recovery", keyID: dev.keyID,
    algorithm: "p256-sha256", signatureDERBase64URL: await provePossession(dev._pair, begin.payload),
  };
  const done = await callop(bearer, "complete_actor_recovery", {
    request: { accountHint: hint, deviceKey: dev }, proof,
  });
  return { bearer, keyID: dev.keyID, begin, done };
}

async function main() {
  const a = await recover(HINT);
  check("device 1 recovery ok", a.done.ok === true, a.done.failure);
  check("challenge deviceSessionID is real (not 'pending')", a.begin.payload?.deviceSessionID !== "pending", a.begin.payload?.deviceSessionID);
  check("returned deviceSessionID equals the challenge's", a.done.payload?.deviceSessionID === a.begin.payload?.deviceSessionID, { challenge: a.begin.payload?.deviceSessionID, done: a.done.payload?.deviceSessionID });
  check("lands in prescribed actor actor-mo-0001", a.done.payload?.actorID === "actor-mo-0001", a.done.payload?.actorID);

  const home = await callop(a.bearer, "load_home", {});
  check("load_home ok", home.ok === true, home.failure);
  check("home is the prescribed actor", home.payload?.actor?.actorID === "actor-mo-0001");
  check("displayName hint echoed", home.payload?.actor?.displayName === HINT, home.payload?.actor?.displayName);
  check("prescribed series present", (home.payload?.series ?? []).map((s: any) => s.id).includes("series-mo-0001"), home.payload?.series);
  check("prescribed sphere present", (home.payload?.spheres ?? []).map((s: any) => s.id).includes("sphere-mo-studio"), home.payload?.spheres);
  check("subscription present", (home.payload?.subscriptions ?? []).map((s: any) => s.seriesID).includes("series-mo-0001"), home.payload?.subscriptions);

  const b = await recover(HINT);
  check("device 2 recovery ok", b.done.ok === true, b.done.failure);
  check("device 2 shares the actor", b.done.payload?.actorID === a.done.payload?.actorID, { a: a.done.payload?.actorID, b: b.done.payload?.actorID });
  check("device 2 has its own device session", !!b.done.payload?.deviceSessionID && b.done.payload.deviceSessionID !== a.done.payload?.deviceSessionID);
  check("device 2 has its own key", a.keyID !== b.keyID);

  console.log(failures === 0 ? "\nRECOVER PASS" : `\nRECOVER FAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
