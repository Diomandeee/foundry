// Cross-language golden vectors. The expected values were produced by running the
// app's own Swift code (tools/proof-vectors.swift, copied verbatim from
// ParticipationDeviceProofProviding.swift) with `xcrun swift`. If the coordinator
// framing drifts from the iOS client by a single byte, these fail.
import { describe, expect, it } from "vitest";
import {
  possessionSubjectSHA256, joinAttemptSubjectSHA256,
  possessionProofMessage, admissionProofMessage, challengeBytesSHA256,
} from "../src/proof.js";
import { b64url } from "../src/ids.js";

const CHALLENGE_BYTES = new Uint8Array(32).map((_, i) => i);
const CHALLENGE_B64 = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const CHALLENGE_SHA = "630dcd2966c4336691125448bbb25b4ff412a49c732db2c8abc1b8581bd710dd";
const hex = (u: Uint8Array) => [...u].map((b) => b.toString(16).padStart(2, "0")).join("");

describe("Swift-verified proof framing", () => {
  it("encodes challenge bytes with URL-safe base64 and hashes the raw bytes", async () => {
    expect(b64url(CHALLENGE_BYTES)).toBe(CHALLENGE_B64);
    expect(await challengeBytesSHA256(CHALLENGE_B64)).toBe(CHALLENGE_SHA);
  });

  it("derives the same subject references as the app", async () => {
    expect(await possessionSubjectSHA256("account_recovery", "alice@example.com")).toBe("34c28577e177547cd836994034e20232ab1434dc27ac36be8281fb7b1bf2e887");
    expect(await possessionSubjectSHA256("full_app_handoff_exchange", "ref-123")).toBe("3e34679f1eeec0c277ecc757f9b7184220db01e183180085f5b99d97670a91c6");
    expect(await possessionSubjectSHA256("full_app_session_resume", "handle-xyz")).toBe("43d8a24f3884b4094dbc72225e04fc0113bf5153633495b6a4f69a127f2aca7a");
    expect(await joinAttemptSubjectSHA256("join-abc")).toBe("eb6c4c19e8aa57e319411ad61b4f364780bd2289ae57ab1ed342e32ce3ffc9aa");
  });

  it("builds byte-identical possession and admission proof messages", async () => {
    const subject = await possessionSubjectSHA256("account_recovery", "alice@example.com");
    const join = await joinAttemptSubjectSHA256("join-abc");
    expect(hex(possessionProofMessage({
      challengeID: "cid-1", purpose: "account_recovery", subjectReferenceSHA256: subject,
      deviceSessionID: "ds-1", deviceKeyID: "key-1", challengeSHA256: CHALLENGE_SHA,
    }, CHALLENGE_BYTES))).toBe("6d6f74696f6e6d69782e70617274696369706174696f6e2e6465766963655f706f7373657373696f6e5f70726f6f662e763100000000056369642d31000000106163636f756e745f7265636f7665727900000040333463323835373765313737353437636438333639393430333465323032333261623134333464633237616333366265383238316662376231626632653838370000000464732d31000000056b65792d31000000403633306463643239363663343333363639313132353434386262623235623466663431326134396337333264623263386162633162383538316264373130646400000020000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
    expect(hex(admissionProofMessage({
      challengeID: "cid-1", joinAttemptID: "ja-1", joinAttemptReferenceSHA256: join,
      deviceSessionID: "ds-1", deviceKeyID: "key-1", challengeSHA256: CHALLENGE_SHA,
    }, CHALLENGE_BYTES))).toBe("6d6f74696f6e6d69782e70617274696369706174696f6e2e61646d697373696f6e5f70726f6f662e763100000000056369642d31000000046a612d3100000040656236633463313965386161353765333139343131616436316234663336343738306264323238396165353761623165643334326533326365336666633961610000000464732d31000000056b65792d31000000403633306463643239363663343333363639313132353434386262623235623466663431326134396337333264623263386162633162383538316264373130646400000020000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
  });
});
