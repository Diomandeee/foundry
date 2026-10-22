// Stable failure codes for the native wire. The router turns an OpError into
// `{ ok: false, failure: { code, message } }`; anything else is `internal`.
export class OpError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}
