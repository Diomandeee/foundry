// Rotate the coordinator bearer-signing secret (COORD_TOKEN_SECRET).
//
// Why this exists: the local `.dev.vars` held the *production* secret verbatim, so
// any read of that file (or of a transcript that echoed it) is a production-secret
// read. This generates a fresh production secret, installs it on the Worker, stores
// a durable gitignored backup, gives local dev its OWN distinct secret, and PROVES
// the rotation: a freshly minted live token no longer verifies with the old secret
// but does with the new one. It never prints a secret value.
//
//   npx tsx tools/rotate-token-secret.ts https://<coordinator-origin>
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { verifyToken } from "../src/token.js";
import { b64url } from "../src/ids.js";
import { deviceKey } from "../test/p256.js";
import { issueTokenFor } from "./token-client.js";

const base = (process.argv[2] ?? "").replace(/\/$/, "");
const workerDir = join(import.meta.dirname, "..");
const devVars = join(import.meta.dirname, "../.dev.vars");
const backupDir = join(import.meta.dirname, "../../secrets/"); // -> <foundry>/workers/secrets/
const backupFile = join(backupDir, "coord-token-secret.txt");

const oldRaw = existsSync(devVars) ? readFileSync(devVars, "utf8").trim() : "";
const oldSecret = oldRaw.includes("=") ? oldRaw.split("=").slice(1).join("=").trim() : oldRaw;

console.log(`durable backup will be written to ${backupFile}`);
const prodNew = b64url(randomBytes(32));
const devNew = b64url(randomBytes(32));

// 1. write the durable, gitignored backup FIRST so the new value is never orphaned
mkdirSync(backupDir, { recursive: true });
writeFileSync(backupFile, prodNew + "\n");
chmodSync(backupFile, 0o600);

// 2. install on the Worker (value travels on stdin, never argv)
try {
  execFileSync("npx", ["--no-install", "wrangler", "secret", "put", "COORD_TOKEN_SECRET"],
    { cwd: workerDir, input: prodNew + "\n", stdio: ["pipe", "inherit", "inherit"], env: { ...process.env, HOME: "/Users/mohameddiomande" } });
} catch (e) {
  rmSync(backupFile, { force: true });
  console.error("secret put failed; backup removed, nothing changed");
  process.exit(1);
}

// 3. local dev gets its own distinct secret
writeFileSync(devVars, devNew + "\n");
chmodSync(devVars, 0o600);

// 4. prove the rotation. Cloudflare propagates a rotated secret to the edge over
// several seconds, so poll until a freshly minted live token verifies with the new
// secret (and, once it does, confirm the old secret no longer verifies).
const dev = await deviceKey();
let okNew = false, okOld = false;
for (let i = 0; i < 12; i++) {
  const live = await issueTokenFor(base, dev);
  const now = Math.floor(Date.now() / 1000);
  okNew = !!(await verifyToken(prodNew, live, now));
  okOld = oldSecret ? !!(await verifyToken(oldSecret, live, now)) : false;
  if (okNew) break;
  await new Promise((r) => setTimeout(r, 3000));
}
console.log(`new secret verifies a live token: ${okNew}`);
console.log(`old secret still verifies a live token: ${okOld}`);
console.log(okNew && !okOld ? "ROTATE PASS" : "ROTATE FAIL");
process.exit(okNew && !okOld ? 0 : 1);
