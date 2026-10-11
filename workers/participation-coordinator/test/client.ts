// Test client mirroring ConfiguredParticipationGateway: builds the request
// envelope, computes the digest, and verifies the response payload_sha256 by
// re-encoding with canonical (sorted-keys) JSON — exactly what the iOS client does.
import { sha256hex } from "../src/ids.js";
import { canonicalJson } from "../src/canonical.js";

export async function call(run: (body: string, bearer: string|null) => Promise<any>, bearer: string, operation: string, payload: any) {
  const payloadData = canonicalJson(payload);
  const digest = await sha256hex(new TextEncoder().encode(payloadData));
  const requestId = await sha256hex(`${operation}:${digest}`);
  const envelope = { schema: "motionmix.participation.native_request.v1", operation, request_id: requestId, request_digest_sha256: digest, payload };
  const res = await run(JSON.stringify(envelope), bearer);
  if (!res.ok) return res;
  const reenc = await sha256hex(new TextEncoder().encode(canonicalJson(res.payload)));
  if (reenc !== res.payload_sha256) throw new Error(`payload_sha256 mismatch for ${operation}`);
  if (res.request_id !== requestId) throw new Error("request_id echo mismatch");
  return res;
}
