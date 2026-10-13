// Short-lived, device-bound bearer tokens for the deployed coordinator.
//
// This replaces the temporary `dev:<actorId>` prefix (COORD_DEV_BEARER_PREFIX),
// which let anyone who knew the Worker URL act as any actor id. A token here is:
//   - *signed* (HMAC-SHA256 over the exact payload bytes with COORD_TOKEN_SECRET),
//     so it cannot be forged without the Worker secret;
//   - *expiring* (short TTL), so a leaked credential goes stale;
//   - *device-bound* (`dk` = the P-256 device key id that requested it), so the
//     bearer is only usable by the device that proved possession of that key.
//
// Issuance is gated by a device possession proof: the caller signs a
// domain-separated, length-prefixed message with its own P-256 key and presents
// the public key; the coordinator verifies the signature against that key and
// checks the key id is the hash of that key. A caller can therefore only obtain
// a token for a device key it holds — it cannot name an arbitrary actor.
//
// The principal is resolved *at use time* from the registered device row
// (devices.actor_id) falling back to a device-derived bootstrap principal, so a
// token minted before `complete_actor_recovery` stays correct after the device
// binds to an actor.
import { Db } from "./store.js";
import { ServerKey, verifyDeviceProof } from "./crypto.js";
import { b64url, b64urlDecode, sha256hex } from "./ids.js";
import { lp } from "./proof.js";

const enc = (s: string) => new TextEncoder().encode(s);
const TOKEN_REQUEST = "motionmix.participation.token_request.v1\u0000";
const TOKEN_PREFIX = "mmt1";
const AUDIENCE = "participation-coordinator";

export const DEFAULT_TOKEN_TTL_SECONDS = 3600;
/** How far a token request's issuedAt may drift from server time. */
const CLOCK_SKEW_SECONDS = 120;

export interface DeviceKeyDescriptor {
  keyID: string;
  algorithm: string;
  publicKeyBase64URL: string;
}

export interface TokenClaims {
  v: 1;
  aud: string;
  /** Principal (actor id, or the device-derived bootstrap principal). */
  sub: string;
  /** Device key id that requested the token. */
  dk: string;
  iat: number;
  exp: number;
}

export interface TokenIssuanceRequest {
  deviceKey: DeviceKeyDescriptor;
  nonce: string;
  issuedAt: string;
  signatureDERBase64URL: string;
}

/** Domain-separated token-request message the client signs (matches the app). */
export function tokenRequestMessage(
  keyID: string,
  publicKeyBase64URL: string,
  nonce: string,
  issuedAt: string,
): Uint8Array<ArrayBuffer> {
  const parts = [enc(keyID), enc(publicKeyBase64URL), enc(nonce), enc(issuedAt)].map(lp);
  const total = parts.reduce((n, p) => n + p.length, enc(TOKEN_REQUEST).length);
  const out = new Uint8Array(total);
  out.set(enc(TOKEN_REQUEST), 0);
  let o = enc(TOKEN_REQUEST).length;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

async function hmacKey(secretB64url: string): Promise<CryptoKey> {
  const raw = b64urlDecode(secretB64url);
  if (raw.length < 32) throw new Error("token_secret_too_short");
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function mintToken(secretB64url: string, claims: TokenClaims): Promise<string> {
  const key = await hmacKey(secretB64url);
  const payload = b64url(enc(JSON.stringify(claims)));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc(payload)));
  return `${TOKEN_PREFIX}.${payload}.${b64url(sig)}`;
}

export async function verifyToken(
  secretB64url: string,
  token: string | null,
  nowSeconds: number,
): Promise<TokenClaims | null> {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return null;
  const [, payload, sig] = parts;
  let key: CryptoKey;
  try { key = await hmacKey(secretB64url); } catch { return null; }
  let valid = false;
  try {
    valid = await crypto.subtle.verify("HMAC", key, b64urlDecode(sig), enc(payload));
  } catch { return null; }
  if (!valid) return null;
  let claims: TokenClaims;
  try { claims = JSON.parse(new TextDecoder().decode(b64urlDecode(payload))); } catch { return null; }
  if (claims?.v !== 1 || claims?.aud !== AUDIENCE) return null;
  if (typeof claims.sub !== "string" || !claims.sub) return null;
  if (typeof claims.dk !== "string" || !claims.dk) return null;
  if (typeof claims.exp !== "number" || claims.exp <= nowSeconds) return null;
  if (typeof claims.iat !== "number" || claims.iat > nowSeconds + CLOCK_SKEW_SECONDS) return null;
  return claims;
}

const boundedASCII = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= 192 && /^[\x21-\x7e]+$/.test(v);

/** `device-<keyID>` bootstrap principal for a device that has not bound an actor. */
export const bootstrapPrincipal = (keyID: string): string => `device-${keyID}`;

export interface IssuedToken {
  accessToken: string;
  tokenType: "Bearer";
  expiresIn: number;
  actorID: string;
}

/**
 * Verify a device token request and mint a short-lived bearer. Throws
 * `TokenError` with a stable code on any failure.
 */
export async function issueDeviceToken(
  db: Db,
  body: TokenIssuanceRequest,
  secretB64url: string,
  nowSeconds: number,
  ttlSeconds = DEFAULT_TOKEN_TTL_SECONDS,
): Promise<IssuedToken> {
  const key = body?.deviceKey;
  if (!key || !boundedASCII(key.keyID) || !boundedASCII(key.publicKeyBase64URL))
    throw new TokenError("bad_device_key", "Missing or malformed device key.");
  if (key.algorithm !== "p256-sha256")
    throw new TokenError("unsupported_algorithm", "Only p256-sha256 device keys are accepted.");
  if (!boundedASCII(body.nonce) || body.nonce.length < 22)
    throw new TokenError("bad_nonce", "Missing or malformed nonce.");
  if (typeof body.issuedAt !== "string" || !Number.isFinite(Date.parse(body.issuedAt)))
    throw new TokenError("bad_issued_at", "Missing or malformed issuedAt.");

  // The key id must be the sha256 of the public key it claims, so a caller can't
  // present someone else's key id with its own key.
  let pubBytes: Uint8Array<ArrayBuffer>;
  try { pubBytes = b64urlDecode(key.publicKeyBase64URL); } catch { throw new TokenError("bad_device_key", "Device key is not base64url."); }
  if (pubBytes.length !== 65 || pubBytes[0] !== 0x04)
    throw new TokenError("bad_device_key", "Device key is not an uncompressed P-256 point.");
  if ((await sha256hex(pubBytes)) !== key.keyID)
    throw new TokenError("key_id_mismatch", "Device key id is not the hash of the presented key.");

  const skew = Math.abs(nowSeconds - Math.floor(Date.parse(body.issuedAt) / 1000));
  if (skew > CLOCK_SKEW_SECONDS)
    throw new TokenError("stale_request", "Token request is outside the accepted clock window.");

  const message = tokenRequestMessage(key.keyID, key.publicKeyBase64URL, body.nonce, body.issuedAt);
  if (!(await verifyDeviceProof(key.publicKeyBase64URL, message, body.signatureDERBase64URL)))
    throw new TokenError("proof_invalid", "Device possession proof failed.");

  // Nonce replay guard: a token request is single-use.
  const prior: any = await db.get(`SELECT nonce FROM token_nonces WHERE nonce=?`, [body.nonce]);
  if (prior) throw new TokenError("nonce_reused", "Token request nonce already used.");
  await db.run(
    `INSERT INTO token_nonces (nonce,key_id,issued_at) VALUES (?,?,?)`,
    [body.nonce, key.keyID, new Date(nowSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z")],
  );

  const dev: any = await db.get(`SELECT actor_id FROM devices WHERE key_id=?`, [key.keyID]);
  const actorID: string = dev?.actor_id ?? bootstrapPrincipal(key.keyID);
  const claims: TokenClaims = {
    v: 1, aud: AUDIENCE, sub: actorID, dk: key.keyID,
    iat: nowSeconds, exp: nowSeconds + ttlSeconds,
  };
  return { accessToken: await mintToken(secretB64url, claims), tokenType: "Bearer", expiresIn: ttlSeconds, actorID };
}

export class TokenError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

/**
 * Build the coordinator `auth` function from a token secret. Verifies the
 * bearer, then resolves the live principal from the registered device row so a
 * pre-recovery token keeps working after the device binds to an actor.
 */
export function deviceTokenAuth(
  db: Db,
  secretB64url: string,
  nowSeconds: () => number = () => Math.floor(Date.now() / 1000),
): (bearer: string | null) => Promise<{ principal: string } | null> {
  return async (bearer) => {
    const claims = await verifyToken(secretB64url, bearer, nowSeconds());
    if (!claims) return null;
    const dev: any = await db.get(`SELECT actor_id FROM devices WHERE key_id=?`, [claims.dk]);
    return { principal: dev?.actor_id ?? claims.sub };
  };
}
