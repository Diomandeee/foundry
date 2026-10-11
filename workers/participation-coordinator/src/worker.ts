// Cloudflare Worker entry. Same router as local. Binds D1 (DB) + a server key.
//   VAR  PARTICIPATION_ENV = "production"
//   SECRET COORD_SERVER_PKCS8 / COORD_SERVER_SPKI  (P-256, base64url)
//   SECRET COORD_DEV_BEARER_PREFIX (optional dev fallback)
import { handleRequest, RouterCtx } from "./router.js";
import { D1Store } from "./store.js";
import { loadServerKey, ServerKey } from "./crypto.js";
import { seedInstruments } from "./instruments.js";
import { iso } from "./canonical.js";
import { HttpGraphEmitter } from "./graph.js";

interface Env {
  DB: D1Database;
  COORD_SERVER_PKCS8?: string;
  COORD_SERVER_SPKI?: string;
  COORD_DEV_BEARER_PREFIX?: string;
  PARTICIPATION_ENV?: string;
  /** K11 Graph Kernel. Absent = no participation facts are emitted. */
  LKG_URL?: string;
  LKG_TOKEN?: string;
}

let cached: { ctx: RouterCtx; key: ServerKey } | null = null;
let seeded = false;

async function ctxFor(env: Env): Promise<RouterCtx> {
  const db = new D1Store(env.DB);
  if (!seeded) { await seedInstruments(db); seeded = true; }
  const key = await loadServerKey(env.COORD_SERVER_PKCS8, env.COORD_SERVER_SPKI);
  if (cached && cached.key.keyId === key.keyId) return { ...cached.ctx, db };
  const auth = async (bearer: string | null) => {
    if (!bearer) return null;
    const prefix = env.COORD_DEV_BEARER_PREFIX;
    if (prefix) { const m = new RegExp(`^${prefix}:(.+)$`).exec(bearer); if (m) return { principal: m[1] }; }
    // Production: a Cloudflare Access JWT verified upstream, or a signed token
    // exchanged here. Principal must be the authenticated actor id.
    return null;
  };
  const ctx: RouterCtx = { db, key, auth, now: () => iso(new Date()) };
  if (env.LKG_URL) ctx.graph = new HttpGraphEmitter(env.LKG_URL, env.LKG_TOKEN);
  cached = { ctx, key };
  return ctx;
}

export default {
  async fetch(req: Request, env: Env, exeCtx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health") return Response.json({ ok: true, worker: "participation-coordinator" });
    if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
    const body = await req.text();
    const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
    const ctx = await ctxFor(env);
    // Graph emission runs after the response via waitUntil (never blocks the client).
    const out = await handleRequest(body, bearer, { ...ctx, waitUntil: (p) => exeCtx.waitUntil(p) });
    return Response.json(out);
  },
};
