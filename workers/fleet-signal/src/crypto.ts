// Crypto helpers for fleet-signal. WebCrypto only (works in Workers and Node 22).
//
// Every party signs with ECDSA P-256 / SHA-256:
//  - nodes (each Mac's fleet-authority daemon, CryptoKit P256.Signing key)
//  - devices (the Fabric iPhone app, Secure Enclave key)
// Apple produces DER signatures (`derRepresentation`); WebCrypto verifies the
// raw IEEE P1363 form (r||s, 64 bytes), so DER is converted before verify.

const enc = new TextEncoder();

export function b64ToBytes(b64: string): Uint8Array {
  const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function bytesToB64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function b64url(bytes: Uint8Array): string {
  return bytesToB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', typeof data === 'string' ? enc.encode(data) : data);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Canonical JSON: keys sorted at every level, no whitespace, slashes unescaped.
 * Byte-identical to Swift JSONSerialization(.sortedKeys, .withoutEscapingSlashes)
 * for ASCII strings and integer numbers (the only types used in signed messages). */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const obj = value as Record<string, unknown>;
  return '{' + Object.keys(obj).filter(k => obj[k] !== undefined).sort()
    .map(k => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
}

/** DER ECDSA signature -> raw r||s (32+32). Accepts raw 64-byte input unchanged. */
export function derToRaw(sig: Uint8Array): Uint8Array {
  if (sig.length === 64) return sig;
  if (sig[0] !== 0x30) throw new Error('signature-not-der');
  let i = 2;
  if (sig[1] & 0x80) i = 2 + (sig[1] & 0x7f);
  const out = new Uint8Array(64);
  for (const off of [0, 32]) {
    if (sig[i] !== 0x02) throw new Error('signature-not-der');
    const len = sig[i + 1];
    let int = sig.slice(i + 2, i + 2 + len);
    while (int.length > 32 && int[0] === 0) int = int.slice(1);
    if (int.length > 32) throw new Error('signature-int-too-long');
    out.set(int, off + 32 - int.length);
    i += 2 + len;
  }
  return out;
}

export async function importSpki(spkiB64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('spki', b64ToBytes(spkiB64), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
}

export async function verifyP256(spkiB64: string, signatureB64: string, data: string | Uint8Array): Promise<boolean> {
  try {
    const key = await importSpki(spkiB64);
    const raw = derToRaw(b64ToBytes(signatureB64));
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, raw,
      typeof data === 'string' ? enc.encode(data) : data);
  } catch {
    return false;
  }
}

/** The string a node/device signs to authenticate an HTTP call. */
export async function requestSigningString(method: string, pathWithQuery: string, ts: string, body: string): Promise<string> {
  return `${method.toUpperCase()}\n${pathWithQuery}\n${ts}\n${await sha256Hex(body)}`;
}

/** APNs provider token (ES256 JWT) from a .p8 PKCS#8 PEM. */
export async function apnsJwt(p8Pem: string, keyId: string, teamId: string, nowSec: number): Promise<string> {
  const der = b64ToBytes(p8Pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const head = b64url(enc.encode(JSON.stringify({ alg: 'ES256', kid: keyId })));
  const claims = b64url(enc.encode(JSON.stringify({ iss: teamId, iat: nowSec })));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${head}.${claims}`)));
  return `${head}.${claims}.${b64url(sig)}`;
}
