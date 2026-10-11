// Canonical JSON matching the Swift client's encoder: JSONEncoder with
// .sortedKeys + .iso8601 dates. Round-trips: the client re-encodes the decoded
// payload with the same config and checks sha256 == payload_sha256.
//
// `.iso8601` in Foundation emits whole seconds: "2026-10-11T17:30:00Z". Date
// values are therefore stored/returned as ISO strings with no fractional part.

export const iso = (d: Date | string): string => {
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
};

/** Deterministic canonical JSON: object keys sorted, no whitespace. */
export const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value === "number" || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
  }
  throw new Error("canonical_json_unsupported");
};
