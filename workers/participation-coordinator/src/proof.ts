// Exact reconstruction of the iOS device-proof framing.
//
// The app never signs a bare challenge string. `ParticipationEphemeralDeviceProofProvider`
// (and the identical `ParticipationDeviceKeyStore`) builds a domain-separated,
// length-prefixed message and signs THAT with P-256/SHA-256:
//
//   subjectReferenceSHA256 = sha256("motionmix.participation.possession_subject.v1\0"
//                                   || lp(purpose) || lp(subjectReference))
//   joinAttemptReferenceSHA256 = sha256("motionmix.participation.join_attempt_subject.v1\0"
//                                       || lp(reference))
//   possession message = "motionmix.participation.device_possession_proof.v1\0"
//                        || lp(challengeID) || lp(purpose) || lp(subjectReferenceSHA256)
//                        || lp(deviceSessionID) || lp(deviceKeyID) || lp(challengeSHA256)
//                        || lp(challengeBytes)
//   admission  message = "motionmix.participation.admission_proof.v1\0"
//                        || lp(challengeID) || lp(joinAttemptID) || lp(joinAttemptReferenceSHA256)
//                        || lp(deviceSessionID) || lp(deviceKeyID) || lp(challengeSHA256)
//                        || lp(challengeBytes)
//
// where lp(x) = UInt32 big-endian byte count, then the bytes
// (`appendLengthPrefixed`). A NUL terminator is part of every domain prefix.
//
// Golden vectors for these functions are checked against output produced by the
// app's own Swift code in test/proof-vectors.test.ts.
import { b64urlDecode, sha256hex } from "./ids.js";

const enc = (s: string) => new TextEncoder().encode(s);
const POSSESSION_SUBJECT = "motionmix.participation.possession_subject.v1\u0000";
const JOIN_ATTEMPT_SUBJECT = "motionmix.participation.join_attempt_subject.v1\u0000";
const POSSESSION_PROOF = "motionmix.participation.device_possession_proof.v1\u0000";
const ADMISSION_PROOF = "motionmix.participation.admission_proof.v1\u0000";

/** UInt32 big-endian length prefix, matching Swift's appendLengthPrefixed. */
export function lp(bytes: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length, false);
  out.set(bytes, 4);
  return out;
}

const concat = (parts: Uint8Array<ArrayBuffer>[]): Uint8Array<ArrayBuffer> => {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

const hex = async (bytes: Uint8Array<ArrayBuffer>): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((b) => b.toString(16).padStart(2, "0")).join("");

export const sha256BytesHex = hex;

export async function possessionSubjectSHA256(purpose: string, subjectReference: string): Promise<string> {
  return hex(concat([enc(POSSESSION_SUBJECT), lp(enc(purpose)), lp(enc(subjectReference))]));
}

export async function joinAttemptSubjectSHA256(reference: string): Promise<string> {
  return hex(concat([enc(JOIN_ATTEMPT_SUBJECT), lp(enc(reference))]));
}

export interface ChallengeFields {
  challengeID: string;
  deviceSessionID: string;
  deviceKeyID: string;
  challengeSHA256: string;
}

export function possessionProofMessage(
  fields: ChallengeFields & { purpose: string; subjectReferenceSHA256: string },
  challengeBytes: Uint8Array<ArrayBuffer>,
): Uint8Array<ArrayBuffer> {
  return concat([
    enc(POSSESSION_PROOF),
    ...[fields.challengeID, fields.purpose, fields.subjectReferenceSHA256,
        fields.deviceSessionID, fields.deviceKeyID, fields.challengeSHA256].map((f) => lp(enc(f))),
    lp(challengeBytes),
  ]);
}

export function admissionProofMessage(
  fields: ChallengeFields & { joinAttemptID: string; joinAttemptReferenceSHA256: string },
  challengeBytes: Uint8Array<ArrayBuffer>,
): Uint8Array<ArrayBuffer> {
  return concat([
    enc(ADMISSION_PROOF),
    ...[fields.challengeID, fields.joinAttemptID, fields.joinAttemptReferenceSHA256,
        fields.deviceSessionID, fields.deviceKeyID, fields.challengeSHA256].map((f) => lp(enc(f))),
    lp(challengeBytes),
  ]);
}

/** sha256 (hex) of the *decoded* challenge bytes — what the client signs against. */
export async function challengeBytesSHA256(challengeB64url: string): Promise<string> {
  return hex(b64urlDecode(challengeB64url));
}
