// Copy of the token-request framing used by the app
// (ParticipationDeviceKeyStore.signCoordinatorTokenRequest +
//  ParticipationEphemeralDeviceProofProvider.appendLengthPrefixed).
// Its output is asserted in test/token.test.ts so the coordinator can never
// drift from the bytes the app actually signs.
//
//   swift tools/token-vectors.swift
import Foundation

func appendLengthPrefixed(_ value: Data, to result: inout Data) {
    var count = UInt32(value.count).bigEndian
    withUnsafeBytes(of: &count) { result.append(contentsOf: $0) }
    result.append(value)
}

func tokenRequestMessage(keyID: String, publicKeyBase64URL: String, nonce: String, issuedAt: String) -> Data {
    var message = Data("motionmix.participation.token_request.v1\u{0}".utf8)
    [keyID, publicKeyBase64URL, nonce, issuedAt].forEach {
        appendLengthPrefixed(Data($0.utf8), to: &message)
    }
    return message
}

let message = tokenRequestMessage(
    keyID: "abc123",
    publicKeyBase64URL: "BAmMsample",
    nonce: "nonce-xyz",
    issuedAt: "2026-10-11T19:00:00Z"
)
print("len=\(message.count)")
print(message.map { String(format: "%02x", $0) }.joined())
