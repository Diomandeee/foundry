// Cloudflare Worker entry. Same router as local. Binds D1 (DB) + a server key.
//   VAR    PARTICIPATION_ENV = "production"
//   VAR    COORD_VERSION      — reported by /health (the base SHA once deploys are gated)
//   SECRET COORD_SERVER_PKCS8 / COORD_SERVER_SPKI  (P-256, base64url)
//   SECRET COORD_TOKEN_SECRET  (>=32 random bytes, base64url) — signs bearer tokens
//   SECRET OPERATOR_BEARER_SHA256 — sha256 hex of the operator bearer (recovery grants)
//   SECRET LKG_URL / LKG_TOKEN — K11 graph kernel behind a Cloudflare Tunnel
//
// Authentication: every operation requires a short-lived, device-bound bearer
// token minted at `POST /participation/v1/token` (see src/token.ts). There is no
// dev/prefix fallback in a deployed Worker.
//
// v2 (2026-10-22): the C1 kill switch is gone because recovery now needs a
// single-use grant (src/security.ts). The operator path below is the server
// half of the Fabric-approved grant: the bearer itself never lives in a login
// account; it is used by a daemon template the phone approves.
import { handleRequest, RouterCtx } from "./router.js";
import { D1Store } from "./store.js";
import { loadServerKey, ServerKey } from "./crypto.js";
import { seedInstruments } from "./instruments.js";
import { ensureFirstUser } from "./bootstrap.js";
import { iso } from "./canonical.js";
import { HttpGraphEmitter } from "./graph.js";
import { deviceTokenAuth, issueDeviceToken, TokenError } from "./token.js";
import { audit, digestEquals, gcExpired, issueRecoveryGrant } from "./security.js";
import { OpError } from "./errors.js";
import { sha256hex } from "./ids.js";

interface Env {
  DB: D1Database;
  COORD_SERVER_PKCS8?: string;
  COORD_SERVER_SPKI?: string;
  COORD_TOKEN_SECRET?: string;
  OPERATOR_BEARER_SHA256?: string;
  PARTICIPATION_ENV?: string;
  COORD_VERSION?: string;
  /** K11 Graph Kernel (participation facts), reached via a Cloudflare Tunnel. */
  LKG_URL?: string;
  LKG_TOKEN?: string;
}

export const PROTOCOL_VERSION = 2;

let cachedKey: ServerKey | null = null;
let seeded = false;

async function serverKey(env: Env): Promise<ServerKey> {
  if (cachedKey) return cachedKey;
  cachedKey = await loadServerKey(env.COORD_SERVER_PKCS8, env.COORD_SERVER_SPKI);
  return cachedKey;
}

async function ctxFor(env: Env, db: D1Store): Promise<RouterCtx> {
  if (!seeded) { await seedInstruments(db); await ensureFirstUser(db); seeded = true; }
  const key = await serverKey(env);
  const secret = env.COORD_TOKEN_SECRET;
  const auth = secret
    ? deviceTokenAuth(db, secret)
    : async () => null; // no issuer configured -> fail closed, never open.
  const ctx: RouterCtx = { db, key, auth, now: () => iso(new Date()) };
  if (env.LKG_URL) ctx.graph = new HttpGraphEmitter(env.LKG_URL, env.LKG_TOKEN);
  return ctx;
}

const TOKEN_PATHS = new Set(["/participation/v1/token", "/token"]);
const OPERATOR_GRANT_PATHS = new Set(["/participation/v1/operator/recovery-grant", "/operator/recovery-grant"]);

const json = (body: unknown, status = 200) => Response.json(body, { status });

/**
 * Operator-issued recovery grant. Requires the operator bearer (compared by
 * digest, constant time). This is how the very first device of an actor, or a
 * device with no bound sibling at hand, gets in.
 */
async function operatorRecoveryGrant(req: Request, env: Env, db: D1Store): Promise<Response> {
  if (!env.OPERATOR_BEARER_SHA256) return json({ ok: false, failure: { code: "operator_unconfigured" } }, 503);
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!bearer || !digestEquals(await sha256hex(bearer), env.OPERATOR_BEARER_SHA256.toLowerCase()))
    return json({ ok: false, failure: { code: "unauthorized" } }, 401);
  let body: any;
  try { body = JSON.parse(await req.text()); } catch { return json({ ok: false, failure: { code: "bad_json" } }, 400); }
  if (typeof body?.actorID !== "string" || !body.actorID) return json({ ok: false, failure: { code: "bad_actor" } }, 400);
  const now = iso(new Date());
  try {
    const grant = await issueRecoveryGrant(db, body.actorID, "operator", typeof body.label === "string" ? body.label.slice(0, 64) : "operator", now, body.ttlSeconds);
    await audit(db, now, "operator_recovery_grant", body.actorID, null, { grantID: grant.grantID, label: body.label ?? "operator" });
    return json({ ok: true, ...grant });
  } catch (e) {
    if (e instanceof OpError) return json({ ok: false, failure: { code: e.code, message: e.message } }, 404);
    throw e;
  }
}

export default {
  async fetch(req: Request, env: Env, exeCtx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      return json({
        ok: true, worker: "participation-coordinator", protocol: PROTOCOL_VERSION,
        version: env.COORD_VERSION ?? null, tokenIssuer: !!env.COORD_TOKEN_SECRET, operator: !!env.OPERATOR_BEARER_SHA256,
      });
    }
    if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

    const db = new D1Store(env.DB);

    // --- token issuance (the only device-unauthenticated POST) ----------------
    if (TOKEN_PATHS.has(url.pathname)) {
      if (!env.COORD_TOKEN_SECRET) return json({ ok: false, failure: { code: "issuer_unconfigured" } }, 503);
      let body: any;
      try { body = JSON.parse(await req.text()); } catch { return json({ ok: false, failure: { code: "bad_json" } }, 400); }
      try {
        const issued = await issueDeviceToken(db, body, env.COORD_TOKEN_SECRET, Math.floor(Date.now() / 1000));
        return json({ ok: true, ...issued });
      } catch (e) {
        const code = e instanceof TokenError ? e.code : "token_error";
        return json({ ok: false, failure: { code } }, 401);
      }
    }

    // --- operator path ---------------------------------------------------------
    if (OPERATOR_GRANT_PATHS.has(url.pathname)) return operatorRecoveryGrant(req, env, db);

    // --- authenticated operations -------------------------------------------
    const body = await req.text();
    const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
    const ctx = await ctxFor(env, db);
    const out = await handleRequest(body, bearer, { ...ctx, waitUntil: (p) => exeCtx.waitUntil(p) });
    return json(out);
  },

  /** Hourly: drop expired challenges, nonces and grants (wrangler.toml [triggers]). */
  async scheduled(_event: ScheduledEvent, env: Env, exeCtx: ExecutionContext): Promise<void> {
    const db = new D1Store(env.DB);
    exeCtx.waitUntil(gcExpired(db, iso(new Date())).then((r) => console.log(JSON.stringify({ gc: r }))));
  },
};
