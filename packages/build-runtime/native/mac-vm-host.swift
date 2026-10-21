// Source candidate only. No native execution fallback; see VM-HOST-REVIEW.md.
// Owner must build/sign/pin and provision artifacts separately. macOS 13+, arm64.
import Foundation
import Virtualization
import CryptoKit
import Security
import Darwin

private struct Refusal: Error { let id: String }
private func require(_ value: Bool, _ id: String) throws {
    if !value { throw Refusal(id: id) }
}
private func diagnostic(_ id: String) {
    // Only fixed identifiers reach stderr; never print NSError, paths or input.
    let bytes = Array((id + "\n").utf8)
    _ = bytes.withUnsafeBytes { Darwin.write(STDERR_FILENO, $0.baseAddress, $0.count) }
}
private func fail(_ id: String) -> Never { diagnostic(id); exit(2) }

// Continuous time includes host sleep. Values are bounded well below UInt64.max.
private struct Clock {
    let scale: Double
    init() {
        var info = mach_timebase_info_data_t()
        guard mach_timebase_info(&info) == KERN_SUCCESS, info.denom != 0 else { fail("clock-unavailable") }
        scale = Double(info.numer) / Double(info.denom)
    }
    func now() -> UInt64 { UInt64(Double(mach_continuous_time()) * scale) }
}

// Deliberately restricted JSON grammar: flat objects, unescaped printable ASCII
// strings and unsigned decimal integers only. Reject duplicates BEFORE decoding.
// No floats, nesting, escapes, null, booleans, BOM, CR or trailing tokens.
private enum Atom { case text(String), number(UInt64) }
private struct FlatJSON {
    var bytes: [UInt8]; var i = 0
    mutating func whitespace() { while i < bytes.count && (bytes[i] == 32 || bytes[i] == 9) { i += 1 } }
    mutating func take(_ byte: UInt8) throws {
        whitespace(); try require(i < bytes.count && bytes[i] == byte, "invalid-json"); i += 1
    }
    mutating func string() throws -> String {
        try take(34); let start = i
        while i < bytes.count && bytes[i] != 34 {
            try require(bytes[i] >= 32 && bytes[i] <= 126 && bytes[i] != 92, "invalid-json-string")
            i += 1
        }
        try require(i < bytes.count && i - start <= 512, "invalid-json-string")
        let value = String(decoding: bytes[start..<i], as: UTF8.self); i += 1; return value
    }
    mutating func object() throws -> [String: Atom] {
        try require(!bytes.isEmpty && bytes.count <= 8192, "json-size")
        try take(123); whitespace(); var result: [String: Atom] = [:]
        while i < bytes.count && bytes[i] != 125 {
            let key = try string()
            try require(result[key] == nil && result.count < 19, "json-keys")
            try take(58); whitespace()
            if i < bytes.count && bytes[i] == 34 { result[key] = .text(try string()) }
            else {
                let start = i
                while i < bytes.count && bytes[i] >= 48 && bytes[i] <= 57 { i += 1 }
                try require(i > start && i - start <= 16 && (i - start == 1 || bytes[start] != 48), "json-integer")
                guard let value = UInt64(String(decoding: bytes[start..<i], as: UTF8.self)) else { throw Refusal(id: "json-integer") }
                result[key] = .number(value)
            }
            whitespace()
            if i < bytes.count && bytes[i] == 44 {
                i += 1; whitespace(); try require(i < bytes.count && bytes[i] != 125, "invalid-json")
            } else { break }
        }
        try take(125); whitespace(); try require(i == bytes.count, "invalid-json"); return result
    }
}
private func text(_ o: [String: Atom], _ key: String) throws -> String {
    guard case let .text(value)? = o[key] else { throw Refusal(id: "config-string") }; return value
}
private func number(_ o: [String: Atom], _ key: String) throws -> UInt64 {
    guard case let .number(value)? = o[key] else { throw Refusal(id: "config-number") }; return value
}
private func token(_ s: String) -> Bool {
    !s.isEmpty && s != "." && s != ".." && s.utf8.count <= 128 && s.utf8.allSatisfy {
        ($0 >= 48 && $0 <= 57) || ($0 >= 65 && $0 <= 90) || ($0 >= 97 && $0 <= 122) || $0 == 45 || $0 == 95 || $0 == 46
    }
}
private func hexDigest(_ s: String) -> Bool {
    s.utf8.count == 64 && s.utf8.allSatisfy { ($0 >= 48 && $0 <= 57) || ($0 >= 97 && $0 <= 102) }
}
private struct Config {
    let attemptId: String, profileHash: String, jobId: String, identity: String, guestJobSha256: String, bootSha256: String
    let uid: uid_t, cpu: Int, memory: UInt64, bootLimit: UInt64, outputLimit: UInt64, runSeconds: UInt64
    let boot: String, output: String, aux: String, hardware: String, machine: String, input: String
    init(_ o: [String: Atom]) throws {
        try require(Set(o.keys) == Set(["bootSha256", "version", "attemptId", "profileHash", "jobId", "identity", "guestJobSha256", "helperUID", "cpuCount", "memoryBytes", "maxBootBytes", "maxOutputBytes", "maxRunSeconds", "bootDisk", "outputDisk", "auxiliaryStorage", "hardwareModel", "machineIdentifier", "inputDirectory"]), "config-keys")
        try require(number(o, "version") == 2, "config-version")
        attemptId = try text(o, "attemptId"); profileHash = try text(o, "profileHash"); jobId = try text(o, "jobId")
        try require(token(attemptId) && token(jobId), "config-identity")
        try require(hexDigest(profileHash), "config-profile")
        guestJobSha256 = try text(o, "guestJobSha256"); try require(hexDigest(guestJobSha256), "config-guest-job-digest")
        bootSha256 = try text(o, "bootSha256"); try require(hexDigest(bootSha256), "config-boot-digest")
        // ASCII tokens make these exact bytes identical to JSON.stringify; order is contractual.
        let binding = Data("[\"\(jobId)\",\"\(attemptId)\",\"\(profileHash)\"]".utf8)
        let expected = "vm:" + SHA256.hash(data: binding).map { String(format: "%02x", $0) }.joined()
        identity = try text(o, "identity"); try require(identity == expected, "config-binding")
        let user = try number(o, "helperUID")
        try require(user >= 501 && user <= UInt64(UInt32.max) && getuid() == user && geteuid() == user && getgid() != 0 && getegid() != 0, "dedicated-uid-required")
        uid = uid_t(user)
        let cpus = try number(o, "cpuCount"); try require(cpus >= 1 && cpus <= 64, "cpu-bound"); cpu = Int(cpus)
        memory = try number(o, "memoryBytes"); try require(memory >= 2 * 1024 * 1024 * 1024 && memory <= 64 * 1024 * 1024 * 1024 && memory % (1024 * 1024) == 0, "memory-bound")
        bootLimit = try number(o, "maxBootBytes"); outputLimit = try number(o, "maxOutputBytes")
        try require(bootLimit >= 1024 * 1024 && bootLimit <= 128 * 1024 * 1024 * 1024 && bootLimit % 512 == 0, "boot-bound")
        try require(outputLimit >= 1024 * 1024 && outputLimit <= 8 * 1024 * 1024 * 1024 && outputLimit % 512 == 0, "output-bound")
        runSeconds = try number(o, "maxRunSeconds"); try require(runSeconds >= 1 && runSeconds <= 3600, "duration-bound")
        let base = "/Library/Foundry/VM/attempts/" + attemptId
        boot = try text(o, "bootDisk"); output = try text(o, "outputDisk"); aux = try text(o, "auxiliaryStorage")
        hardware = try text(o, "hardwareModel"); machine = try text(o, "machineIdentifier"); input = try text(o, "inputDirectory")
        try require(boot == base + "/boot.raw" && output == base + "/outputs.raw" && aux == base + "/auxiliary.bin" && hardware == base + "/hardware-model.bin" && machine == base + "/machine-identifier.bin" && input == base + "/input", "fixed-paths-required")
    }
}

// Reject extended ACL entries, including ones which mode bits would miss. An
// unsupported ACL query is a refusal, not permission to assume secure ancestry.
private func noACL(_ fd: Int32) throws {
    // acl_get_fd_np(NULL) cannot distinguish absence from failure; acl_to_text
    // can omit entries on allocation failure. Neither is evidence of an empty ACL.
    guard let security = filesec_init() else { throw Refusal(id: "acl-unavailable") }
    defer { filesec_free(security) }
    var observed = stat(); var present: Int32 = 0
    try require(fstatx_np(fd, &observed, security) == 0 &&
                filesec_query_property(security, FILESEC_ACL, &present) == 0, "acl-unavailable")
    if present == 0 { return }
    var obtained: acl_t? = nil
    try require(filesec_get_property(security, FILESEC_ACL, &obtained) == 0, "acl-unavailable")
    // Darwin _FILESEC_REMOVE_ACL is the sentinel pointer (void *)1, not an ACL.
    guard let acl = obtained, UInt(bitPattern: acl) > 1 else { throw Refusal(id: "acl-unavailable") }
    var entry: acl_entry_t? = nil
    errno = 0
    let result = acl_get_entry(acl, Int32(ACL_FIRST_ENTRY.rawValue), &entry)
    let entryErrno = errno // Capture BEFORE acl_free/filesec_free can change it.
    let freed = acl_free(UnsafeMutableRawPointer(acl))
    // Darwin: 0 means an entry exists; -1/EINVAL is the empty/out-of-range case.
    try require(freed == 0 && result == -1 && entryErrno == EINVAL, "acl-entries-or-error")
}
private func localVolume(_ fd: Int32) throws {
    var volume = statfs()
    try require(fstatfs(fd, &volume) == 0 && volume.f_owner == 0 &&
                (volume.f_flags & UInt32(MNT_LOCAL)) != 0, "root-local-volume-required")
}
private func readonlyVolume(_ fd: Int32) throws {
    var volume = statfs()
    try require(fstatfs(fd, &volume) == 0 && volume.f_owner == 0 &&
        (volume.f_flags & UInt32(MNT_LOCAL | MNT_RDONLY)) == UInt32(MNT_LOCAL | MNT_RDONLY), "input-readonly-volume-required")
}
private func statFD(_ fd: Int32) throws -> stat {
    var s = stat(); try require(fstat(fd, &s) == 0, "fstat-failed"); return s
}
private func isType(_ s: stat, _ kind: mode_t) -> Bool { (s.st_mode & mode_t(S_IFMT)) == kind }
private func sameFile(_ a: stat, _ b: stat) -> Bool {
    a.st_dev == b.st_dev && a.st_ino == b.st_ino && a.st_uid == b.st_uid && a.st_gid == b.st_gid &&
    a.st_mode == b.st_mode && a.st_nlink == b.st_nlink && a.st_size == b.st_size && a.st_flags == b.st_flags &&
    a.st_mtimespec.tv_sec == b.st_mtimespec.tv_sec && a.st_mtimespec.tv_nsec == b.st_mtimespec.tv_nsec &&
    a.st_ctimespec.tv_sec == b.st_ctimespec.tv_sec && a.st_ctimespec.tv_nsec == b.st_ctimespec.tv_nsec
}
private final class Pin {
    let fd: Int32, path: String, initial: stat
    init(_ fd: Int32, _ path: String) throws { self.fd = fd; self.path = path; initial = try statFD(fd) }
    deinit { close(fd) }
    func recheck() throws {
        let held = try statFD(fd)
        var s = stat(); try require(lstat(path, &s) == 0 && sameFile(initial, s) && sameFile(initial, held), "artifact-changed")
        try noACL(fd)
    }
    func readSmall() throws -> Data {
        try require(initial.st_size > 0 && initial.st_size <= 4096, "metadata-bound")
        var bytes = [UInt8](repeating: 0, count: Int(initial.st_size))
        let count = bytes.withUnsafeMutableBytes { pread(fd, $0.baseAddress, $0.count, 0) }
        try require(count == bytes.count, "metadata-read"); try recheck(); return Data(bytes)
    }
    func sha256(maximum: Int) throws -> String {
        try recheck()
        try require(initial.st_size > 0 && initial.st_size <= maximum, "guest-job-bound")
        var hash = SHA256(); var offset: off_t = 0
        var buffer = [UInt8](repeating: 0, count: 65536)
        while offset < initial.st_size {
            let wanted = min(buffer.count, Int(initial.st_size - offset))
            let n = buffer.withUnsafeMutableBytes { pread(fd, $0.baseAddress, wanted, offset) }
            if n < 0 && errno == EINTR { continue }
            try require(n > 0 && n <= wanted, "guest-job-read")
            hash.update(data: Data(buffer.prefix(n))); offset += off_t(n)
        }
        try recheck()
        return hash.finalize().map { String(format: "%02x", $0) }.joined()
    }
}
private final class Artifacts {
    var pins: [Pin] = []
    let boot: Pin, output: Pin, aux: Pin, input: Pin, job: Pin
    let guestJobSha256: String
    let hardwareData: Data, machineData: Data
    init(_ c: Config) throws {
        func directory(_ path: String) throws -> Pin {
            // Walk from / with openat: no symlink resolution at ANY component.
            var fd = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            try require(fd >= 0, "root-open")
            do {
                for part in ([String("")] + path.split(separator: "/").map(String.init)) {
                    if !part.isEmpty {
                        let next = openat(fd, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
                        try require(next >= 0, "ancestor-open"); close(fd); fd = next
                    }
                    let s = try statFD(fd)
                    try require(isType(s, mode_t(S_IFDIR)) && s.st_uid == 0 && (s.st_mode & 0o022) == 0, "root-ancestry-required")
                    try noACL(fd)
                    try localVolume(fd)
                    // Root can mutate these; the owner must keep this hierarchy sealed for the attempt.
                }
                return try Pin(fd, path)
            } catch { close(fd); throw error }
        }
        func file(_ parent: Pin, _ name: String, writable: Bool, limit: UInt64) throws -> Pin {
            let fd = openat(parent.fd, name, (writable ? O_RDWR : O_RDONLY) | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
            try require(fd >= 0, "artifact-open")
            do {
                let s = try statFD(fd)
                try require(isType(s, mode_t(S_IFREG)) && s.st_nlink == 1 && s.st_uid == (writable ? c.uid : 0) && (s.st_mode & 0o7777) == (writable ? 0o600 : 0o444) && s.st_size > 0 && UInt64(s.st_size) <= limit, "artifact-policy")
                try noACL(fd)
                try localVolume(fd)
                try require(s.st_dev == parent.initial.st_dev, "artifact-device")
                try require(flock(fd, (writable ? LOCK_EX : LOCK_SH) | LOCK_NB) == 0, "artifact-in-use")
                return try Pin(fd, parent.path + "/" + name)
            } catch { close(fd); throw error }
        }
        let root = try directory("/Library/Foundry/VM/attempts/" + c.attemptId)
        boot = try file(root, "boot.raw", writable: true, limit: c.bootLimit)
        output = try file(root, "outputs.raw", writable: true, limit: c.outputLimit)
        // VZMacAuxiliaryStorage for a real macOS 27 guest is ~32 MiB (r2: 33,579,164 B);
        // 64 MiB bounds it without refusing every actual image.
        aux = try file(root, "auxiliary.bin", writable: true, limit: 64 * 1024 * 1024)
        let hardware = try file(root, "hardware-model.bin", writable: false, limit: 4096)
        let machine = try file(root, "machine-identifier.bin", writable: false, limit: 4096)
        input = try directory(c.input)
        // Input is now its own owner-mounted readonly image. It deliberately
        // differs from the mutable boot/output filesystem; every child remains
        // on this pinned input device and the TS guard holds its mount identity.
        try readonlyVolume(input.fd)
        // Descriptor-relative open, retained until actual VM stop. No pathname
        // reopen or caller callback may substitute the approved guest job bytes.
        job = try file(input, "job.json", writable: false, limit: 262144)
        guestJobSha256 = c.guestJobSha256
        // Require fully allocated raw files, not truncate-created sparse images.
        for disk in [boot, output] {
            let s = disk.initial
            try require(s.st_size % 512 == 0 && s.st_blocks >= (s.st_size + 511) / 512 && (s.st_flags & UInt32(UF_COMPRESSED)) == 0, "disk-allocation-required")
            try require(lseek(disk.fd, 0, SEEK_HOLE) == s.st_size, "sparse-disk-forbidden")
        }
        hardwareData = try hardware.readSmall(); machineData = try machine.readSmall()
        pins = [root, boot, output, aux, hardware, machine, input, job]
        var count = 0; var bytes: UInt64 = 0
        func sealedInput(_ fd: Int32, depth: Int) throws {
            try require(depth <= 32, "input-depth")
            let s = try statFD(fd)
            try require(isType(s, mode_t(S_IFDIR)) && s.st_uid == 0 && (s.st_mode & 0o7777) == 0o555 && s.st_dev == input.initial.st_dev, "input-directory-policy")
            try noACL(fd)
            let duplicate = dup(fd); try require(duplicate >= 0, "input-dup")
            guard let dir = fdopendir(duplicate) else { close(duplicate); throw Refusal(id: "input-enumerate") }
            defer { closedir(dir) }
            while true {
                errno = 0
                guard let entry = readdir(dir) else { try require(errno == 0, "input-enumerate"); break }
                let nameCapacity = Int(entry.pointee.d_namlen) + 1
                let name = withUnsafePointer(to: &entry.pointee.d_name) {
                    $0.withMemoryRebound(to: CChar.self, capacity: nameCapacity) { String(validatingUTF8: $0) }
                }
                guard let name = name else { throw Refusal(id: "input-name") }
                if name == "." || name == ".." { continue }
                count += 1; try require(count <= 65536, "input-entry-bound")
                let child = openat(fd, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
                try require(child >= 0, "input-child-open")
                do {
                    let item = try statFD(child)
                    try require(item.st_uid == 0 && item.st_dev == input.initial.st_dev, "input-owner-device")
                    if isType(item, mode_t(S_IFDIR)) { try sealedInput(child, depth: depth + 1) }
                    else {
                        try require(isType(item, mode_t(S_IFREG)) && item.st_nlink == 1 && (item.st_mode & 0o7777) == 0o444 && item.st_size >= 0, "input-file-policy")
                        try noACL(child); bytes += UInt64(item.st_size); try require(bytes <= 2 * 1024 * 1024 * 1024, "input-byte-bound")
                    }
                    close(child)
                } catch { close(child); throw error }
            }
        }
        try require(boot.sha256(maximum: Int(c.bootLimit)) == c.bootSha256, "boot-image-digest-mismatch")
        try sealedInput(input.fd, depth: 0)
        try recheck()
        try verifyGuestJob()
    }
    func recheck() throws {
        for pin in pins { try pin.recheck() }
        try readonlyVolume(input.fd)
    }
    func verifyGuestJob() throws {
        try require(job.sha256(maximum: 262144) == guestJobSha256, "guest-job-digest-mismatch")
    }
    // Virtualization.framework takes its OWN exclusive flock on every writable
    // disk and on the auxiliary storage when the VM starts, and refuses to start
    // ("storage device attachment is invalid", "Failed to lock auxiliary
    // storage") while another open file description holds one. Hand the
    // exclusion over: release ours immediately before vm.start, and after a
    // successful start prove VZ now holds each lock (our non-blocking exclusive
    // request must be refused). Descriptors stay open and pinned throughout.
    func releaseWritableLocks() {
        for pin in [boot, output, aux] { _ = flock(pin.fd, LOCK_UN) }
    }
    func virtualizationHoldsWritableLocks() -> Bool {
        for pin in [boot, output, aux] {
            if flock(pin.fd, LOCK_EX | LOCK_NB) == 0 { _ = flock(pin.fd, LOCK_UN); return false }
            if errno != EWOULDBLOCK { return false }
        }
        return true
    }
}

#if arch(arm64)
@available(macOS 13.0, *)
private final class Host: NSObject, VZVirtualMachineDelegate {
    let clock = Clock()
    private var config: Config?, artifacts: Artifacts?, vm: VZVirtualMachine?
    private var watchdog: DispatchSourceTimer?, signals: [DispatchSourceSignal] = []
    private let inputQueue = DispatchQueue(label: "foundry.vm.stdin", qos: .userInitiated)
    private let artifactQueue = DispatchQueue(label: "foundry.vm.artifacts", qos: .userInitiated)
    private var terminal = false, startIssued = false, startPending = false, stopPending = false
    private var admissionPending = false
    private var stopFailed = false, fault = false, emittedStopped = false
    private var generation: UInt64 = 0, outstanding: String?, challengeCreated: UInt64 = 0
    private var nextChallenge: UInt64 = 0, challengeDeadline: UInt64 = 0
    private var permitExpires: UInt64 = 0, runDeadline: UInt64 = 0
    private var configDeadline: UInt64 = 0

    func run() {
        dispatchPrecondition(condition: .onQueue(.main))
        configDeadline = clock.now() + 300_000_000_000
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now(), repeating: .milliseconds(10), leeway: .milliseconds(1))
        timer.setEventHandler { [self] in tick() }; timer.resume(); watchdog = timer
        for sig in [SIGTERM, SIGINT, SIGHUP] {
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            source.setEventHandler { [self] in end("signal-stop", failed: true) }; source.resume(); signals.append(source)
        }
        inputQueue.async { [self] in readInput() }
    }
    private func output(_ fields: [String: Any]) -> Bool {
        guard let c = config else { return false }
        var row = fields; row["identity"] = c.identity
        guard var data = try? JSONSerialization.data(withJSONObject: row, options: [.sortedKeys]), data.count < 2048 else { return false }
        data.append(10)
        // Nonblocking, bounded write; pipe writes fit PIPE_BUF. A socket short
        // write or EAGAIN poisons the protocol and stops; never queue retries.
        let n = data.withUnsafeBytes { Darwin.write(STDOUT_FILENO, $0.baseAddress, $0.count) }
        return n == data.count
    }
    private func readInput() {
        var line: [UInt8] = []; var buffer = [UInt8](repeating: 0, count: 4096)
        var configured = false
        while true {
            let n = buffer.withUnsafeMutableBytes { Darwin.read(STDIN_FILENO, $0.baseAddress, $0.count) }
            if n < 0 && errno == EINTR { continue }
            if n <= 0 {
                DispatchQueue.main.sync {
                    // The parent closes stdin after STOP. It cannot renew or
                    // reopen admission, and must not poison a clean stop.
                    if !terminal { end(n == 0 ? "channel-eof" : "channel-read", failed: true) }
                }; return
            }
            for byte in buffer.prefix(n) {
                if byte != 10 {
                    line.append(byte)
                    if line.count > (configured ? 2048 : 8192) {
                        DispatchQueue.main.sync { end("channel-line-bound", failed: true) }; return
                    }
                    continue
                }
                do {
                    var parser = FlatJSON(bytes: line); let object = try parser.object(); line.removeAll(keepingCapacity: true)
                    if !configured {
                        let c = try Config(object)
                        // Bounded filesystem traversal/metadata reads stay OFF the VZ/main queue.
                        let a = try Artifacts(c)
                        DispatchQueue.main.sync { configure(c, a) }; configured = true
                    } else { DispatchQueue.main.sync { control(object) } }
                } catch {
                    let id = (error as? Refusal)?.id ?? "source-validation-failed"
                    DispatchQueue.main.sync { end(id, failed: true) }; return
                }
            }
        }
    }
    private func configure(_ c: Config, _ a: Artifacts) {
        guard !terminal else { return }
        config = c; artifacts = a
        do {
            try require(clock.now() < configDeadline, "config-deadline")
            try require(VZVirtualMachine.isSupported, "virtualization-unsupported")
            guard let hardware = VZMacHardwareModel(dataRepresentation: a.hardwareData), hardware.isSupported,
                  let machine = VZMacMachineIdentifier(dataRepresentation: a.machineData) else { throw Refusal(id: "platform-unsupported") }
            let platform = VZMacPlatformConfiguration()
            platform.hardwareModel = hardware; platform.machineIdentifier = machine
            platform.auxiliaryStorage = VZMacAuxiliaryStorage(contentsOf: URL(fileURLWithPath: c.aux))
            let v = VZVirtualMachineConfiguration()
            v.bootLoader = VZMacOSBootLoader(); v.platform = platform
            v.cpuCount = c.cpu; v.memorySize = c.memory
            // Exactly two owner-provisioned raw disks. No image creation or install path.
            v.storageDevices = try [c.boot, c.output].map {
                VZVirtioBlockDeviceConfiguration(attachment: try VZDiskImageStorageDeviceAttachment(url: URL(fileURLWithPath: $0), readOnly: false))
            }
            let input = VZVirtioFileSystemDeviceConfiguration(tag: VZVirtioFileSystemDeviceConfiguration.macOSGuestAutomountTag)
            input.share = VZSingleDirectoryShare(directory: VZSharedDirectory(url: URL(fileURLWithPath: c.input), readOnly: true))
            v.directorySharingDevices = [input]
            v.networkDevices = []; v.socketDevices = []; v.serialPorts = []
            v.audioDevices = []; v.entropyDevices = []; v.graphicsDevices = []
            v.keyboards = []; v.pointingDevices = []; v.memoryBalloonDevices = []
            // No USB controllers, console, GUI view, clipboard or other device is created.
            try v.validate()
            let machineVM = VZVirtualMachine(configuration: v, queue: .main)
            machineVM.delegate = self; vm = machineVM
            runDeadline = clock.now() + c.runSeconds * 1_000_000_000
            issueChallenge()
        } catch { end((error as? Refusal)?.id ?? "vm-configuration-rejected", failed: true) }
    }
    private func issueChallenge() {
        guard !terminal else { return }
        var bytes = [UInt8](repeating: 0, count: 32)
        let result = bytes.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, $0.count, $0.baseAddress!) }
        guard result == errSecSuccess else { end("nonce-unavailable", failed: true); return }
        generation += 1
        let nonce = bytes.map { String(format: "%02x", $0) }.joined()
        challengeCreated = clock.now(); nextChallenge = challengeCreated + 500_000_000
        challengeDeadline = challengeCreated + 1_000_000_000
        // Supersede any unanswered nonce. Merely issuing a challenge NEVER grants
        // additional run time. Initial admission also expires without a permit.
        if permitExpires == 0 { permitExpires = challengeDeadline }
        outstanding = nonce
        guard output(["event": "challenge", "nonce": nonce, "generation": generation,
                      "createdContinuousNs": String(challengeCreated), "deadlineContinuousNs": String(challengeDeadline)]) else {
            end("channel-write", failed: true); return
        }
    }
    private func control(_ o: [String: Atom]) {
        guard !terminal else { return } // No terminal input can ever reopen admission.
        do {
            guard let c = config else { throw Refusal(id: "control-before-config") }
            try require(text(o, "identity") == c.identity, "control-binding")
            let event = try text(o, "event")
            if event == "stop" {
                try require(Set(o.keys) == Set(["event", "identity"]), "stop-keys")
                end("parent-stop", failed: false); return
            }
            try require(event == "permit" && Set(o.keys) == Set(["event", "nonce", "identity", "validForMs"]), "permit-keys")
            let now = clock.now()
            try require(!expired(now), "permit-expired")
            // Never let input which waited in a pipe/main-queue backlog consume
            // a nonce whose 500 ms generation has already been superseded.
            if now >= nextChallenge { issueChallenge() }
            try require(!terminal && clock.now() < challengeDeadline, "permit-expired")
            try require(outstanding != nil && text(o, "nonce") == outstanding, "permit-nonce")
            let validForMs = try number(o, "validForMs")
            try require(validForMs >= 1 && validForMs <= 1000, "permit-budget")
            let expiry = min(challengeCreated + validForMs * 1_000_000, min(challengeDeadline, runDeadline))
            try require(clock.now() < expiry, "permit-budget-expired")
            outstanding = nil // Consume once; the nonce binds this generation internally.
            permitExpires = expiry // Actual remaining parent budget, NEVER receipt time.
            if !startIssued && !admissionPending {
                guard let artifacts = artifacts else { throw Refusal(id: "vm-missing") }
                admissionPending = true
                let activationGeneration = generation
                // Metadata I/O cannot stall the main-queue stop watchdog. A late
                // check is rejected; newer permits cannot revive this admission.
                artifactQueue.async { [self] in
                    let checked: Bool
                    do { try artifacts.recheck(); try artifacts.verifyGuestJob(); checked = true } catch { checked = false }
                    DispatchQueue.main.async { [self] in
                        admissionPending = false
                        guard !terminal else { return }
                        guard checked, generation == activationGeneration, clock.now() < nextChallenge,
                              !expired(clock.now()), let vm = vm else {
                            end("activation-fence", failed: true); return
                        }
                        // The ONLY physical start site, immediately behind the
                        // generation/continuous-time/terminal fence on VZ's queue.
                        startIssued = true; startPending = true
                        artifacts.releaseWritableLocks()
                        vm.start { [self] result in
                            dispatchPrecondition(condition: .onQueue(.main))
                            // An extra queue turn means the callback has RETURNED
                            // before startPending clears or proof can be emitted.
                            DispatchQueue.main.async { [self] in
                                startPending = false
                                switch result {
                                case .failure: end("vm-start-failed", failed: true)
                                case .success:
                                    if !terminal {
                                        if expired(clock.now()) { end("activation-expired", failed: true) }
                                        else if !artifacts.virtualizationHoldsWritableLocks() { end("vz-lock-not-held", failed: true) }
                                        else if !output(["event": "started"]) { end("channel-write", failed: true) }
                                    }
                                }
                                if terminal { driveStop() }
                            }
                        }
                    }
                }
            }
        } catch { end((error as? Refusal)?.id ?? "control-invalid", failed: true) }
    }
    private func expired(_ now: UInt64) -> Bool {
        now >= runDeadline || (permitExpires != 0 && now >= permitExpires) || (outstanding != nil && now >= challengeDeadline)
    }
    private func tick() {
        if terminal { driveStop(); return }
        guard vm != nil else { if clock.now() >= configDeadline { end("config-timeout", failed: true) }; return }
        let now = clock.now()
        if expired(now) { end("fence-timeout", failed: true); return }
        if now >= nextChallenge { issueChallenge() }
    }
    private func end(_ id: String, failed: Bool) {
        if failed { fault = true }
        if !terminal {
            terminal = true; outstanding = nil; permitExpires = 0 // Close admission BEFORE touching VZ.
            if failed { diagnostic(id) }
        }
        driveStop()
    }
    private func driveStop() {
        guard terminal, !emittedStopped else { return }
        guard let vm = vm else { exit(2) } // Validation/startup without a VM is UNKNOWN.
        // A pre-start stopped state is not stop evidence for an attempted run.
        if !startIssued { exit(2) }
        if startPending || stopPending { return }
        if vm.state == .stopped {
            emittedStopped = true
            // Retain VM + descriptors until this observation AND all callbacks drained.
            guard output(["event": "stopped"]) else { diagnostic("stopped-write-failed"); exit(2) }
            exit(fault ? 2 : 0) // Complete write accepted; no stdio/user-space buffer.
        }
        // A failed start leaves the VM in .error: nothing runs and nothing can
        // stop it. Exit as UNKNOWN (fault, no "stopped" proof) instead of
        // observing forever; the parent quarantines the attempt.
        if vm.state == .error { diagnostic("vm-error-state"); exit(2) }
        if !stopFailed && vm.canStop {
            stopPending = true
            vm.stop { [self] error in
                dispatchPrecondition(condition: .onQueue(.main))
                DispatchQueue.main.async { [self] in
                    stopPending = false
                    if error != nil { stopFailed = true; fault = true; diagnostic("vm-stop-failed") }
                    driveStop()
                }
            }
        }
        // Starting/stopping/error/unsupported transitions are NOT stopped. Retain and
        // observe indefinitely; parent must quarantine, never infer proof from PID loss.
    }
    func guestDidStop(_ virtualMachine: VZVirtualMachine) {
        dispatchPrecondition(condition: .onQueue(.main)); end("guest-stopped", failed: false)
    }
    func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: Error) {
        dispatchPrecondition(condition: .onQueue(.main)); end("vm-state-error", failed: true)
    }
}
#endif

signal(SIGPIPE, SIG_IGN)
// No run-time platform fallback, CLI commands, installers, inherited shell or credentials.
for fd in [STDIN_FILENO, STDOUT_FILENO] {
    var s = stat()
    guard fstat(fd, &s) == 0 else { fail("private-channel-required") }
    if isType(s, mode_t(S_IFSOCK)) {
        var peer = sockaddr_storage(); var length = socklen_t(MemoryLayout<sockaddr_storage>.size)
        let result = withUnsafeMutablePointer(to: &peer) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getpeername(fd, $0, &length) }
        }
        var kind: Int32 = 0; var kindLength = socklen_t(MemoryLayout<Int32>.size)
        guard result == 0, peer.ss_family == sa_family_t(AF_UNIX),
              getsockopt(fd, SOL_SOCKET, SO_TYPE, &kind, &kindLength) == 0, kind == SOCK_STREAM else { fail("local-stream-required") }
    } else if !isType(s, mode_t(S_IFIFO)) { fail("private-channel-required") }
}
let inputFlags = fcntl(STDIN_FILENO, F_GETFL)
guard inputFlags >= 0 && fcntl(STDIN_FILENO, F_SETFL, inputFlags & ~O_NONBLOCK) == 0 else { fail("channel-input-flags") }
for fd in [STDOUT_FILENO, STDERR_FILENO] {
    let flags = fcntl(fd, F_GETFL)
    guard flags >= 0 && fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0 else { fail("nonblocking-output-required") }
}
#if arch(arm64)
if #available(macOS 13.0, *) {
    let host = Host()
    host.run()
    dispatchMain()
} else { fail("macos13-required") }
#else
fail("apple-silicon-required")
#endif
