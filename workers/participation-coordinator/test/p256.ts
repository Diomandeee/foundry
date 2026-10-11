// P-256 helpers for tests: generate a device key, sign a challenge, and convert
// the WebCrypto IEEE-P1363 signature to the DER form the iOS client sends.
import { b64url } from "../src/ids.js";

export async function deviceKey() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const sha = await crypto.subtle.digest("SHA-256", raw);
  const keyID = [...new Uint8Array(sha)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return {
    keyID, publicKeyBase64URL: b64url(raw), algorithm: "p256-sha256", _pair: pair,
  };
}

export async function sign(pair: CryptoKeyPair, msg: string): Promise<string> {
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(msg)));
  return b64url(der(sig));
}

// IEEE P1363 (r||s, 64 bytes) -> DER SEQUENCE{INTEGER r, INTEGER s}
function der(sig: Uint8Array): Uint8Array {
  const r = trim(sig.slice(0, 32)), s = trim(sig.slice(32));
  const body = [...int(r), ...int(s)];
  return Uint8Array.from([0x30, body.length, ...body]);
}
function trim(b: Uint8Array): Uint8Array { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; return b.slice(i); }
function int(b: Uint8Array): number[] { return b[0] & 0x80 ? [0x02, b.length + 1, 0x00, ...b] : [0x02, b.length, ...b]; }
