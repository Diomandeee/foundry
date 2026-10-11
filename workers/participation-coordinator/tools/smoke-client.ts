// End-to-end smoke over real HTTP: builds the exact request envelope the iOS
// client builds, posts it to the coordinator, and validates the response the
// way ConfiguredParticipationGateway does (payload_sha256 re-encode + request_id
// echo). Exits non-zero on the first contract violation.
//
//   npx tsx tools/smoke-client.ts http://localhost:8791 <actorId?>
import { canonicalJson } from "../src/canonical.js";
import { sha256hex } from "../src/ids.js";

const base = process.argv[2] ?? "http://localhost:8791";
const actor = process.argv[3];
// The iOS transport posts to {baseURL}/participation/v1/native/{operation};
// set SMOKE_PATH_PREFIX to exercise that exact route.
const prefix = process.env.SMOKE_PATH_PREFIX ?? "";

let failures = 0;
const check = (name: string, cond: boolean, detail?: unknown) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${cond || detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`);
  if (!cond) failures++;
};

async function envelope(operation: string, payload: unknown) {
  const payloadData = canonicalJson(payload);
  const digest = await sha256hex(new TextEncoder().encode(payloadData));
  const requestId = await sha256hex(`${operation}:${digest}`);
  return { schema: "motionmix.participation.native_request.v1", operation, request_id: requestId, request_digest_sha256: digest, payload };
}

async function post(operation: string, payload: unknown, bearer?: string) {
  const env = await envelope(operation, payload);
  const res = await fetch(`${base}${prefix}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify(env),
  });
  const body: any = await res.json();
  return { env, body };
}

async function main() {
  const health = await (await fetch(`${base}/health`)).json();
  check("health", health.ok === true, health);

  const bad = await post("load_home", {});
  check("missing bearer -> unauthorized", bad.body.ok === false && bad.body.failure.code === "unauthorized", bad.body.failure);

  const badSchema = await fetch(`${base}${prefix}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ schema: "nope", operation: "load_home", request_id: "x".repeat(8), request_digest_sha256: "0".repeat(64), payload: {} }) });
  const badSchemaBody: any = await badSchema.json();
  check("bad schema -> bad_schema", badSchemaBody.failure?.code === "bad_schema", badSchemaBody.failure);

  const unknown = await post("do_the_thing", {}, "dev:nobody");
  check("unknown op -> unknown_operation", unknown.body.failure?.code === "unknown_operation", unknown.body.failure);

  const home = await post("load_home", {}, actor ? `dev:${actor}` : "dev:nobody");
  check("load_home ok", home.body.ok === true, home.body.failure);
  check("request_id echoed", home.body.request_id === home.env.request_id);
  check("response schema", home.body.schema === "motionmix.participation.native_response.v1");
  check("payload_sha256 matches re-encode", await sha256hex(new TextEncoder().encode(canonicalJson(home.body.payload))) === home.body.payload_sha256);
  if (actor) {
    check("seeded actor resolves", home.body.payload.actor?.actorID === actor, home.body.payload.actor);
    check("availableRoles sorted asc", JSON.stringify(home.body.payload.actor?.availableRoles) === JSON.stringify([...(home.body.payload.actor?.availableRoles ?? [])].sort()), home.body.payload.actor?.availableRoles);
  } else {
    check("unknown actor -> actor null", home.body.payload.actor === null);
  }

  // Durable write + read over the same wire (mutation envelope + canonical digest).
  const key = `smoke-${crypto.randomUUID()}`;
  const created = await post("create_sphere", { draft: { seriesID: null, title: "Smoke Room", summary: "", startsAt: null }, idempotencyKey: key }, actor ? `dev:${actor}` : "dev:smoke-writer");
  check("create_sphere ok", created.body.ok === true, created.body.failure);
  const after = await post("load_home", {}, actor ? `dev:${actor}` : "dev:smoke-writer");
  const ids = (after.body.payload?.spheres ?? []).map((s: any) => s.id);
  check("created sphere visible in load_home", ids.includes(created.body.payload?.id), { want: created.body.payload?.id, ids });

  console.log(failures === 0 ? "\nSMOKE PASS" : `\nSMOKE FAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
