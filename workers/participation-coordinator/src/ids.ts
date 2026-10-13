// Identifier + digest helpers. All ids are opaque, high-entropy, url-safe.
export const sha256hex = async (data: Uint8Array<ArrayBufferLike> | string): Promise<string> => {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

export const uuid = (): string => crypto.randomUUID();

export const b64url = (bytes: Uint8Array<ArrayBufferLike>): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export const b64urlDecode = (s: string): Uint8Array<ArrayBuffer> => {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const raw = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

export const nowIso = (d = new Date()): string => d.toISOString().replace(/\.\d{3}Z$/, "Z");
