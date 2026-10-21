// fleet-authority: the root trust root of docs/DELEGATED-AUTHORITY.md, v1.
//
// A root LaunchDaemon that runs ONLY scripts it has staged itself, after an
// approval it can verify:
//   (a) a connection on its unix socket from the approver account (peer
//       credentials), reachable from the phone only through sshd's forced
//       command for that account, or
//   (b) a P-256 signature over the canonical approval message from an
//       enrolled key (the phone's Secure Enclave key, later).
// Everything on the path from "approved" to "running" is root-owned. The
// login user can stage and look; it cannot approve, alter staged bytes, change
// policy, or read keys.
//
// Layout (all root:wheel): /Library/FleetAuthority/{bin,policy.json,
// install-receipt.json,templates/,pending/,log/receipts.jsonl}
// Socket: /var/run/fleet-authority.sock (0666; execute is gated by identity,
// not by who can connect).
//
// Build: swiftc -O FleetAuthority.swift -o fleet-authority
import CryptoKit
import Darwin
import Foundation

let VERSION = "fleet-authority/1.0"
let ROOT = "/Library/FleetAuthority"
let SOCK = "/var/run/fleet-authority.sock"
let OUTPUT_CAP = 1 << 20

// MARK: - helpers

func sha256Hex(_ d: Data) -> String { SHA256.hash(data: d).map { String(format: "%02x", $0) }.joined() }
func canonical(_ o: Any) throws -> Data { try JSONSerialization.data(withJSONObject: o, options: [.sortedKeys, .withoutEscapingSlashes]) }
func nowISO() -> String { ISO8601DateFormatter().string(from: Date()) }
func now() -> Double { Date().timeIntervalSince1970 }
func randomHex(_ n: Int) -> String { (0..<n).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined() }
func readFile(_ p: String) -> Data? { FileManager.default.contents(atPath: p) }
func stderr(_ s: String) { FileHandle.standardError.write(Data((s + "\n").utf8)) }
func fail(_ s: String) -> Never { stderr(s); exit(2) }

struct Refusal: Error { let code: String }
func require(_ ok: Bool, _ code: String) throws { if !ok { throw Refusal(code: code) } }

/// Write root-only, atomically.
func writePrivate(_ path: String, _ data: Data, mode: Int = 0o600) throws {
    let tmp = path + ".tmp-" + randomHex(4)
    try data.write(to: URL(fileURLWithPath: tmp))
    try FileManager.default.setAttributes([.posixPermissions: mode, .ownerAccountID: 0, .groupOwnerAccountID: 0], ofItemAtPath: tmp)
    try require(rename(tmp, path) == 0, "rename-failed")  // atomic replace
}

// MARK: - policy

struct Policy {
    let raw: [String: Any]
    let hash: String
    var host: String { raw["host"] as? String ?? "" }
    var defaultTier: Int { raw["default_tier"] as? Int ?? 3 }
    var expiryS: Double { Double(raw["expiry_s"] as? Int ?? 600) }
    var approverUids: [Int] { raw["approver_uids"] as? [Int] ?? [] }
    var paused: Bool { ((raw["kill_switch"] as? [String: Any])?["paused"] as? Bool) ?? false }
    var protectedPatterns: [String] { raw["protected_path_patterns"] as? [String] ?? ["/Library/FleetAuthority", "/etc/sudoers", "/Library/LaunchDaemons", "/etc/ssh"] }
    var tier0Templates: [String: [String: Any]] { raw["tier0_templates"] as? [String: [String: Any]] ?? [:] }
    var enrolledKeys: [[String: String]] { raw["enrolled_keys"] as? [[String: String]] ?? [] }

    static func load() throws -> Policy {
        guard let d = readFile(ROOT + "/policy.json"), let o = try JSONSerialization.jsonObject(with: d) as? [String: Any] else { throw Refusal(code: "policy-unreadable") }
        try require((o["v"] as? Int) == 1 && !((o["host"] as? String) ?? "").isEmpty, "policy-shape")
        return Policy(raw: o, hash: sha256Hex(try canonical(o)))
    }
}

// MARK: - requests (staged, root-only)

struct StagedRequest {
    var id: String, fp: String, nonce: String, tier: Int, stagedAt: Double, expiresAt: Double
    var stagedByUid: Int, description: String, template: String?, args: [String], script: String
    var runAs: String, timeoutS: Int, shownAt: Double?, state: String, policyHash: String

    var dir: String { ROOT + "/pending/" + id }
    func toDict() -> [String: Any] {
        var d: [String: Any] = ["id": id, "fp": fp, "nonce": nonce, "tier": tier, "staged_at": stagedAt, "expires_at": expiresAt,
                                "staged_by_uid": stagedByUid, "description": description, "args": args, "script": script,
                                "run_as": runAs, "timeout_s": timeoutS, "state": state, "policy_hash": policyHash]
        if let t = template { d["template"] = t }
        if let s = shownAt { d["shown_at"] = s }
        return d
    }
    static func from(_ d: [String: Any]) -> StagedRequest? {
        guard let id = d["id"] as? String, let fp = d["fp"] as? String, let nonce = d["nonce"] as? String, let tier = d["tier"] as? Int,
              let sa = d["staged_at"] as? Double, let ea = d["expires_at"] as? Double, let uid = d["staged_by_uid"] as? Int,
              let desc = d["description"] as? String, let args = d["args"] as? [String], let script = d["script"] as? String,
              let runAs = d["run_as"] as? String, let to = d["timeout_s"] as? Int, let state = d["state"] as? String, let ph = d["policy_hash"] as? String
        else { return nil }
        return StagedRequest(id: id, fp: fp, nonce: nonce, tier: tier, stagedAt: sa, expiresAt: ea, stagedByUid: uid, description: desc,
                             template: d["template"] as? String, args: args, script: script, runAs: runAs, timeoutS: to,
                             shownAt: d["shown_at"] as? Double, state: state, policyHash: ph)
    }
    func save() throws {
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try writePrivate(dir + "/request.json", try canonical(toDict()))
        try writePrivate(dir + "/script.sh", Data(script.utf8), mode: 0o500)
    }
    static func load(_ id: String) -> StagedRequest? {
        guard id.range(of: "^[a-f0-9]{16}$", options: .regularExpression) != nil, let d = readFile(ROOT + "/pending/" + id + "/request.json"),
              let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return nil }
        return from(o)
    }
    static func all() -> [StagedRequest] {
        ((try? FileManager.default.contentsOfDirectory(atPath: ROOT + "/pending")) ?? []).compactMap(load).sorted { $0.stagedAt < $1.stagedAt }
    }
    /// What the approver signs / sees. Everything that decides what runs.
    func canonicalPayload(host: String) -> [String: Any] {
        ["v": 1, "host": host, "request_id": id, "fp": fp, "nonce": nonce, "tier": tier, "expires_at": Int(expiresAt)]
    }
    func render(host: String) -> String {
        var s = "\(host) is waiting for approval\n"
        s += "request \(id)   fingerprint \(fp.prefix(16))   tier \(tier)\n"
        s += "expires \(ISO8601DateFormatter().string(from: Date(timeIntervalSince1970: expiresAt)))   staged by uid \(stagedByUid)\n"
        s += "agent's description (a hint, not what is approved):\n  \(description)\n"
        if let t = template { s += "template \(t)  args \(args)\n" }
        s += "exactly what runs as \(runAs) (timeout \(timeoutS) s):\n----\n\(script)\n----\n"
        s += "approve with: fingerprint \(fp.prefix(16))\n"
        return s
    }
}

// MARK: - receipts (hash chain)

final class Receipts {
    static let path = ROOT + "/log/receipts.jsonl"
    static func last() -> (seq: Int, hash: String) {
        guard let d = readFile(path), let text = String(data: d, encoding: .utf8) else { return (0, String(repeating: "0", count: 64)) }
        let lines = text.split(separator: "\n")
        guard let l = lines.last, let o = try? JSONSerialization.jsonObject(with: Data(l.utf8)) as? [String: Any],
              let seq = o["seq"] as? Int, let h = o["hash"] as? String else { return (0, String(repeating: "0", count: 64)) }
        return (seq, h)
    }
    static func append(_ kind: String, _ fields: [String: Any]) {
        let prev = last()
        var e = fields
        e["seq"] = prev.seq + 1; e["prev"] = prev.hash; e["kind"] = kind; e["at"] = nowISO(); e["daemon"] = VERSION
        guard let body = try? canonical(e) else { return }
        e["hash"] = sha256Hex(Data(prev.hash.utf8) + body)
        guard let line = try? canonical(e) else { return }
        if let h = FileHandle(forWritingAtPath: path) { h.seekToEndOfFile(); h.write(line + Data("\n".utf8)); try? h.close() }
        else { try? writePrivate(path, line + Data("\n".utf8)) }
    }
}

// MARK: - integrity

func selfIntegrity() -> (ok: Bool, reason: String) {
    let exe = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath().path
    guard let bin = readFile(exe) else { return (false, "cannot-read-self") }
    guard let rd = readFile(ROOT + "/install-receipt.json"), let r = try? JSONSerialization.jsonObject(with: rd) as? [String: Any],
          let expected = r["binary_sha256"] as? String else { return (false, "no-install-receipt") }
    let actual = sha256Hex(bin)
    if actual != expected { return (false, "binary-hash-mismatch") }
    var st = stat()
    if stat(exe, &st) != 0 || st.st_uid != 0 || (st.st_mode & 0o022) != 0 { return (false, "binary-not-root-owned-readonly") }
    return (true, "ok")
}

// MARK: - execution

func execute(_ r: StagedRequest, host: String) -> (exit: Int32, out: Data, limited: Bool, timedOut: Bool) {
    var pipeFds: [Int32] = [0, 0]
    pipe(&pipeFds)
    var actions: posix_spawn_file_actions_t?
    posix_spawn_file_actions_init(&actions)
    posix_spawn_file_actions_addopen(&actions, 0, "/dev/null", O_RDONLY, 0)
    posix_spawn_file_actions_adddup2(&actions, pipeFds[1], 1)
    posix_spawn_file_actions_adddup2(&actions, pipeFds[1], 2)
    posix_spawn_file_actions_addclose(&actions, pipeFds[0])
    var attr: posix_spawnattr_t?
    posix_spawnattr_init(&attr)
    posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETPGROUP))
    posix_spawnattr_setpgroup(&attr, 0)
    let argv = ["/bin/bash", r.dir + "/script.sh"] + r.args
    let env = ["PATH=/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin", "HOME=/var/root", "LANG=en_US.UTF-8", "FLEET_REQUEST_ID=" + r.id, "FLEET_HOST=" + host]
    let cargv = argv.map { strdup($0) } + [nil]
    let cenv = env.map { strdup($0) } + [nil]
    var pid: pid_t = 0
    let rc = posix_spawn(&pid, "/bin/bash", &actions, &attr, cargv, cenv)
    cargv.forEach { free($0) }; cenv.forEach { free($0) }
    posix_spawn_file_actions_destroy(&actions); posix_spawnattr_destroy(&attr)
    close(pipeFds[1])
    if rc != 0 { close(pipeFds[0]); return (127, Data("spawn failed: \(rc)".utf8), false, false) }
    var out = Data(); var limited = false; var timedOut = false
    let deadline = now() + Double(r.timeoutS)
    var buf = [UInt8](repeating: 0, count: 65536)
    let flags = fcntl(pipeFds[0], F_GETFL); _ = fcntl(pipeFds[0], F_SETFL, flags | O_NONBLOCK)
    var finished = false
    while !finished {
        var fds = pollfd(fd: pipeFds[0], events: Int16(POLLIN), revents: 0)
        let pr = poll(&fds, 1, 250)
        if pr > 0 {
            let n = read(pipeFds[0], &buf, buf.count)
            if n > 0 {
                if out.count + n > OUTPUT_CAP { out.append(contentsOf: buf[0..<max(0, OUTPUT_CAP - out.count)]); limited = true }
                else { out.append(contentsOf: buf[0..<n]) }
            } else if n == 0 { finished = true }
        }
        if (limited || now() > deadline) && !finished {
            timedOut = now() > deadline
            killpg(pid, SIGKILL); finished = true
        }
    }
    close(pipeFds[0])
    var status: Int32 = 0
    waitpid(pid, &status, 0)
    let exitCode: Int32 = (status & 0x7f) == 0 ? (status >> 8) & 0xff : 128 + (status & 0x7f)
    return (exitCode, out, limited, timedOut)
}

// MARK: - the daemon

final class Daemon {
    var integrity = selfIntegrity()
    var host: String = (try? Policy.load().host) ?? "unknown"

    func deriveTier(policy: Policy, template: String?, script: String) -> Int {
        if let t = template {
            if policy.tier0Templates[t] != nil && !policy.paused { return 0 }
            return 2
        }
        for p in policy.protectedPatterns where script.contains(p) { return 3 }
        return policy.defaultTier
    }

    func stage(_ req: [String: Any], uid: Int) throws -> [String: Any] {
        let policy = try Policy.load()
        let desc = (req["description"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        try require(!desc.isEmpty && desc.count <= 500, "description-required")
        let runAs = req["run_as"] as? String ?? "root"
        try require(runAs == "root", "run-as-root-only-in-v1")
        let timeoutS = req["timeout_s"] as? Int ?? 600
        try require(timeoutS >= 1 && timeoutS <= 3600, "timeout-range")
        var script: String, template: String? = nil, args: [String] = []
        if let t = req["template"] as? String {
            try require(t.range(of: "^[a-z][a-z0-9.-]{1,63}$", options: .regularExpression) != nil, "template-name")
            let path = ROOT + "/templates/" + t + ".sh"
            guard let body = readFile(path), let text = String(data: body, encoding: .utf8) else { throw Refusal(code: "template-missing") }
            var st = stat(); try require(stat(path, &st) == 0 && st.st_uid == 0 && (st.st_mode & 0o022) == 0, "template-not-root-owned")
            args = req["args"] as? [String] ?? []
            try require(args.count <= 16 && args.allSatisfy { $0.range(of: "^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$", options: .regularExpression) != nil }, "template-args")
            template = t; script = text
        } else {
            script = req["script"] as? String ?? ""
            try require(!script.isEmpty && script.utf8.count <= 65536 && !script.contains("\0"), "script-required")
        }
        let tier = deriveTier(policy: policy, template: template, script: script)
        let id = randomHex(8), nonce = randomHex(16)
        let fpBody = try canonical(["host": policy.host, "script": script, "args": args, "run_as": runAs, "timeout_s": timeoutS, "template": template ?? ""])
        let fp = sha256Hex(fpBody)
        var r = StagedRequest(id: id, fp: fp, nonce: nonce, tier: tier, stagedAt: now(), expiresAt: now() + policy.expiryS, stagedByUid: uid,
                              description: desc, template: template, args: args, script: script, runAs: runAs, timeoutS: timeoutS,
                              shownAt: nil, state: "pending", policyHash: policy.hash)
        try r.save()
        Receipts.append("staged", ["request_id": id, "fp": fp, "tier": tier, "by_uid": uid, "template": template ?? "", "policy_hash": policy.hash])
        if tier == 0 {
            r.state = "auto"; try r.save()
            return try run(r, by: "policy-tier0", policy: policy)
        }
        return ["ok": true, "request_id": id, "fp": fp, "tier": tier, "expires_at": Int(r.expiresAt), "nonce": nonce]
    }

    func show(_ idOrPrefix: String?) throws -> [String: Any] {
        let pending = StagedRequest.all().filter { $0.state == "pending" && $0.expiresAt > now() }
        guard var r = (idOrPrefix.flatMap { p in pending.first { $0.id == p || $0.fp.hasPrefix(p) } } ?? pending.last) else {
            return ["ok": true, "empty": true, "text": "Nothing waiting on \(host)."]
        }
        r.shownAt = now(); try r.save()
        Receipts.append("shown", ["request_id": r.id, "fp": r.fp])
        return ["ok": true, "request": r.toDict(), "payload": r.canonicalPayload(host: host), "text": r.render(host: host)]
    }

    func decide(_ idOrPrefix: String, decision: String, by: String, policy: Policy) throws -> [String: Any] {
        try require(decision == "approve" || decision == "deny", "decision")
        guard var r = StagedRequest.all().first(where: { ($0.id == idOrPrefix || $0.fp.hasPrefix(idOrPrefix)) && $0.state == "pending" }) else { throw Refusal(code: "no-such-pending-request") }
        try require(idOrPrefix.count >= 8, "identifier-too-short")
        try require(r.expiresAt > now(), "request-expired")
        try require(r.shownAt != nil, "not-shown-before-decision")
        try require(r.policyHash == policy.hash, "policy-changed-since-staging")
        if decision == "deny" {
            r.state = "denied"; try r.save()
            Receipts.append("denied", ["request_id": r.id, "fp": r.fp, "by": by])
            return ["ok": true, "denied": r.id]
        }
        return try run(r, by: by, policy: policy)
    }

    func run(_ req: StagedRequest, by: String, policy: Policy) throws -> [String: Any] {
        var r = req
        try require(integrity.ok, "daemon-integrity-" + integrity.reason)
        try require(!policy.paused || r.tier > 0, "kill-switch-paused")
        // Re-verify the staged bytes against the fingerprint before running.
        guard let onDisk = readFile(r.dir + "/script.sh"), String(data: onDisk, encoding: .utf8) == r.script else { throw Refusal(code: "staged-bytes-changed") }
        let fpBody = try canonical(["host": policy.host, "script": r.script, "args": r.args, "run_as": r.runAs, "timeout_s": r.timeoutS, "template": r.template ?? ""])
        try require(sha256Hex(fpBody) == r.fp, "fingerprint-mismatch")
        r.state = "running"; try r.save()
        Receipts.append("approved", ["request_id": r.id, "fp": r.fp, "tier": r.tier, "by": by])
        let res = execute(r, host: policy.host)
        r.state = "done"; try r.save()
        try? writePrivate(ROOT + "/log/" + r.id + ".out", res.out)
        Receipts.append("executed", ["request_id": r.id, "fp": r.fp, "exit_code": Int(res.exit), "out_sha256": sha256Hex(res.out),
                                     "out_bytes": res.out.count, "limited": res.limited, "timed_out": res.timedOut])
        let tail = String(data: res.out.suffix(4000), encoding: .utf8) ?? ""
        return ["ok": res.exit == 0, "executed": r.id, "exit_code": Int(res.exit), "timed_out": res.timedOut, "output_tail": tail]
    }

    func approveSigned(_ req: [String: Any], policy: Policy) throws -> [String: Any] {
        guard let msg = req["message"] as? [String: Any], let sigB64 = req["signature"] as? String, let keyId = req["key_id"] as? String,
              let sig = Data(base64Encoded: sigB64) else { throw Refusal(code: "signed-shape") }
        guard let key = policy.enrolledKeys.first(where: { $0["id"] == keyId }), let spki = key["p256_spki_b64"].flatMap({ Data(base64Encoded: $0) }),
              let pub = try? P256.Signing.PublicKey(derRepresentation: spki) else { throw Refusal(code: "key-not-enrolled") }
        let data = try canonical(msg)
        guard let s = try? P256.Signing.ECDSASignature(derRepresentation: sig), pub.isValidSignature(s, for: data) else { throw Refusal(code: "bad-signature") }
        try require(msg["v"] as? Int == 1 && msg["host"] as? String == policy.host, "message-host")
        guard let id = msg["request_id"] as? String, let r = StagedRequest.load(id) else { throw Refusal(code: "no-such-request") }
        try require(r.state == "pending", "request-not-pending")
        try require(msg["fp"] as? String == r.fp && msg["nonce"] as? String == r.nonce && msg["tier"] as? Int == r.tier, "message-binding")
        try require((msg["expires_at"] as? Int ?? 0) >= Int(now()) && Int(r.expiresAt) == msg["expires_at"] as? Int, "message-expired")
        let decision = msg["decision"] as? String ?? ""
        if r.shownAt == nil { var rr = r; rr.shownAt = now(); try rr.save() }
        return try decide(id, decision: decision, by: "key:" + keyId, policy: policy)
    }

    func handle(_ req: [String: Any], uid: Int) -> [String: Any] {
        do {
            let op = req["op"] as? String ?? ""
            switch op {
            case "stage": return try stage(req, uid: uid)
            case "show": return try show(req["request_id"] as? String)
            case "list":
                return ["ok": true, "pending": StagedRequest.all().filter { $0.state == "pending" }.map { ["id": $0.id, "fp": String($0.fp.prefix(16)), "tier": $0.tier, "description": $0.description, "expires_at": Int($0.expiresAt)] }]
            case "status":
                let p = try? Policy.load()
                return ["ok": true, "host": host, "integrity": integrity.ok, "integrity_reason": integrity.reason, "policy_hash": p?.hash ?? "",
                        "paused": p?.paused ?? true, "receipts": Receipts.last().seq, "pending": StagedRequest.all().filter { $0.state == "pending" }.count, "version": VERSION]
            case "approve", "deny":
                let policy = try Policy.load()
                try require(policy.approverUids.contains(uid), "caller-is-not-an-approver")
                return try decide(req["request_id"] as? String ?? "", decision: op, by: "uid:\(uid)", policy: policy)
            case "approve_signed":
                return try approveSigned(req, policy: try Policy.load())
            default: throw Refusal(code: "unknown-op")
            }
        } catch let r as Refusal {
            Receipts.append("refused", ["op": req["op"] as? String ?? "", "code": r.code, "by_uid": uid])
            return ["ok": false, "refused": r.code]
        } catch {
            return ["ok": false, "refused": "internal:" + String(describing: error)]
        }
    }

    func serve() -> Never {
        Receipts.append("started", ["integrity": integrity.ok, "reason": integrity.reason, "host": host])
        unlink(SOCK)
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        var addr = sockaddr_un(); addr.sun_family = sa_family_t(AF_UNIX)
        SOCK.withCString { s in withUnsafeMutablePointer(to: &addr.sun_path) { $0.withMemoryRebound(to: CChar.self, capacity: 104) { strncpy($0, s, 103) } } }
        let len = socklen_t(MemoryLayout<sockaddr_un>.size)
        guard withUnsafePointer(to: &addr, { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, len) } }) == 0 else { fail("bind failed") }
        chmod(SOCK, 0o666)
        listen(fd, 16)
        while true {
            let c = accept(fd, nil, nil)
            if c < 0 { continue }
            var tv = timeval(tv_sec: 30, tv_usec: 0)
            setsockopt(c, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
            var cred = xucred(); var clen = socklen_t(MemoryLayout<xucred>.size)
            let uid: Int = getsockopt(c, 0 /* SOL_LOCAL */, 0x001 /* LOCAL_PEERCRED */, &cred, &clen) == 0 ? Int(cred.cr_uid) : -1
            var data = Data(); var buf = [UInt8](repeating: 0, count: 65536)
            while data.count < 1 << 20 {
                let n = read(c, &buf, buf.count)
                if n <= 0 { break }
                data.append(contentsOf: buf[0..<n])
                if buf[0..<n].contains(10) { break }
            }
            let req = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
            let resp = uid < 0 ? ["ok": false, "refused": "peer-credentials-unavailable"] : handle(req, uid: uid)
            if let out = try? canonical(resp) { _ = out.withUnsafeBytes { write(c, $0.baseAddress, out.count) }; _ = write(c, "\n", 1) }
            close(c)
        }
    }
}

// MARK: - client

func client(_ req: [String: Any]) -> [String: Any] {
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    var addr = sockaddr_un(); addr.sun_family = sa_family_t(AF_UNIX)
    SOCK.withCString { s in withUnsafeMutablePointer(to: &addr.sun_path) { $0.withMemoryRebound(to: CChar.self, capacity: 104) { strncpy($0, s, 103) } } }
    guard withUnsafePointer(to: &addr, { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }) == 0 else {
        return ["ok": false, "refused": "daemon-unreachable"]
    }
    guard let out = try? canonical(req) else { return ["ok": false, "refused": "bad-request"] }
    _ = out.withUnsafeBytes { write(fd, $0.baseAddress, out.count) }; _ = write(fd, "\n", 1)
    var data = Data(); var buf = [UInt8](repeating: 0, count: 65536)
    while true { let n = read(fd, &buf, buf.count); if n <= 0 { break }; data.append(contentsOf: buf[0..<n]) }
    close(fd)
    return (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? ["ok": false, "refused": "bad-response"]
}

func printJSON(_ o: [String: Any]) { if let d = try? JSONSerialization.data(withJSONObject: o, options: [.prettyPrinted, .sortedKeys]), let s = String(data: d, encoding: .utf8) { print(s) } }

func cli(_ args: [String]) -> Int32 {
    guard let cmd = args.first else {
        print("fleet-authority daemon | stage <description> [--template name --args a b] (script on stdin) | show [id|fp] | list | status | approve <id|fp> | deny <id|fp> | approver-shell"); return 64
    }
    switch cmd {
    case "daemon":
        guard getuid() == 0 else { fail("daemon must run as root") }
        Daemon().serve()
    case "stage":
        var req: [String: Any] = ["op": "stage", "description": args.dropFirst().first ?? ""]
        var rest = Array(args.dropFirst(2))
        while !rest.isEmpty {
            let f = rest.removeFirst()
            if f == "--template" { req["template"] = rest.isEmpty ? "" : rest.removeFirst() }
            else if f == "--args" { req["args"] = rest; rest = [] }
            else if f == "--timeout" { req["timeout_s"] = Int(rest.isEmpty ? "" : rest.removeFirst()) ?? 600 }
        }
        if req["template"] == nil { req["script"] = String(data: FileHandle.standardInput.readDataToEndOfFile(), encoding: .utf8) ?? "" }
        let r = client(req); printJSON(r); return (r["ok"] as? Bool) == true ? 0 : 1
    case "show":
        let r = client(["op": "show", "request_id": args.count > 1 ? args[1] : NSNull()])
        if let t = r["text"] as? String { print(t) } else { printJSON(r) }
        return 0
    case "list", "status":
        printJSON(client(["op": cmd])); return 0
    case "approve", "deny":
        guard args.count > 1 else { print("need an id or fingerprint"); return 64 }
        let r = client(["op": cmd, "request_id": args[1]])
        if let tail = r["output_tail"] as? String, !tail.isEmpty { print(tail) }
        printJSON(r.filter { $0.key != "output_tail" }); return (r["ok"] as? Bool) == true ? 0 : 1
    case "approver-shell":
        // sshd ForceCommand for the approver account: one command from SSH_ORIGINAL_COMMAND.
        let words = (ProcessInfo.processInfo.environment["SSH_ORIGINAL_COMMAND"] ?? "show").split(separator: " ").map(String.init)
        guard let w = words.first, ["show", "list", "status", "approve", "deny"].contains(w) else { print("allowed: show | list | status | approve <fp> | deny <fp>"); return 64 }
        return cli(words)
    default:
        print("unknown command \(cmd)"); return 64
    }
}

exit(cli(Array(CommandLine.arguments.dropFirst())))
