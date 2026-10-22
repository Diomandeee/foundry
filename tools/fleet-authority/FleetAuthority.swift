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
// 1.2: Fabric transport (docs/DELEGATED-AUTHORITY.md S2). The daemon holds a
// P-256 node key (node-key.raw, root 0600). When signal.json names a
// fleet-signal relay, it publishes each staged request there as a node-signed
// canonical payload (everything that decides what runs, script included), polls
// for device-signed decisions and feeds them to approve_signed, and mirrors the
// receipt chain. Outbound HTTPS only; the relay can neither forge a request (the
// phone checks the node signature) nor approve one (the daemon checks the device
// signature against its own enrolled keys). Enrolled device keys live in
// keys.json, outside the policy hash, so enrolling no longer kills pending requests.
//
// Build: swiftc -O FleetAuthority.swift -o fleet-authority
// Test mode (non-root only): FLEET_AUTHORITY_TEST_ROOT=<dir> moves ROOT and the
// socket under <dir> and accepts files owned by the calling user instead of root.
import CryptoKit
import Darwin
import Foundation

let VERSION = "fleet-authority/1.4.0"
let TEST_ROOT: String? = getuid() != 0 ? ProcessInfo.processInfo.environment["FLEET_AUTHORITY_TEST_ROOT"] : nil
let ROOT = TEST_ROOT ?? "/Library/FleetAuthority"
let SOCK = TEST_ROOT.map { $0 + "/fleet-authority.sock" } ?? "/var/run/fleet-authority.sock"
let KEYS = ROOT + "/keys.json"
let NODE_KEY = ROOT + "/node-key.raw"
let SIGNAL_CONF = ROOT + "/signal.json"
let SIGNAL_STATE = ROOT + "/signal-state.json"
/// One lock for everything that reads or writes daemon state (socket ops and the relay poller).
let STATE_LOCK = NSLock()
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

/// Owned by root and not writable by group/other (in test mode: owned by the test user).
func trustedFile(_ path: String) -> Bool {
    var st = stat()
    guard stat(path, &st) == 0 else { return false }
    return (st.st_uid == 0 || (TEST_ROOT != nil && st.st_uid == getuid())) && (st.st_mode & 0o022) == 0
}

/// Write root-only, atomically.
func writePrivate(_ path: String, _ data: Data, mode: Int = 0o600) throws {
    let tmp = path + ".tmp-" + randomHex(4)
    try data.write(to: URL(fileURLWithPath: tmp))
    var attrs: [FileAttributeKey: Any] = [.posixPermissions: mode]
    if TEST_ROOT == nil { attrs[.ownerAccountID] = 0; attrs[.groupOwnerAccountID] = 0 }
    try FileManager.default.setAttributes(attrs, ofItemAtPath: tmp)
    try require(rename(tmp, path) == 0, "rename-failed")  // atomic replace
}

// MARK: - policy

struct Policy {
    let raw: [String: Any]
    let hash: String
    var host: String { raw["host"] as? String ?? "" }
    var defaultTier: Int { raw["default_tier"] as? Int ?? 3 }
    var expiryS: Double { Double(raw["expiry_s"] as? Int ?? 1800) }
    var approverUids: [Int] { raw["approver_uids"] as? [Int] ?? [] }
    var paused: Bool { ((raw["kill_switch"] as? [String: Any])?["paused"] as? Bool) ?? false }
    var protectedPatterns: [String] { raw["protected_path_patterns"] as? [String] ?? ["/Library/FleetAuthority", "/etc/sudoers", "/Library/LaunchDaemons", "/etc/ssh"] }
    var tier0Templates: [String: [String: Any]] { raw["tier0_templates"] as? [String: [String: Any]] ?? [:] }
    /// Keys from policy.json (legacy, hashed) plus keys.json (1.2+, not hashed). Revoked keys are skipped.
    var enrolledKeys: [[String: String]] {
        (raw["enrolled_keys"] as? [[String: String]] ?? []) + KeyStore.load().filter { $0["revoked_at"] == nil }
    }

    static func load() throws -> Policy {
        guard let d = readFile(ROOT + "/policy.json"), let o = try JSONSerialization.jsonObject(with: d) as? [String: Any] else { throw Refusal(code: "policy-unreadable") }
        try require((o["v"] as? Int) == 1 && !((o["host"] as? String) ?? "").isEmpty, "policy-shape")
        return Policy(raw: o, hash: sha256Hex(try canonical(o)))
    }
}

// MARK: - enrolled device keys (keys.json, root-only, outside the policy hash)

enum KeyStore {
    static func load() -> [[String: String]] {
        guard trustedFile(KEYS), let d = readFile(KEYS), let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
              let k = o["keys"] as? [[String: String]] else { return [] }
        return k
    }
    static func save(_ keys: [[String: String]]) throws { try writePrivate(KEYS, try canonical(["v": 1, "keys": keys]), mode: 0o644) }
}

// MARK: - node key (this Mac's identity toward the relay and the phone)

func loadNodeKey(create: Bool) -> P256.Signing.PrivateKey? {
    if trustedFile(NODE_KEY), let d = readFile(NODE_KEY), let k = try? P256.Signing.PrivateKey(rawRepresentation: d) { return k }
    guard create, !FileManager.default.fileExists(atPath: NODE_KEY) else { return nil }
    let k = P256.Signing.PrivateKey()
    do { try writePrivate(NODE_KEY, k.rawRepresentation, mode: 0o600) } catch { return nil }
    return k
}

// MARK: - input hygiene (review M1): what the approver reads must be what runs

/// C0 controls (except newline/tab in scripts), DEL, zero-width and bidi overrides can make the
/// rendered text differ from the bytes. Refuse them rather than try to escape them.
func hasDisplayTrick(_ s: String, allowNewlines: Bool) -> Bool {
    for u in s.unicodeScalars {
        let v = u.value
        if v == 0x0A || v == 0x09 { if !allowNewlines { return true }; continue }
        if v < 0x20 || v == 0x7F { return true }
        if (0x200B...0x200F).contains(v) || (0x202A...0x202E).contains(v) || (0x2066...0x2069).contains(v) || v == 0xFEFF { return true }
    }
    return false
}

/// Tokens that point at login-user-owned files from a root script (review C2): shown as UNPINNED.
func unpinnedRefs(_ script: String) -> [String] {
    var hits: [String] = []
    for line in script.split(separator: "\n", omittingEmptySubsequences: false) {
        let l = String(line)
        if l.trimmingCharacters(in: .whitespaces).hasPrefix("#") { continue }
        for tok in ["/Users/", "~/", "$HOME", "${HOME}", "/opt/homebrew/", "/usr/local/"] where l.contains(tok) {
            hits.append(tok); break
        }
    }
    return Array(Set(hits)).sorted()
}

// MARK: - requests (staged, root-only)

struct StagedRequest {
    var id: String, fp: String, nonce: String, tier: Int, stagedAt: Double, expiresAt: Double
    var stagedByUid: Int, description: String, template: String?, args: [String], script: String
    var runAs: String, timeoutS: Int, shownAt: Double?, state: String, policyHash: String
    /// Review C2 (1.4): files the script uses, stored root-only in pending/<id>/files and hashed into the
    /// fingerprint. name -> sha256. The script reaches them as "$FLEET_FILES/<name>".
    var attachments: [String: String] = [:]

    var dir: String { ROOT + "/pending/" + id }
    var filesDir: String { dir + "/files" }

    /// The fingerprint body. `attachments` appears only when there are some, so pre-1.4 fingerprints are unchanged.
    static func fpBody(host: String, script: String, args: [String], runAs: String, timeoutS: Int, template: String?,
                       attachments: [String: String]) throws -> Data {
        var o: [String: Any] = ["host": host, "script": script, "args": args, "run_as": runAs, "timeout_s": timeoutS, "template": template ?? ""]
        if !attachments.isEmpty { o["attachments"] = attachments }
        return try canonical(o)
    }

    /// Re-hash every attachment on disk; nil when all match.
    func attachmentMismatch() -> String? {
        for (name, want) in attachments {
            let path = filesDir + "/" + name
            guard trustedFile(path), let d = readFile(path), sha256Hex(d) == want else { return name }
        }
        return nil
    }
    func toDict() -> [String: Any] {
        var d: [String: Any] = ["id": id, "fp": fp, "nonce": nonce, "tier": tier, "staged_at": stagedAt, "expires_at": expiresAt,
                                "staged_by_uid": stagedByUid, "description": description, "args": args, "script": script,
                                "run_as": runAs, "timeout_s": timeoutS, "state": state, "policy_hash": policyHash]
        if let t = template { d["template"] = t }
        if let s = shownAt { d["shown_at"] = s }
        if !attachments.isEmpty { d["attachments"] = attachments }
        return d
    }
    static func from(_ d: [String: Any]) -> StagedRequest? {
        guard let id = d["id"] as? String, let fp = d["fp"] as? String, let nonce = d["nonce"] as? String, let tier = d["tier"] as? Int,
              let sa = d["staged_at"] as? Double, let ea = d["expires_at"] as? Double, let uid = d["staged_by_uid"] as? Int,
              let desc = d["description"] as? String, let args = d["args"] as? [String], let script = d["script"] as? String,
              let runAs = d["run_as"] as? String, let to = d["timeout_s"] as? Int, let state = d["state"] as? String, let ph = d["policy_hash"] as? String
        else { return nil }
        var r = StagedRequest(id: id, fp: fp, nonce: nonce, tier: tier, stagedAt: sa, expiresAt: ea, stagedByUid: uid, description: desc,
                              template: d["template"] as? String, args: args, script: script, runAs: runAs, timeoutS: to,
                              shownAt: d["shown_at"] as? Double, state: state, policyHash: ph)
        r.attachments = d["attachments"] as? [String: String] ?? [:]
        return r
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
    /// What the daemon publishes to the relay, signed with the node key: everything that decides what
    /// runs, so the phone can recompute fp itself and render the exact script it is approving.
    func signalPayload(host: String) -> [String: Any] {
        ["v": 1, "host": host, "request_id": id, "fp": fp, "nonce": nonce, "tier": tier, "expires_at": Int(expiresAt),
         "staged_at": Int(stagedAt), "description": description, "script": script, "script_sha256": sha256Hex(Data(script.utf8)),
         "args": args, "template": template ?? "", "run_as": runAs, "timeout_s": timeoutS,
         "approver_key_ids": ((try? Policy.load())?.enrolledKeys ?? []).filter { $0["biometric"] == "true" }.compactMap { $0["id"] }.sorted(),
         "unpinned": unpinnedRefs(script),
         "attachments": attachments.isEmpty ? [String: Any]() : Dictionary(uniqueKeysWithValues: attachments.map { (name, sha) -> (String, Any) in
             let d = readFile(filesDir + "/" + name) ?? Data()
             var e: [String: Any] = ["sha256": sha, "bytes": d.count]
             if d.count <= 65536, !d.contains(0), let t = String(data: d, encoding: .utf8) { e["text"] = t }
             return (name, e)
         })]
    }
    func render(host: String) -> String {
        let lines = script.split(separator: "\n", omittingEmptySubsequences: false).count
        let descJSON = (try? String(data: canonical([description]), encoding: .utf8)) ?? "[]"
        var s = "\(host) is waiting for approval\n"
        s += "request \(id)   fingerprint \(fp.prefix(16))   tier \(tier)\n"
        s += "expires \(ISO8601DateFormatter().string(from: Date(timeIntervalSince1970: expiresAt)))   staged by uid \(stagedByUid)\n"
        s += "agent's description (a hint, not what is approved): \(descJSON)\n"
        if let t = template { s += "template \(t)  args \(args)\n" }
        let unpinned = unpinnedRefs(script)
        if !unpinned.isEmpty { s += "WARNING UNPINNED: this script refers to files outside root control (\(unpinned.joined(separator: " "))). What runs depends on them, not only on the text below.\n" }
        s += "exactly what runs as \(runAs) (timeout \(timeoutS) s), \(lines) lines, sha256 \(sha256Hex(Data(script.utf8)).prefix(16)):\n"
        s += "---- begin \(id) ----\n\(script)\n---- end \(id) ----\n"
        for name in attachments.keys.sorted() {
            let d = readFile(filesDir + "/" + name) ?? Data()
            s += "attached file $FLEET_FILES/\(name): \(d.count) bytes, sha256 \(attachments[name]!.prefix(16)) (root-only, part of the fingerprint)\n"
            if d.count <= 65536, !d.contains(0), let t = String(data: d, encoding: .utf8) {
                s += "---- begin \(id)/\(name) ----\n\(t)\n---- end \(id)/\(name) ----\n"
            } else { s += "  (binary: check the sha256 against the build you expect)\n" }
        }
        s += "to decide: send approve or deny (within 5 min of this screen, only while it is the one request waiting),\nor approve \(id) / deny \(id)\n"
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

// MARK: - relay (fleet-signal) client: outbound HTTPS only

struct Relay {
    let base: String, nodeId: String, key: P256.Signing.PrivateKey

    /// signal.json: {"url": "https://...", "node_id": "..."}; root-owned. Absent = relay off (Shortcuts path only).
    static func load(_ key: P256.Signing.PrivateKey?) -> Relay? {
        guard let key, trustedFile(SIGNAL_CONF), let d = readFile(SIGNAL_CONF),
              let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
              let url = o["url"] as? String, url.hasPrefix("https://") || (TEST_ROOT != nil && url.hasPrefix("http://")),
              let node = o["node_id"] as? String, !node.isEmpty else { return nil }
        return Relay(base: url.hasSuffix("/") ? String(url.dropLast()) : url, nodeId: node, key: key)
    }

    /// Signed call: headers x-fs-key/x-fs-ts/x-fs-sig over "METHOD\nPATH?QUERY\nTS\nsha256(body)".
    func call(_ method: String, _ pathQuery: String, _ body: Data = Data()) -> (status: Int, json: [String: Any]?) {
        guard let url = URL(string: base + pathQuery) else { return (0, nil) }
        let ts = String(Int(now()))
        let signing = "\(method)\n\(pathQuery)\n\(ts)\n\(sha256Hex(body))"
        guard let sig = try? key.signature(for: Data(signing.utf8)) else { return (0, nil) }
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
        req.httpMethod = method
        req.setValue(nodeId, forHTTPHeaderField: "x-fs-key")
        req.setValue(ts, forHTTPHeaderField: "x-fs-ts")
        req.setValue(sig.derRepresentation.base64EncodedString(), forHTTPHeaderField: "x-fs-sig")
        if method != "GET" { req.httpBody = body; req.setValue("application/json", forHTTPHeaderField: "content-type") }
        let done = DispatchSemaphore(value: 0)
        var result: (Int, [String: Any]?) = (0, nil)
        URLSession.shared.dataTask(with: req) { data, resp, _ in
            result = ((resp as? HTTPURLResponse)?.statusCode ?? 0, data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] })
            done.signal()
        }.resume()
        if done.wait(timeout: .now() + 20) == .timedOut { return (0, nil) }
        return result
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
    if stat(exe, &st) != 0 || !(st.st_uid == 0 || (TEST_ROOT != nil && st.st_uid == getuid())) || (st.st_mode & 0o022) != 0 { return (false, "binary-not-root-owned-readonly") }
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
    // Close the original write end too, or anything the script leaves running in the background keeps
    // the pipe open and the daemon never sees EOF (1.1 bug: the reply to the approver was lost).
    posix_spawn_file_actions_addclose(&actions, pipeFds[1])
    var attr: posix_spawnattr_t?
    posix_spawnattr_init(&attr)
    posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETPGROUP))
    posix_spawnattr_setpgroup(&attr, 0)
    let argv = ["/bin/bash", r.dir + "/script.sh"] + r.args
    // 1.3 (review H1): no /opt/homebrew/bin. It is owned by the login user, so anything resolved from it ran
    // as root. Approved scripts call non-system tools by absolute path, and the render flags them.
    var env = ["PATH=/usr/bin:/bin:/usr/sbin:/sbin", "HOME=/var/root", "LANG=en_US.UTF-8", "FLEET_REQUEST_ID=" + r.id, "FLEET_HOST=" + host,
               "FLEET_FILES=" + r.filesDir]
    if let t = TEST_ROOT { env.append("FLEET_AUTHORITY_TEST_ROOT=" + t) }  // test mode only (non-root); never set in production
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
    /// Created on first start (root); its public half is enrolled at the relay and pinned by the phone.
    let nodeKey: P256.Signing.PrivateKey? = loadNodeKey(create: true)
    var nodeSpki: String { nodeKey?.publicKey.derRepresentation.base64EncodedString() ?? "" }

    func deriveTier(policy: Policy, template: String?, script: String) -> Int {
        if let t = template {
            if policy.tier0Templates[t] != nil && !policy.paused { return 0 }
            return 2
        }
        for p in policy.protectedPatterns where script.contains(p) { return 3 }
        return policy.defaultTier
    }

    func stage(_ req: [String: Any], uid: Int, typed: Bool = false) throws -> [String: Any] {
        let policy = try Policy.load()
        let desc = (req["description"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        try require(!desc.isEmpty && desc.count <= 500, "description-required")
        try require(!hasDisplayTrick(desc, allowNewlines: false), "description-has-control-or-bidi-characters")
        // H9: a full disk or a flood of stages must not lock the approver out.
        gc()
        let live = StagedRequest.all().filter { $0.state == "pending" && $0.expiresAt > now() }
        try require(live.count < 30, "too-many-pending")
        try require(live.filter { $0.stagedByUid == uid }.count < 10, "too-many-pending-for-this-user")
        var fs = statfs()
        try require(statfs(ROOT, &fs) == 0 && UInt64(fs.f_bavail) * UInt64(fs.f_bsize) >= 1 << 30, "less-than-1-GiB-free")
        let runAs = req["run_as"] as? String ?? "root"
        try require(runAs == "root", "run-as-root-only-in-v1")
        let timeoutS = req["timeout_s"] as? Int ?? 600
        try require(timeoutS >= 1 && timeoutS <= 3600, "timeout-range")
        var script: String, template: String? = nil, args: [String] = []
        if let t = req["template"] as? String {
            try require(t.range(of: "^[a-z][a-z0-9.-]{1,63}$", options: .regularExpression) != nil, "template-name")
            let path = ROOT + "/templates/" + t + ".sh"
            guard let body = readFile(path), let text = String(data: body, encoding: .utf8) else { throw Refusal(code: "template-missing") }
            try require(trustedFile(path), "template-not-root-owned")
            args = req["args"] as? [String] ?? []
            try require(args.count <= 16 && args.allSatisfy { $0.range(of: "^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$", options: .regularExpression) != nil }, "template-args")
            template = t; script = text
        } else {
            script = req["script"] as? String ?? ""
            try require(!script.isEmpty && script.utf8.count <= 65536 && !script.contains("\0"), "script-required")
            try require(!hasDisplayTrick(script, allowNewlines: true), "script-has-control-or-bidi-characters")
            if !typed {
                for t in ["keys-add", "keys-revoke", "keys.json", "fleet_authorized_keys", "policy.json", "approver_uids"] where script.contains(t) {
                    throw Refusal(code: "protected-change-needs-typed-op:" + t)
                }
            }
        }
        let tier = deriveTier(policy: policy, template: template, script: script)
        let id = randomHex(8), nonce = randomHex(16)
        // Attachments (review C2): exact bytes travel with the request, so nothing under /Users is executed.
        var files: [String: Data] = [:]
        if let a = req["attachments"] as? [String: String], !a.isEmpty {
            try require(a.count <= 16, "too-many-attachments")
            var total = 0
            for (name, b64) in a {
                try require(name.range(of: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$", options: .regularExpression) != nil, "attachment-name")
                guard let d = Data(base64Encoded: b64) else { throw Refusal(code: "attachment-not-base64") }
                total += d.count
                try require(d.count <= 16 << 20 && total <= 24 << 20, "attachments-too-large")
                if let t = String(data: d, encoding: .utf8), !d.contains(0) {
                    try require(!hasDisplayTrick(t, allowNewlines: true), "attachment-has-control-or-bidi-characters:" + name)
                    if !typed {
                        for p in ["keys-add", "keys-revoke", "keys.json", "fleet_authorized_keys", "policy.json", "approver_uids"] where t.contains(p) {
                            throw Refusal(code: "protected-change-needs-typed-op:" + p)
                        }
                    }
                }
                files[name] = d
            }
        }
        let attach = files.mapValues { sha256Hex($0) }
        let fp = sha256Hex(try StagedRequest.fpBody(host: policy.host, script: script, args: args, runAs: runAs, timeoutS: timeoutS,
                                                    template: template, attachments: attach))
        var r = StagedRequest(id: id, fp: fp, nonce: nonce, tier: tier, stagedAt: now(), expiresAt: now() + policy.expiryS, stagedByUid: uid,
                              description: desc, template: template, args: args, script: script, runAs: runAs, timeoutS: timeoutS,
                              shownAt: nil, state: "pending", policyHash: policy.hash)
        r.attachments = attach
        try r.save()
        if !files.isEmpty {
            try FileManager.default.createDirectory(atPath: r.filesDir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            for (name, d) in files { try writePrivate(r.filesDir + "/" + name, d, mode: 0o400) }
        }
        Receipts.append("staged", ["request_id": id, "fp": fp, "tier": tier, "by_uid": uid, "template": template ?? "", "policy_hash": policy.hash])
        if tier == 0 {
            r.state = "auto"; try r.save()
            return try run(r, by: "policy-tier0", policy: policy)
        }
        return ["ok": true, "request_id": id, "fp": fp, "tier": tier, "expires_at": Int(r.expiresAt), "nonce": nonce]
    }

    /// Review C4: enrolling an approver is a typed op. The daemon writes the script and the description and
    /// computes the fingerprint itself, so the approver reads a fingerprint no stager chose.
    func stageEnroll(_ req: [String: Any], uid: Int) throws -> [String: Any] {
        guard let id = req["key_id"] as? String, id.range(of: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$", options: .regularExpression) != nil,
              let spkiB64 = req["p256_spki_b64"] as? String, let spki = Data(base64Encoded: spkiB64),
              (try? P256.Signing.PublicKey(derRepresentation: spki)) != nil else { throw Refusal(code: "enroll-shape") }
        let biometric = (req["biometric"] as? Bool) == true
        try require(biometric, "enroll-refused-key-is-not-biometric")
        try require(!KeyStore.load().contains { $0["id"] == id }, "key-id-exists")
        let fpHex = sha256Hex(spki)
        let pretty = stride(from: 0, to: 32, by: 4).map { i -> String in let a = fpHex.index(fpHex.startIndex, offsetBy: i); return String(fpHex[a..<fpHex.index(a, offsetBy: 4)]) }.joined(separator: " ")
        let script = "# fleet-authority builtin: enroll approver key (typed op, written by the daemon)\n" +
            "'\(ROOT)/bin/fleet-authority' keys-add '\(id)' '\(spkiB64)' --biometric\n"
        let desc = "ENROLL APPROVER \(id) on \(host): P-256 key SHA256 \(pretty) (biometric). Check this fingerprint on the phone before approving."
        var r = req; r["op"] = "stage"; r["description"] = desc; r["script"] = script; r.removeValue(forKey: "template")
        return try stage(r, uid: uid, typed: true)
    }

    /// Remove decided or expired request dirs after 24 h (receipts and outputs stay in log/).
    func gc() {
        for r in StagedRequest.all() {
            let decided = r.state != "pending" && r.state != "running"
            if (decided || r.expiresAt < now()) && now() - max(r.expiresAt, r.stagedAt) > 86400 {
                try? FileManager.default.removeItem(atPath: r.dir)
            }
        }
    }

    /// A request left "running" by a crash never got its executed receipt: mark it, never re-run it.
    func reconcileOrphans() {
        for var r in StagedRequest.all() where r.state == "running" {
            r.state = "orphaned"; try? r.save()
            Receipts.append("orphaned", ["request_id": r.id, "fp": r.fp])
        }
    }

    func show(_ idOrPrefix: String?, uid: Int) throws -> [String: Any] {
        let pending = StagedRequest.all().filter { $0.state == "pending" && $0.expiresAt > now() }
        guard var r = (idOrPrefix.flatMap { p in pending.first { $0.id == p || $0.fp.hasPrefix(p) } } ?? pending.last) else {
            return ["ok": true, "empty": true, "text": "Nothing waiting on \(host)."]
        }
        // Only a show to an approver counts as "seen before deciding"; anyone else just gets the text.
        if (try? Policy.load())?.approverUids.contains(uid) == true {
            r.shownAt = now(); try r.save()
            Receipts.append("shown", ["request_id": r.id, "fp": r.fp])
        }
        return ["ok": true, "request": r.toDict(), "payload": r.canonicalPayload(host: host), "text": r.render(host: host)]
    }

    func decide(_ idOrPrefix: String, decision: String, by: String, policy: Policy) throws -> [String: Any] {
        try require(decision == "approve" || decision == "deny", "decision")
        // M2: the full 16-hex request id, or at least 16 hex of the fingerprint, and it must match exactly one.
        try require(idOrPrefix.count >= 16, "identifier-too-short-use-the-full-request-id")
        let matches = StagedRequest.all().filter { ($0.id == idOrPrefix || $0.fp.hasPrefix(idOrPrefix)) && $0.state == "pending" }
        try require(matches.count <= 1, "identifier-ambiguous")
        guard var r = matches.first else { throw Refusal(code: "no-such-pending-request") }
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
        let fpBody = try StagedRequest.fpBody(host: policy.host, script: r.script, args: r.args, runAs: r.runAs, timeoutS: r.timeoutS,
                                              template: r.template, attachments: r.attachments)
        try require(sha256Hex(fpBody) == r.fp, "fingerprint-mismatch")
        if let bad = r.attachmentMismatch() { throw Refusal(code: "attachment-changed:" + bad) }
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

    /// A decision signed by an enrolled device key. `message` is either the exact signed string (1.2,
    /// from the relay: the signature covers those bytes) or an object signed as canonical JSON (1.1).
    func approveSigned(_ req: [String: Any], policy: Policy) throws -> [String: Any] {
        guard let sigB64 = req["signature"] as? String, let keyId = req["key_id"] as? String,
              let sig = Data(base64Encoded: sigB64) else { throw Refusal(code: "signed-shape") }
        let signed: Data, msg: [String: Any]
        if let text = req["message"] as? String {
            signed = Data(text.utf8)
            guard let m = try? JSONSerialization.jsonObject(with: signed) as? [String: Any] else { throw Refusal(code: "signed-shape") }
            msg = m
            // 1.2 messages must carry issued_at: a decision is only good close to when it was made.
            guard let issued = msg["issued_at"] as? Int else { throw Refusal(code: "message-issued-at") }
            try require(abs(Int(now()) - issued) <= 600, "message-clock-skew")
        } else if let m = req["message"] as? [String: Any] {
            msg = m; signed = try canonical(m)
        } else { throw Refusal(code: "signed-shape") }
        guard let key = policy.enrolledKeys.first(where: { $0["id"] == keyId && $0["biometric"] == "true" }), let spki = key["p256_spki_b64"].flatMap({ Data(base64Encoded: $0) }),
              let pub = try? P256.Signing.PublicKey(derRepresentation: spki) else { throw Refusal(code: "key-not-enrolled") }
        guard let s = try? P256.Signing.ECDSASignature(derRepresentation: sig), pub.isValidSignature(s, for: signed) else { throw Refusal(code: "bad-signature") }
        try require(msg["v"] as? Int == 1 && msg["host"] as? String == policy.host, "message-host")
        guard let id = msg["request_id"] as? String, let r = StagedRequest.load(id) else { throw Refusal(code: "no-such-request") }
        try require(r.state == "pending", "request-not-pending")
        try require(msg["fp"] as? String == r.fp && msg["nonce"] as? String == r.nonce && msg["tier"] as? Int == r.tier, "message-binding")
        try require((msg["expires_at"] as? Int ?? 0) >= Int(now()) && Int(r.expiresAt) == msg["expires_at"] as? Int, "message-expired")
        let decision = msg["decision"] as? String ?? ""
        // The device rendered the node-signed payload (script included) before signing: that is the show.
        if r.shownAt == nil {
            var rr = r; rr.shownAt = now(); try rr.save()
            Receipts.append("shown", ["request_id": r.id, "fp": r.fp, "by": "key:" + keyId])
        }
        return try decide(id, decision: decision, by: "key:" + keyId, policy: policy)
    }

    // MARK: relay loop (publish staged requests, pull signed decisions, mirror receipts)

    func relayLoop() {
        while true {
            let busy = relayTick()
            sleep(busy ? 5 : 20)
        }
    }

    func loadRelayState() -> [String: Int] {
        guard let d = readFile(SIGNAL_STATE), let o = try? JSONSerialization.jsonObject(with: d) as? [String: Int] else { return [:] }
        return o
    }

    /// One pass. Returns true while anything is pending (poll fast), false otherwise.
    func relayTick() -> Bool {
        guard let relay = Relay.load(nodeKey) else { return false }
        STATE_LOCK.lock()
        let live = StagedRequest.all().filter { $0.state == "pending" && $0.expiresAt > now() }
        let unpublished = live.filter { !FileManager.default.fileExists(atPath: $0.dir + "/published") }
        var st = loadRelayState()
        STATE_LOCK.unlock()

        for r in unpublished {
            guard let payload = try? canonical(r.signalPayload(host: host)), let sig = try? nodeKey!.signature(for: payload),
                  let body = try? canonical(["payload": String(data: payload, encoding: .utf8)!, "signature": sig.derRepresentation.base64EncodedString()])
            else { continue }
            let res = relay.call("POST", "/v1/requests", body)
            // 2xx = stored; 4xx other than auth/rate = the relay will never take it, stop retrying (receipt says why).
            if (200..<300).contains(res.status) || ((400..<500).contains(res.status) && ![401, 429].contains(res.status)) {
                STATE_LOCK.lock()
                try? writePrivate(r.dir + "/published", Data("\(res.status)".utf8))
                Receipts.append(res.status < 300 ? "published" : "publish-refused",
                                ["request_id": r.id, "fp": r.fp, "status": res.status, "error": res.json?["error"] as? String ?? ""])
                STATE_LOCK.unlock()
            }
        }

        if !live.isEmpty {
            let after = st["decision_after"] ?? 0
            let res = relay.call("GET", "/v1/decisions?after=\(after)")
            for d in (res.json?["decisions"] as? [[String: Any]]) ?? [] {
                guard let seq = d["seq"] as? Int else { continue }
                STATE_LOCK.lock()
                let out = handle(["op": "approve_signed", "message": d["message"] ?? "", "signature": d["signature"] ?? "",
                                  "key_id": d["key_id"] ?? ""], uid: -2, locked: true)
                st["decision_after"] = max(st["decision_after"] ?? 0, seq)
                try? writePrivate(SIGNAL_STATE, try canonical(st))
                STATE_LOCK.unlock()
                stderr("relay decision seq \(seq): " + ((try? String(data: canonical(out), encoding: .utf8) ?? "") ?? ""))
            }
        }

        // Mirror the receipt chain (append-only at the relay, linkage enforced there).
        STATE_LOCK.lock()
        let mirrored = st["receipts_mirrored"] ?? 0
        var batch: [[String: Any]] = []
        if Receipts.last().seq > mirrored, let d = readFile(Receipts.path), let text = String(data: d, encoding: .utf8) {
            for line in text.split(separator: "\n") {
                guard let o = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any], let seq = o["seq"] as? Int else { continue }
                if seq > mirrored { batch.append(o) }
                if batch.count >= 200 { break }
            }
        }
        STATE_LOCK.unlock()
        if !batch.isEmpty, let body = try? canonical(["entries": batch]) {
            let res = relay.call("POST", "/v1/receipts", body)
            if (200..<300).contains(res.status) {
                let head = ((res.json?["head"] as? [String: Any])?["seq"] as? Int) ?? mirrored
                STATE_LOCK.lock(); st = loadRelayState(); st["receipts_mirrored"] = max(mirrored, head)
                try? writePrivate(SIGNAL_STATE, try canonical(st)); STATE_LOCK.unlock()
            } else if res.status != 0 {
                stderr("receipt mirror refused: \(res.status) \(res.json?["error"] as? String ?? "")")
            }
        }
        return !live.isEmpty
    }

    func handle(_ req: [String: Any], uid: Int, locked: Bool = false) -> [String: Any] {
        if !locked { STATE_LOCK.lock() }
        defer { if !locked { STATE_LOCK.unlock() } }
        do {
            let op = req["op"] as? String ?? ""
            switch op {
            case "stage": return try stage(req, uid: uid)
            case "show": return try show(req["request_id"] as? String, uid: uid)
            case "list":
                return ["ok": true, "pending": StagedRequest.all().filter { $0.state == "pending" }.map { ["id": $0.id, "fp": String($0.fp.prefix(16)), "tier": $0.tier, "description": $0.description, "expires_at": Int($0.expiresAt)] }]
            case "status":
                let p = try? Policy.load()
                return ["ok": true, "host": host, "integrity": integrity.ok, "integrity_reason": integrity.reason, "policy_hash": p?.hash ?? "",
                        "paused": p?.paused ?? true, "receipts": Receipts.last().seq, "pending": StagedRequest.all().filter { $0.state == "pending" }.count, "version": VERSION,
                        "node_spki_b64": nodeSpki, "relay": Relay.load(nodeKey).map { $0.base } ?? "", "relay_state": loadRelayState(),
                        "enrolled_keys": (p?.enrolledKeys ?? []).compactMap { $0["id"] }]
            case "approve", "deny":
                let policy = try Policy.load()
                try require(policy.approverUids.contains(uid), "caller-is-not-an-approver")
                var id = req["request_id"] as? String ?? ""
                if id.isEmpty {
                    // "approve" with no id: only the single pending request the approver was shown in the last
                    // 300 s, and only if nothing else was staged since. Anything ambiguous is refused.
                    let live = StagedRequest.all().filter { $0.state == "pending" && $0.expiresAt > now() }
                    try require(live.count == 1, live.isEmpty ? "nothing-pending" : "more-than-one-pending-name-the-id")
                    let r = live[0]
                    try require(r.shownAt.map { now() - $0 <= 300 } ?? false, "show-it-first-then-decide-within-5-min")
                    id = r.id
                }
                return try decide(id, decision: op, by: "uid:\(uid)", policy: policy)
            case "enroll_key":
                return try stageEnroll(req, uid: uid)
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
        signal(SIGPIPE, SIG_IGN)  // H9: a client hanging up mid-reply must not kill the daemon
        Receipts.append("started", ["integrity": integrity.ok, "reason": integrity.reason, "host": host, "node_key": nodeKey != nil])
        STATE_LOCK.lock(); reconcileOrphans(); gc(); STATE_LOCK.unlock()
        Thread.detachNewThread { [self] in self.relayLoop() }
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
            var tv = timeval(tv_sec: 10, tv_usec: 0)
            setsockopt(c, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
            setsockopt(c, SOL_SOCKET, SO_SNDTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
            var one: Int32 = 1
            setsockopt(c, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
            var cred = xucred(); var clen = socklen_t(MemoryLayout<xucred>.size)
            let uid: Int = getsockopt(c, 0 /* SOL_LOCAL */, 0x001 /* LOCAL_PEERCRED */, &cred, &clen) == 0 ? Int(cred.cr_uid) : -1
            var data = Data(); var buf = [UInt8](repeating: 0, count: 65536)
            while data.count < 34 << 20 {
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

/// The host name as the daemon reports it (policy.json is root-only, the approver account cannot read it).
func daemonHost() -> String { client(["op": "status"])["host"] as? String ?? "this Mac" }

/// One plain line a phone can read at a glance, for approve/deny replies.
func decisionSummary(_ r: [String: Any], op: String, id: String) -> String {
    let host = daemonHost()
    if let code = r["refused"] as? String { return "REFUSED on \(host): \(code) (\(op) \(id))" }
    if let d = r["denied"] as? String { return "DENIED on \(host): request \(d) will not run" }
    let rid = r["executed"] as? String ?? id
    let exit = r["exit_code"] as? Int ?? -1
    if (r["timed_out"] as? Bool) == true { return "TIMED OUT on \(host): request \(rid) was killed (exit \(exit))" }
    return exit == 0 ? "APPROVED and ran on \(host): request \(rid), exit 0" : "RAN WITH ERROR on \(host): request \(rid), exit \(exit)"
}

/// Pending requests as short lines (the phone's `list`).
func pendingLines(_ r: [String: Any]) -> String {
    guard let p = r["pending"] as? [[String: Any]] else { return decisionSummary(r, op: "list", id: "") }
    let live = p.filter { ($0["expires_at"] as? Int ?? 0) > Int(now()) }
    if live.isEmpty { return "Nothing waiting on \(daemonHost())." }
    return live.map { e in
        let mins = max(0, ((e["expires_at"] as? Int ?? 0) - Int(now())) / 60)
        return "\(e["id"] as? String ?? "?")  fp \(e["fp"] as? String ?? "?")  tier \(e["tier"] as? Int ?? 3)  \(mins) min left\n  \(e["description"] as? String ?? "")"
    }.joined(separator: "\n")
}

func cli(_ args: [String]) -> Int32 {
    guard let cmd = args.first else {
        print("fleet-authority daemon | stage <description> [--template name --args a b] (script on stdin) | show [id|fp] | list | status | approve <id|fp> | deny <id|fp> | approver-shell | node-key | (root) keys-add <id> <spki-b64> [label] | keys-revoke <id> | relay-config <url> <node-id>"); return 64
    }
    switch cmd {
    case "daemon":
        guard getuid() == 0 || TEST_ROOT != nil else { fail("daemon must run as root") }
        Daemon().serve()
    case "stage":
        var req: [String: Any] = ["op": "stage", "description": args.dropFirst().first ?? ""]
        var rest = Array(args.dropFirst(2))
        while !rest.isEmpty {
            let f = rest.removeFirst()
            if f == "--template" { req["template"] = rest.isEmpty ? "" : rest.removeFirst() }
            else if f == "--args" { req["args"] = rest; rest = [] }
            else if f == "--timeout" { req["timeout_s"] = Int(rest.isEmpty ? "" : rest.removeFirst()) ?? 600 }
            else if f == "--attach", !rest.isEmpty {
                let spec = rest.removeFirst()
                guard let eq = spec.firstIndex(of: "="), let d = readFile(String(spec[spec.index(after: eq)...])) else { fail("--attach name=path (readable file)") }
                var a = req["attachments"] as? [String: String] ?? [:]
                a[String(spec[..<eq])] = d.base64EncodedString(); req["attachments"] = a
            }
        }
        if req["template"] == nil { req["script"] = String(data: FileHandle.standardInput.readDataToEndOfFile(), encoding: .utf8) ?? "" }
        let r = client(req); printJSON(r); return (r["ok"] as? Bool) == true ? 0 : 1
    case "show":
        let r = client(["op": "show", "request_id": args.count > 1 ? args[1] : NSNull()])
        if let t = r["text"] as? String { print(t) } else { printJSON(r) }
        return 0
    case "list":
        let r = client(["op": "list"])
        if args.contains("--json") { printJSON(r) } else { print(pendingLines(r)) }
        return 0
    case "status":
        printJSON(client(["op": cmd])); return 0
    case "approve", "deny":
        let id = args.count > 1 ? args[1] : ""
        let r = client(["op": cmd, "request_id": id])
        print(decisionSummary(r, op: cmd, id: id.isEmpty ? "the request you were shown" : id))
        if let tail = r["output_tail"] as? String, !tail.isEmpty { print("---- output (last part) ----\n" + String(tail.suffix(1500))) }
        return (r["ok"] as? Bool) == true ? 0 : 1
    case "enroll-key":
        // Typed op (review C4): the daemon writes the script and shows its own SHA256 fingerprint.
        guard args.count >= 3 else { print("enroll-key <key-id> <p256-spki-base64> --biometric"); return 64 }
        let r = client(["op": "enroll_key", "key_id": args[1], "p256_spki_b64": args[2], "biometric": args.contains("--biometric")])
        printJSON(r); return (r["ok"] as? Bool) == true ? 0 : 1
    case "node-key":
        // Public half only; anyone may read it (it is enrolled at the relay and pinned by the phone).
        let r = client(["op": "status"])
        print(r["node_spki_b64"] as? String ?? ""); return (r["node_spki_b64"] as? String ?? "").isEmpty ? 1 : 0
    case "keys-add", "keys-revoke", "relay-config":
        // Root only, and meant to run inside an approved staged script (stage it; the phone approves it).
        // keys.json and signal.json sit outside the policy hash, so pending requests survive these changes.
        guard getuid() == 0 || TEST_ROOT != nil else { fail("\(cmd) must run as root (stage it for approval)") }
        do {
            if cmd == "relay-config" {
                guard args.count == 3, args[1].hasPrefix("https://") || TEST_ROOT != nil,
                      args[2].range(of: "^[A-Za-z0-9._-]{1,64}$", options: .regularExpression) != nil else { fail("relay-config <https-url> <node-id>") }
                try writePrivate(SIGNAL_CONF, try canonical(["url": args[1], "node_id": args[2]]), mode: 0o644)
                Receipts.append("relay-configured", ["url": args[1], "node_id": args[2], "by_uid": Int(getuid())])
                print("relay \(args[1]) as node \(args[2])"); return 0
            }
            guard args.count >= 2, args[1].range(of: "^[A-Za-z0-9._-]{1,64}$", options: .regularExpression) != nil else { fail("\(cmd) <key-id> ...") }
            var keys = KeyStore.load()
            if cmd == "keys-add" {
                guard args.count >= 3, let spki = Data(base64Encoded: args[2]), (try? P256.Signing.PublicKey(derRepresentation: spki)) != nil else { fail("keys-add <key-id> <p256-spki-base64> [label]") }
                guard !keys.contains(where: { $0["id"] == args[1] }) else { fail("key id \(args[1]) already exists (revoke it and add a new id)") }
                let rest = Array(args.dropFirst(3))
                keys.append(["id": args[1], "p256_spki_b64": args[2], "label": rest.filter { $0 != "--biometric" }.joined(separator: " "),
                             "biometric": rest.contains("--biometric") ? "true" : "false",
                             "added_at": nowISO(), "spki_sha256": sha256Hex(spki)])
                try KeyStore.save(keys)
                Receipts.append("key-enrolled", ["key_id": args[1], "spki_sha256": sha256Hex(spki), "by_uid": Int(getuid())])
            } else {
                guard let i = keys.firstIndex(where: { $0["id"] == args[1] && $0["revoked_at"] == nil }) else { fail("no active key \(args[1])") }
                keys[i]["revoked_at"] = nowISO()
                try KeyStore.save(keys)
                Receipts.append("key-revoked", ["key_id": args[1], "by_uid": Int(getuid())])
            }
            print("\(cmd) \(args[1]) ok; active keys: \(keys.filter { $0["revoked_at"] == nil }.compactMap { $0["id"] })"); return 0
        } catch { fail("\(cmd) failed: \(error)") }
    case "approver-shell":
        // sshd ForceCommand for the approver account: one command from SSH_ORIGINAL_COMMAND.
        // Split on any whitespace: phone shortcuts often leave a trailing newline, which made "show\n" an unknown command (1.1.1 and earlier).
        let words = (ProcessInfo.processInfo.environment["SSH_ORIGINAL_COMMAND"] ?? "show").components(separatedBy: .whitespacesAndNewlines).filter { !$0.isEmpty }
        guard let w = words.first, ["show", "list", "status", "approve", "deny"].contains(w) else { print("allowed: show | list | status | approve [id] | deny [id]"); return 64 }
        return cli(words)
    default:
        print("unknown command \(cmd)"); return 64
    }
}

exit(cli(Array(CommandLine.arguments.dropFirst())))
