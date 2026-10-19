// Security check: does a given local secret file hold the same value the deployed
// coordinator signs bearers with? Mints a live device-bound bearer and verifies its
// HMAC against the candidate. Prints MATCH/NO MATCH only -- never the secret.
//
//   npx tsx tools/check-token-secret.ts https://<origin> [path-to-secret-file]
import { readFileSync, existsSync } from "node:fs";
import { verifyToken } from "../src/token.js";
import { deviceKey } from "../test/p256.js";
import { issueTokenFor } from "./token-client.js";

const base = (process.argv[2] ?? "http://localhost:8791").replace(/\/$/, "");
const file = process.argv[3] ?? new URL("../.dev.vars", import.meta.url).pathname;
if (!existsSync(file)) { console.log(`no secret file at ${file}`); process.exit(0); }
const raw = readFileSync(file, "utf8").trim();
const candidate = raw.includes("=") ? raw.split("=").slice(1).join("=").trim() : raw;

const dev = await deviceKey();
const token = await issueTokenFor(base, dev);
const claims = await verifyToken(candidate, token, Math.floor(Date.now() / 1000));
console.log(`${file}: ${claims ? "MATCH (this file IS the live COORD_TOKEN_SECRET)" : "NO MATCH (not the live signing secret)"}`);
