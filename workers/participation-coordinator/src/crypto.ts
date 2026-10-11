// Device-proof verification + server-signed handoff references.
//
// The device holds a P-256 key (ParticipationDeviceKeyStore). It signs the
// challenge with ECDSA-P256/SHA256 and returns a DER signature base64url. The
// server verifies against the registered public key (x9.63 = uncompressed
// 0x04||X||Y). Server never accepts a client "proof_verified" flag.
import { b64urlDecode, b64url, sha256hex } from "./ids.js";

const ALGO = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN = { name: "ECDSA", hash: "SHA-256" } as const;

// WebCrypto (browser and Node's crypto.subtle) verifies ECDSA over the raw
// IEEE-P1363 form r||s (64 bytes for P-256). The iOS client transmits the
// signature as a DER SEQUENCE{INTEGER r, INTEGER s}. Convert DER -> P1363 here so
// the server checks the format the device actually sends. A raw 64-byte
// signature passes through unchanged (native WebCrypto clients).
export function derToP1363(der: Uint8Array<ArrayBuffer>, size = 32): Uint8Array<ArrayBuffer> {
  if (der.length === size * 2) return der;
  if (der[0] !== 0x30) return der;
  let p = 1;
  let len = der[p++];
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = (len << 8) | der[p++];
  }
  const out = new Uint8Array(size * 2);
  for (let half = 0; half < 2; half++) {
    if (der[p] !== 0x02) throw new Error("der_integer_expected");
    p++;
    const ilen = der[p++];
    let v = der.subarray(p, p + ilen);
    p += ilen;
    while (v.length > 0 && v[0] === 0x00) v = v.subarray(1);
    if (v.length > size) throw new Error("der_integer_too_long");
    out.set(v, half * size + (size - v.length));
  }
  return out;
}

export async function verifyDeviceProof(
  publicKeyB64url: string,
  message: Uint8Array<ArrayBuffer>,
  signatureDerB64url: string,
): Promise<boolean> {
  try {
    const raw = b64urlDecode(publicKeyB64url);
    const key = await crypto.subtle.importKey("raw", raw, ALGO, false, ["verify"]);
    const sig = derToP1363(b64urlDecode(signatureDerB64url));
    return await crypto.subtle.verify(SIGN, key, sig, message);
  } catch {
    return false;
  }
}

export interface ServerKey {
  keyId: string;
  publicKeyB64url: string;
  sign: (msg: string) => Promise<string>;
}

// Production passes a PKCS8 private key (base64url) as a Worker secret; the
// matching public key is provided alongside as SPKI (base64url). Local/dev
// generates a fresh pair.
export async function loadServerKey(
  pkcs8B64url?: string,
  spkiB64url?: string,
): Promise<ServerKey> {
  let priv: CryptoKey;
  let pub: CryptoKey;
  if (pkcs8B64url && spkiB64url) {
    priv = await crypto.subtle.importKey("pkcs8", b64urlDecode(pkcs8B64url), ALGO, true, ["sign"]);
    pub = await crypto.subtle.importKey("spki", b64urlDecode(spkiB64url), ALGO, true, ["verify"]);
  } else {
    const pair = await crypto.subtle.generateKey(ALGO, true, ["sign", "verify"]);
    priv = pair.privateKey;
    pub = pair.publicKey;
  }
  const rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", pub));
  return {
    keyId: (await sha256hex(rawPub)).slice(0, 32),
    publicKeyB64url: b64url(rawPub),
    async sign(msg: string) {
      const sig = await crypto.subtle.sign(SIGN, priv, new TextEncoder().encode(msg));
      return b64url(new Uint8Array(sig));
    },
  };
}
