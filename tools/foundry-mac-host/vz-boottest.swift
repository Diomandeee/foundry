// vz-boottest: boot a Foundry guest image the way mac-vm-host does, without
// the authority/permit machinery, to test the guest side (boot hook, input
// automount without a login, runner, output disk, self-shutdown).
//
// Same Virtualization configuration as packages/build-runtime/native/
// mac-vm-host.swift: VZMacPlatform from hardware-model/machine-identifier/
// auxiliary files, VZMacOSBootLoader, two raw virtio block disks (boot, outputs),
// one read-only VZSingleDirectoryShare under the macOS automount tag, no network.
// --net adds a NAT device; use it only for maintenance boots, never for a job.
//
//   vz-boottest --dir <image dir with boot.raw, auxiliary.bin, hardware-model.bin,
//               machine-identifier.bin> --outputs <outputs.raw> [--input <dir>]
//               [--net] [--cpu 4] [--memory-gib 8] [--timeout-s 1800]
//
// Build: swiftc -O vz-boottest.swift -o vz-boottest
//        codesign -s - --entitlements <virtualization entitlement> vz-boottest
import Foundation
import Virtualization

func fail(_ m: String) -> Never { FileHandle.standardError.write(Data("vz-boottest: \(m)\n".utf8)); exit(2) }
func log(_ m: String) {
    let t = ISO8601DateFormatter().string(from: Date())
    print("\(t) \(m)"); fflush(stdout)
}

var dir = "", outputs = "", input: String? = nil, net = false
var cpu = 4, memGiB = 8, timeout = 1800.0
var a = Array(CommandLine.arguments.dropFirst())
while !a.isEmpty {
    let f = a.removeFirst()
    func v() -> String { guard !a.isEmpty else { fail("\(f) needs a value") }; return a.removeFirst() }
    switch f {
    case "--dir": dir = v()
    case "--outputs": outputs = v()
    case "--input": input = v()
    case "--net": net = true
    case "--cpu": cpu = Int(v()) ?? cpu
    case "--memory-gib": memGiB = Int(v()) ?? memGiB
    case "--timeout-s": timeout = Double(v()) ?? timeout
    default: fail("unknown flag \(f)")
    }
}
guard !dir.isEmpty, !outputs.isEmpty else { fail("--dir and --outputs are required") }

func data(_ name: String) -> Data {
    guard let d = FileManager.default.contents(atPath: dir + "/" + name) else { fail("cannot read \(name)") }
    return d
}
guard let hardware = VZMacHardwareModel(dataRepresentation: data("hardware-model.bin")), hardware.isSupported else { fail("hardware model unsupported") }
guard let machine = VZMacMachineIdentifier(dataRepresentation: data("machine-identifier.bin")) else { fail("bad machine identifier") }
let platform = VZMacPlatformConfiguration()
platform.hardwareModel = hardware
platform.machineIdentifier = machine
platform.auxiliaryStorage = VZMacAuxiliaryStorage(url: URL(fileURLWithPath: dir + "/auxiliary.bin"))

let c = VZVirtualMachineConfiguration()
c.platform = platform
c.bootLoader = VZMacOSBootLoader()
c.cpuCount = max(VZVirtualMachineConfiguration.minimumAllowedCPUCount, min(cpu, VZVirtualMachineConfiguration.maximumAllowedCPUCount))
c.memorySize = UInt64(memGiB) * 1024 * 1024 * 1024
do {
    c.storageDevices = try [dir + "/boot.raw", outputs].map {
        VZVirtioBlockDeviceConfiguration(attachment: try VZDiskImageStorageDeviceAttachment(url: URL(fileURLWithPath: $0), readOnly: false))
    }
} catch { fail("disk attach: \(error)") }
if let input {
    let share = VZVirtioFileSystemDeviceConfiguration(tag: VZVirtioFileSystemDeviceConfiguration.macOSGuestAutomountTag)
    share.share = VZSingleDirectoryShare(directory: VZSharedDirectory(url: URL(fileURLWithPath: input), readOnly: true))
    c.directorySharingDevices = [share]
}
if net {
    let n = VZVirtioNetworkDeviceConfiguration()
    n.attachment = VZNATNetworkDeviceAttachment()
    c.networkDevices = [n]
}
let gfx = VZMacGraphicsDeviceConfiguration()
gfx.displays = [VZMacGraphicsDisplayConfiguration(widthInPixels: 1024, heightInPixels: 768, pixelsPerInch: 80)]
c.graphicsDevices = [gfx]
c.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]
do { try c.validate() } catch { fail("configuration invalid: \(error)") }

final class Watcher: NSObject, VZVirtualMachineDelegate {
    func guestDidStop(_ vm: VZVirtualMachine) { log("GUEST STOPPED ITSELF"); exit(0) }
    func virtualMachine(_ vm: VZVirtualMachine, didStopWithError error: Error) { log("VM STOPPED WITH ERROR: \(error)"); exit(3) }
}
let watcher = Watcher()
let vm = VZVirtualMachine(configuration: c, queue: .main)
vm.delegate = watcher
let started = Date()
log("starting: cpu \(c.cpuCount), memory \(memGiB) GiB, input \(input ?? "none"), network \(net ? "NAT" : "none")")
vm.start { result in
    if case .failure(let e) = result { log("start failed: \(e)"); exit(4) }
    log("running")
}
Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { _ in
    let s = Date().timeIntervalSince(started)
    if s > timeout {
        log("TIMEOUT after \(Int(s)) s: stopping the VM from the host")
        vm.stop { _ in exit(5) }
    }
}
RunLoop.main.run()
