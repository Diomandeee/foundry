// Cloudflare Worker entry. Same router as local. Binds D1 (DB) + a server key.
//   VAR    PARTICIPATION_ENV = "production"
//   SECRET COORD_SERVER_PKCS8 / COORD_SERVER_SPKI  (P-256, base64url)
//   SECRET COORD_TOKEN_SECRET  (>=32 random bytes, base64url) — signs bearer tokens
//
// Authentication: every operation requires a short-lived, device-bound bearer
// token minted at `POST /participation/v1/token` (see src/token.ts). There is no
// dev/prefix fallback in a deployed Worker.
import { handleRequest, RouterCtx } from "./router.js";
import { D1Store } from "./store.js";
import { loadServerKey, ServerKey } from "./crypto.js";
import { seedInstruments } from "./instruments.js";
import { ensureFirstUser } from "./bootstrap.js";
import { iso } from "./canonical.js";
import { HttpGraphEmitter } from "./graph.js";
import { deviceTokenAuth, issueDeviceToken, TokenError } from "./token.js";

interface Env {
  DB: D1Database;
  COORD_SERVER_PKCS8?: string;
  COORD_SERVER_SPKI?: string;
  COORD_TOKEN_SECRET?: string;
  PARTICIPATION_ENV?: string;
  /** K11 Graph Kernel (participation facts), reached via a Cloudflare Tunnel. */
  LKG_URL?: string;
  LKG_TOKEN?: string;
}

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

export default {
  async fetch(req: Request, env: Env, exeCtx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true, worker: "participation-coordinator", tokenIssuer: !!env.COORD_TOKEN_SECRET });
    }
    if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

    const db = new D1Store(env.DB);

    // --- token issuance (the only unauthenticated POST) ---------------------
    if (TOKEN_PATHS.has(url.pathname)) {
      if (!env.COORD_TOKEN_SECRET) return Response.json({ ok: false, failure: { code: "issuer_unconfigured" } }, { status: 503 });
      let body: any;
      try { body = JSON.parse(await req.text()); } catch { return Response.json({ ok: false, failure: { code: "bad_json" } }, { status: 400 }); }
      try {
        const issued = await issueDeviceToken(db, body, env.COORD_TOKEN_SECRET, Math.floor(Date.now() / 1000));
        return Response.json({ ok: true, ...issued });
      } catch (e) {
        const code = e instanceof TokenError ? e.code : "token_error";
        return Response.json({ ok: false, failure: { code } }, { status: 401 });
      }
    }

    // --- authenticated operations -------------------------------------------
    const body = await req.text();
    // Security review 2026-10-22 C1 (TEMPORARY kill switch): actor recovery binds a caller's self-made device
    // key to an account by display name, so anyone on the internet could become an existing actor. Recovery
    // stays off until it requires an operator-issued single-use secret or a signature from an already-bound
    // device. Remove this block only together with that fix. Re-enable for a test: RECOVERY_ENABLED="1".
    if ((env as any).RECOVERY_ENABLED !== "1") {
      let op = "";
      try { op = JSON.parse(body)?.operation ?? ""; } catch { /* the router reports bad JSON */ }
      if (op === "begin_actor_recovery" || op === "complete_actor_recovery") {
        return Response.json({ ok: false, failure: { code: "recovery_disabled", message: "Actor recovery is disabled pending a security fix." } }, { status: 403 });
      }
    }
    const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
    const ctx = await ctxFor(env, db);
    const out = await handleRequest(body, bearer, { ...ctx, waitUntil: (p) => exeCtx.waitUntil(p) });
    return Response.json(out);
  },
};
