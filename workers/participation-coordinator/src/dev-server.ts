// Local coordinator: node:sqlite + node:http. Runs the exact same router the
// Cloudflare Worker runs, so local behavior == production behavior.
//   node --experimental-sqlite src/dev-server.ts
//   curl -s localhost:8791/health
//
// Auth mirrors the Worker: set COORD_TOKEN_SECRET to require real signed,
// device-bound bearers at POST /participation/v1/token. With no secret the local
// server falls back to the `dev:<actorId>` bearer so the smoke tooling works
// offline. A deployed Worker has no such fallback.
import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SqliteStore } from "./store.js";
import { buildCoordinator, run } from "./app.js";
import { HttpGraphEmitter } from "./graph.js";
import { deviceTokenAuth, issueDeviceToken, TokenError } from "./token.js";
import { ensureFirstUser } from "./bootstrap.js";
import { audit, digestEquals, issueRecoveryGrant } from "./security.js";
import { sha256hex } from "./ids.js";
import { OpError } from "./errors.js";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8791);
const TOKEN_SECRET = process.env.COORD_TOKEN_SECRET;
const TOKEN_PATHS = new Set(["/participation/v1/token", "/token"]);
// Operator recovery grants, exactly as the Worker serves them. Set
// OPERATOR_BEARER_SHA256 (sha256 hex of the bearer) to enable locally.
const OPERATOR_SHA = process.env.OPERATOR_BEARER_SHA256?.toLowerCase();
const OPERATOR_GRANT_PATHS = new Set(["/participation/v1/operator/recovery-grant", "/operator/recovery-grant"]);

async function main() {
  const db = await SqliteStore.open(process.env.COORD_DB ?? join(here, "..", ".dev.sqlite"));
  await db.exec(readFileSync(join(here, "..", "schema.sql"), "utf8"));
  // Prescribe the first user on a fresh local database, exactly like the Worker.
  await ensureFirstUser(db);
  const ctx = await buildCoordinator(db, {
    ...(TOKEN_SECRET ? { auth: deviceTokenAuth(db, TOKEN_SECRET) } : {}),
    ...(process.env.LKG_URL ? { graph: new HttpGraphEmitter(process.env.LKG_URL, process.env.LKG_TOKEN) } : {}),
  });

  // Local-only convenience: seed one actor so the smoke script can prove the
  // authenticated path over real HTTP. Never set in a deployed environment.
  const seedActor = process.env.COORD_SEED_ACTOR;
  if (seedActor) {
    const roles = (process.env.COORD_SEED_ROLES ?? "organizer,participant,viewer").split(",");
    const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    await db.run(
      `INSERT INTO actors (actor_id,account_id,display_name,roles_json,created_at) VALUES (?,?,?,?,?)
       ON CONFLICT(actor_id) DO NOTHING`,
      [seedActor, `acct-${seedActor}`, seedActor, JSON.stringify(roles), ts],
    );
  }

  http
    .createServer(async (req, res) => {
      const path = (req.url ?? "").split("?")[0];
      if (req.method === "GET" && path === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, worker: "participation-coordinator", mode: "local", protocol: 2, tokenIssuer: !!TOKEN_SECRET, operator: !!OPERATOR_SHA }));
        return;
      }
      if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = Buffer.concat(chunks).toString("utf8");

      if (TOKEN_PATHS.has(path)) {
        if (!TOKEN_SECRET) { res.writeHead(503, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, failure: { code: "issuer_unconfigured" } })); return; }
        try {
          const issued = await issueDeviceToken(db, JSON.parse(body), TOKEN_SECRET, Math.floor(Date.now() / 1000));
          res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, ...issued }));
        } catch (e) {
          const code = e instanceof TokenError ? e.code : "token_error";
          res.writeHead(401, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, failure: { code } }));
        }
        return;
      }

      const bearer = (req.headers["authorization"] as string | undefined)?.replace(/^Bearer\s+/i, "") ?? null;

      if (OPERATOR_GRANT_PATHS.has(path)) {
        const reply = (status: number, payload: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(payload)); };
        if (!OPERATOR_SHA) return reply(503, { ok: false, failure: { code: "operator_unconfigured" } });
        if (!bearer || !digestEquals(await sha256hex(bearer), OPERATOR_SHA)) return reply(401, { ok: false, failure: { code: "unauthorized" } });
        let parsed: any; try { parsed = JSON.parse(body); } catch { return reply(400, { ok: false, failure: { code: "bad_json" } }); }
        if (typeof parsed?.actorID !== "string") return reply(400, { ok: false, failure: { code: "bad_actor" } });
        const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
        try {
          const grant = await issueRecoveryGrant(db, parsed.actorID, "operator", typeof parsed.label === "string" ? parsed.label.slice(0, 64) : "operator", now, parsed.ttlSeconds);
          await audit(db, now, "operator_recovery_grant", parsed.actorID, null, { grantID: grant.grantID });
          return reply(200, { ok: true, ...grant });
        } catch (e) {
          if (e instanceof OpError) return reply(404, { ok: false, failure: { code: e.code, message: e.message } });
          throw e;
        }
      }

      const out = await run(db, body, bearer, ctx);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(out));
    })
    .listen(PORT, () => console.log(`participation-coordinator local on :${PORT}`));
}
main().catch((e) => { console.error(e); process.exit(1); });
