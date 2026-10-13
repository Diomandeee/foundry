// Live device-proof + real-token flow: mints a signed, device-bound bearer from
// the issuer, then proves the P-256 recovery path (DER signatures) against a
// running coordinator, local or deployed.
//   npx tsx tools/smoke-flow.ts https://<origin> [/participation/v1/native]
import { canonicalJson } from "../src/canonical.js";
import { sha256hex } from "../src/ids.js";
import { deviceKey, provePossession } from "../test/p256.js";
import { issueTokenFor } from "./token-client.js";

const base = (process.argv[2] ?? "http://localhost:8791").replace(/\/$/, "");
const prefix = process.argv[3] ?? process.env.SMOKE_PATH_PREFIX ?? "";

let failures = 0;
const check = (name: string, cond: boolean, detail?: unknown) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${cond || detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`);
  if (!cond) failures++;
};

async function call(operation: string, payload: unknown, bearer: string) {
  const digest = await sha256hex(new TextEncoder().encode(canonicalJson(payload)));
  const requestId = await sha256hex(`${operation}:${digest}`);
  const res = await fetch(`${base}${prefix}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ schema: "motionmix.participation.native_request.v1", operation, request_id: requestId, request_digest_sha256: digest, payload }),
  });
  const body: any = await res.json();
  if (body.ok && await sha256hex(new TextEncoder().encode(canonicalJson(body.payload))) !== body.payload_sha256) {
    throw new Error(`payload_sha256 mismatch for ${operation}`);
  }
  return body;
}

async function main() {
  const hint = `smoke-${crypto.randomUUID()}@example.com`;

  // Device 1: its own P-256 key, and a bearer minted from that key.
  const dev: any = await deviceKey();
  const bearer = await issueTokenFor(base, dev);
  check("issuer returned a device-bound token", typeof bearer === "string" && bearer.startsWith("mmt1."), bearer.slice(0, 8));

  const begin = await call("begin_actor_recovery", { accountHint: hint, deviceKey: dev }, bearer);
  check("begin_actor_recovery ok + challenge", begin.ok === true && !!begin.payload?.challengeBase64URL, begin.failure);

  const proof = {
    challengeID: begin.payload.challengeID,
    purpose: "account_recovery",
    keyID: dev.keyID,
    algorithm: "p256-sha256",
    signatureDERBase64URL: await provePossession(dev._pair, begin.payload),
  };
  const done = await call("complete_actor_recovery", { request: { accountHint: hint, deviceKey: dev }, proof }, bearer);
  check("complete_actor_recovery accepts DER P-256 proof", done.ok === true, done.failure);
  check("availableRoles sorted asc", JSON.stringify(done.payload?.availableRoles) === JSON.stringify(["organizer", "participant", "viewer"]), done.payload?.availableRoles);

  const replay = await call("complete_actor_recovery", { request: { accountHint: hint, deviceKey: dev }, proof }, bearer);
  check("replayed proof rejected", replay.ok === false, replay.failure);

  // Device 2: same account hint -> same actor, its own device key + token + session.
  const dev2: any = await deviceKey();
  const bearer2 = await issueTokenFor(base, dev2);
  const b2 = await call("begin_actor_recovery", { accountHint: hint, deviceKey: dev2 }, bearer2);
  const proof2 = { challengeID: b2.payload.challengeID, purpose: "account_recovery", keyID: dev2.keyID, algorithm: "p256-sha256", signatureDERBase64URL: await provePossession(dev2._pair, b2.payload) };
  const d2 = await call("complete_actor_recovery", { request: { accountHint: hint, deviceKey: dev2 }, proof: proof2 }, bearer2);
  check("second device recovers", d2.ok === true, d2.failure);
  check("second device shares the account actor", d2.payload?.actorID === done.payload?.actorID, { a: done.payload?.actorID, b: d2.payload?.actorID });
  check("second device has its own device session", d2.payload?.deviceSessionID !== done.payload?.deviceSessionID);

  // The pre-binding token now resolves to the bound actor (auth reads the device row).
  const home = await call("load_home", {}, bearer);
  check("device 1 token resolves to the recovered actor", home.payload?.actor?.actorID === done.payload?.actorID, home.payload?.actor?.actorID);

  // Optional: prove the participation->graph emission actually landed in K11.
  // The Worker emits via waitUntil, so poll briefly. COORD_GRAPH_URL is the
  // graph kernel base (the tunnel hostname in production).
  const graphURL = process.env.COORD_GRAPH_URL;
  if (graphURL) {
    const subject = `actor:${done.payload?.actorID}`;
    let landed = false;
    for (let i = 0; i < 12 && !landed; i++) {
      const rows: any = await fetch(`${graphURL.replace(/\/$/, "")}/api/knowledge?subject=${encodeURIComponent(subject)}`).then((r) => r.json()).catch(() => []);
      landed = Array.isArray(rows) && rows.some((r) => r.predicate === "recovered_on_account");
      if (!landed) await new Promise((r) => setTimeout(r, 1000));
    }
    check(`graph emission landed in K11 (${subject} recovered_on_account)`, landed);
  }

  console.log(failures === 0 ? "\nFLOW PASS" : `\nFLOW FAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
