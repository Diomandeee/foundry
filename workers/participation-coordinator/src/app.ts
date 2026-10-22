// Shared bootstrap: build a coordinator from any Db + ServerKey + auth function.
import { Db } from "./store.js";
import { ServerKey, loadServerKey } from "./crypto.js";
import { handleRequest, RouterCtx } from "./router.js";
import { seedInstruments } from "./instruments.js";
import { iso } from "./canonical.js";
import { GraphEmitter } from "./graph.js";

export interface BuildOpts {
  auth?: (bearer: string | null) => Promise<{ principal: string; deviceKeyId?: string; deviceSessionId?: string } | null>;
  key?: ServerKey;
  now?: () => string;
  graph?: GraphEmitter;
  waitUntil?: (p: Promise<unknown>) => void;
}

// Dev auth: bearer "dev:<actorId>" authenticates that actor. Replace with the
// real token issuer before any non-loopback deploy.
export const devAuth = async (bearer: string | null) => {
  if (!bearer) return null;
  const m = /^dev:(.+)$/.exec(bearer);
  return m ? { principal: m[1] } : null;
};

export async function buildCoordinator(db: Db, opts: BuildOpts = {}): Promise<RouterCtx> {
  const key = opts.key ?? (await loadServerKey());
  await seedInstruments(db);
  return { db, key, auth: opts.auth ?? devAuth, now: opts.now ?? (() => iso(new Date())), graph: opts.graph, waitUntil: opts.waitUntil };
}

export async function run(db: Db, rawBody: string, bearer: string | null, ctx: RouterCtx) {
  return handleRequest(rawBody, bearer, ctx);
}
