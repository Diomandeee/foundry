// Issues a real, device-bound bearer from a running coordinator, exactly the way
// the app does: sign a domain-separated token-request message with the device's
// P-256 key, POST it to /participation/v1/token, receive a signed short-lived
// token. No shared secret is involved on the client side.
import { b64url } from "../src/ids.js";
import { tokenRequestMessage } from "../src/token.js";
import { deviceKey, signBytes } from "../test/p256.js";

export async function issueTokenFor(base: string, dev: any): Promise<string> {
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(24)));
  const issuedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const signatureDERBase64URL = await signBytes(
    dev._pair,
    tokenRequestMessage(dev.keyID, dev.publicKeyBase64URL, nonce, issuedAt),
  );
  const res = await fetch(`${base.replace(/\/$/, "")}/participation/v1/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      deviceKey: { keyID: dev.keyID, algorithm: dev.algorithm, publicKeyBase64URL: dev.publicKeyBase64URL },
      nonce, issuedAt, signatureDERBase64URL,
    }),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!body?.ok || typeof body.accessToken !== "string") {
    throw new Error(`token issuance failed: ${JSON.stringify(body)}`);
  }
  return body.accessToken;
}

export async function issueToken(base: string): Promise<{ token: string; device: any }> {
  const device = await deviceKey();
  return { token: await issueTokenFor(base, device), device };
}
