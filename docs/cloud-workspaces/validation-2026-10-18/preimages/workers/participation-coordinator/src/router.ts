// Native participation router: envelope validation, canonical response, and the
// payload_sha256 the iOS client checks by re-encoding with .sortedKeys+iso8601.
import { Db } from "./store.js";
import { ServerKey } from "./crypto.js";
import { sha256hex } from "./ids.js";
import { canonicalJson, iso } from "./canonical.js";
import { dispatch, OpError, Req } from "./ops.js";
import { GraphEmitter, graphTriples } from "./graph.js";

const REQUEST_SCHEMA = "motionmix.participation.native_request.v1";
const RESPONSE_SCHEMA = "motionmix.participation.native_response.v1";

// Normalize every RFC3339-ish string to the client's .iso8601 form (no millis).
function normalizeDates(v: any): any {
  if (typeof v === "string") {
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(v) ? iso(v) : v;
  }
  if (Array.isArray(v)) return v.map(normalizeDates);
  if (v && typeof v === "object") {
    const o: any = {};
    for (const k of Object.keys(v)) o[k] = normalizeDates(v[k]);
    return o;
  }
  return v;
}

export interface RouterCtx {
  db: Db;
  key: ServerKey;
  /** Resolve the bearer to an authenticated principal (actor id) + device session. */
  auth: (bearer: string | null) => Promise<{ principal: string; deviceSessionId?: string } | null>;
  /** Optional Knowledge Graph sink. Absent = fully offline (CI default). */
  graph?: GraphEmitter;
  /** Optional deferral hook (Workers: ctx.waitUntil) so emission never blocks. */
  waitUntil?: (p: Promise<unknown>) => void;
  now?: () => string;
}

const fail = (req: any, id: string, digest: string, code: string, message: string) => ({
  schema: RESPONSE_SCHEMA, operation: req?.operation ?? "", request_id: id,
  request_digest_sha256: digest, ok: false, payload: null, payload_sha256: null,
  failure: { code, message },
});

export async function handleRequest(raw: string, bearer: string | null, ctx: RouterCtx): Promise<object> {
  let req: any;
  try { req = JSON.parse(raw); } catch { return fail({}, "", "", "bad_json", "Request body is not JSON."); }
  const id = req?.request_id ?? "";
  const digest = req?.request_digest_sha256 ?? "";
  if (req?.schema !== REQUEST_SCHEMA) return fail(req, id, digest, "bad_schema", "Unknown request schema.");
  if (typeof req?.operation !== "string") return fail(req, id, digest, "bad_operation", "Missing operation.");
  if (typeof id !== "string" || id.length < 8) return fail(req, id, digest, "bad_request_id", "Missing request id.");
  if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) return fail(req, id, digest, "bad_digest", "Missing request digest.");

  const who = await ctx.auth(bearer);
  if (!who) return fail(req, id, digest, "unauthorized", "Missing or invalid bearer.");
  if (req.payload === undefined) return fail(req, id, digest, "bad_payload", "Missing payload.");

  const now = (ctx.now ?? (() => iso(new Date())))();
  const r: Req = { operation: req.operation, payload: req.payload, principal: who.principal, deviceSessionId: who.deviceSessionId, now };
  try {
    const payload = normalizeDates(await dispatch(ctx.db, r, ctx.key));
    const payloadData = canonicalJson(payload);
    const payloadSha = await sha256hex(new TextEncoder().encode(payloadData));
    // Best-effort graph emission; a graph outage never fails the operation.
    if (ctx.graph) {
      const effect = ctx.graph.emit(graphTriples(req.operation, payload)).catch(() => {});
      if (ctx.waitUntil) ctx.waitUntil(effect); else await effect;
    }
    return {
      schema: RESPONSE_SCHEMA, operation: req.operation, request_id: id,
      request_digest_sha256: digest, ok: true, payload, payload_sha256: payloadSha, failure: null,
    };
  } catch (e) {
    if (e instanceof OpError) return fail(req, id, digest, e.code, e.message);
    return fail(req, id, digest, "internal", e instanceof Error ? e.message : "Coordinator error.");
  }
}
