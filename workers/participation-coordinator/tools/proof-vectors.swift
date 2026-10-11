import CryptoKit
import Foundation

// Copied verbatim from MotionMixApp/Participation/Core/ParticipationDeviceProofProviding.swift
func sha256Hex(_ d: Data) -> String { SHA256.hash(data: d).map { String(format: "%02x", $0) }.joined() }
func hex(_ d: Data) -> String { d.map { String(format: "%02x", $0) }.joined() }
func appendLengthPrefixed(_ value: Data, to result: inout Data) {
    var count = UInt32(value.count).bigEndian
    withUnsafeBytes(of: &count) { result.append(contentsOf: $0) }
    result.append(value)
}
func subjectReferenceSHA256(purpose: String, subjectReference: String) -> String {
    var result = Data("motionmix.participation.possession_subject.v1\u{0}".utf8)
    appendLengthPrefixed(Data(purpose.utf8), to: &result)
    appendLengthPrefixed(Data(subjectReference.utf8), to: &result)
    return sha256Hex(result)
}
func joinAttemptReferenceSHA256(_ reference: String) -> String {
    var result = Data("motionmix.participation.join_attempt_subject.v1\u{0}".utf8)
    appendLengthPrefixed(Data(reference.utf8), to: &result)
    return sha256Hex(result)
}
func possessionMessage(_ fields: [String], _ challengeBytes: Data) -> String {
    var result = Data("motionmix.participation.device_possession_proof.v1\u{0}".utf8)
    fields.forEach { appendLengthPrefixed(Data($0.utf8), to: &result) }
    appendLengthPrefixed(challengeBytes, to: &result)
    return hex(result)
}
func admissionMessage(_ fields: [String], _ challengeBytes: Data) -> String {
    var result = Data("motionmix.participation.admission_proof.v1\u{0}".utf8)
    fields.forEach { appendLengthPrefixed(Data($0.utf8), to: &result) }
    appendLengthPrefixed(challengeBytes, to: &result)
    return hex(result)
}

let challengeBytes = Data(0..<32)
let challengeB64 = challengeBytes.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
let challengeSHA = sha256Hex(challengeBytes)

let out: [String: String] = [
  "possession_subject": subjectReferenceSHA256(purpose: "account_recovery", subjectReference: "alice@example.com"),
  "handoff_exchange_subject": subjectReferenceSHA256(purpose: "full_app_handoff_exchange", subjectReference: "ref-123"),
  "resume_subject": subjectReferenceSHA256(purpose: "full_app_session_resume", subjectReference: "handle-xyz"),
  "join_attempt_subject": joinAttemptReferenceSHA256("join-abc"),
  "challenge_b64": challengeB64,
  "challenge_sha256": challengeSHA,
  "possession_message": possessionMessage(["cid-1","account_recovery",subjectReferenceSHA256(purpose:"account_recovery",subjectReference:"alice@example.com"),"ds-1","key-1",challengeSHA], challengeBytes),
  "admission_message": admissionMessage(["cid-1","ja-1",joinAttemptReferenceSHA256("join-abc"),"ds-1","key-1",challengeSHA], challengeBytes),
]
let data = try! JSONSerialization.data(withJSONObject: out, options: [.sortedKeys])
print(String(data: data, encoding: .utf8)!)
