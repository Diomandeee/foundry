// Local coordinator: node:sqlite + node:http. Runs the exact same router the
// Cloudflare Worker runs, so local behavior == production behavior.
//   node --experimental-sqlite src/dev-server.ts
//   curl -s localhost:8791/health
import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SqliteStore } from "./store.js";
import { buildCoordinator, run } from "./app.js";
import { HttpGraphEmitter } from "./graph.js";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8791);

async function main() {
  const db = await SqliteStore.open(process.env.COORD_DB ?? join(here, "..", ".dev.sqlite"));
  await db.exec(readFileSync(join(here, "..", "schema.sql"), "utf8"));
  const ctx = await buildCoordinator(db, process.env.LKG_URL
    ? { graph: new HttpGraphEmitter(process.env.LKG_URL, process.env.LKG_TOKEN) }
    : {});

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
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, worker: "participation-coordinator", mode: "local" }));
        return;
      }
      if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = Buffer.concat(chunks).toString("utf8");
      const bearer = (req.headers["authorization"] as string | undefined)?.replace(/^Bearer\s+/i, "") ?? null;
      const out = await run(db, body, bearer, ctx);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(out));
    })
    .listen(PORT, () => console.log(`participation-coordinator local on :${PORT}`));
}
main().catch((e) => { console.error(e); process.exit(1); });
