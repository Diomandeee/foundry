# Mac VM host source handoff — 2026-10-18

SOURCE ONLY, operational HOLD. This worker changed exactly:

- `packages/build-runtime/native/mac-vm-host.swift`
- `packages/build-runtime/native/mac-vm-host.entitlements`
- `docs/cloud-workspaces/mac-safety-2026-10-18/VM-HOST-REVIEW.md`

No tests authored/run, compilation, typecheck, import/probe, helper/VM start, installation, image download/creation, provisioning, credential access, provider operation, spend, commit/push/deploy or cleanup. Other workers' source and reports were read, not edited. Existing authority/Xcode deny, Pi, integration HOLD and other lanes remain outside this change. No operational eligibility is claimed.

## Concrete source

The Swift executable configures `VZMacOSBootLoader`, `VZMacPlatformConfiguration`, the saved supported `VZMacHardwareModel`, saved `VZMacMachineIdentifier`, and existing `VZMacAuxiliaryStorage`. It configures CPU and guest RAM, attaches exactly two writable RAW disk images, and creates one read-only virtiofs single-directory share with Apple's macOS automount tag. Host and guest require macOS 13+; the helper requires an Apple Silicon host. Unsupported hosts/configurations reject; no native fallback, installer or restore-image code exists.

Network devices, guest sockets, serial ports, audio, graphics, keyboards, pointing devices, entropy and balloon devices are empty. No USB controller, GUI view, clipboard, host command, shell, process launch or guest-output transport is created. Guest services/descendants remain inside this VM boundary, conditional on Apple's virtualization isolation and the owner prerequisites below. This is a VM containment primitive, not a production RuntimeAdapter or a build-success path.

The entitlement plist contains only `com.apple.security.virtualization=true`. It is neither an App Sandbox profile nor evidence of code signing, installation, entitlement acceptance or resource-policy enforcement.

## Final config: exactly 18 fields

First stdin frame is a single UTF-8 JSON object followed by LF:

```ts
interface MacVmHostConfig {
  version: 1;
  attemptId: string;
  profileHash: string;
  jobId: string;
  identity: string;
  guestJobSha256: string;
  helperUID: number;
  cpuCount: number;
  memoryBytes: number;
  maxBootBytes: number;
  maxOutputBytes: number;
  maxRunSeconds: number;
  bootDisk: string;
  outputDisk: string;
  auxiliaryStorage: string;
  hardwareModel: string;
  machineIdentifier: string;
  inputDirectory: string;
}
```

`attemptId` and `jobId` are 1–128 ASCII letters/digits/dot/underscore/hyphen; standalone `.` and `..` reject. `profileHash` is the parent's locally approved recipe hash, exactly 64 lowercase hex characters. `guestJobSha256` is exactly 64 lowercase hex characters and must come from the parent's private approved encoded guest-job bytes, not from an untrusted job's self-approval.

Identity is exactly `"vm:" + SHA256(UTF8(JSON.stringify([jobId,attemptId,profileHash])))`, lower-case hex digest. The helper recomputes it using the same compact ASCII JSON bytes and pins its private config. Order is **jobId, attemptId, profileHash**. Server authority/source binding remains the parent's separate responsibility.

Every path is exact, with `BASE=/Library/Foundry/VM/attempts/<attemptId>`:

| Field | Exact path |
| --- | --- |
| bootDisk | BASE/boot.raw |
| outputDisk | BASE/outputs.raw |
| auxiliaryStorage | BASE/auxiliary.bin |
| hardwareModel | BASE/hardware-model.bin |
| machineIdentifier | BASE/machine-identifier.bin |
| inputDirectory | BASE/input |

`helperUID` must equal both real/effective UID, be 501..UInt32.max; real/effective GID must be nonzero. This checks account numbers, not whether the account is truly dedicated. CPU is 1..64; guest RAM is 2..64 GiB in whole MiB; Apple's configuration validation can impose stricter hardware requirements. `maxRunSeconds` is integer 1..3600, anchored when the configured VM is ready, before the initial challenge. Initial config receipt, artifact inspection and configuration have a separate five-second continuous-time deadline; a late background check cannot launch anything.

`maxBootBytes` is 1 MiB..128 GiB; `maxOutputBytes` is 1 MiB..8 GiB; both are multiples of 512. Actual positive `fstat` lengths must fit these upper bounds and be multiples of 512. No assumption that file length equals a caller's advertised maximum. `st_blocks` must cover the file length, `UF_COMPRESSED` is rejected, and `SEEK_HOLE` must report the first hole at EOF. Unsupported hole/ACL queries reject. Auxiliary storage is independently bounded to 16 MiB; each platform metadata file to 4096 bytes.

`helperHash` is **not** a config field. The parent must pin the actual native executable bytes/path/signing policy out of band before spawn. This helper neither installs nor provisions itself, accounts, templates, disks or shares.

## Filesystem boundary and guest-job binding

All paths are opened from `/` through `openat` with `O_NOFOLLOW`, and directories with `O_DIRECTORY`. Ancestors must be root-owned, without group/world write, with no extended ACL entries, on local root-mounted filesystems. Writable disk/auxiliary files are regular, single-link, dedicated-helper-UID-owned, exact mode 0600; platform metadata is root-owned exact mode 0444. All six artifacts are under the protected per-attempt root. Input and disk files must be on that root's device.

The input tree has root-owned exact 0555 directories / 0444 regular single-link files, no symlinks or special files, no device crossing, depth <=32, <=65,536 descendant entries and <=2 GiB total file bytes. These are defensive host traversal ceilings; they do not widen the parent's separate 1024-file/2-GiB source encoder limit or 262,144-byte guest job limit. A fixed read-only input share exposes only this sealed snapshot. Guest workspace is guest-local `/private/var/foundry/work`; it is not a host share.

`input/job.json` is opened with `openat` relative to the held input-directory FD, validated as a root-owned 0444 regular single-link file, bounded to 262,144 bytes, and retained. Its exact bytes are streamed through SHA-256 on that same descriptor during initial validation and again during the final pre-start artifact check. Metadata/path/descriptor identity, ownership, permissions, size, flags, mtime and ctime must remain stable around the read. Digest mismatch rejects. Root must keep the entire input immutable for the VM lifetime. The helper does not parse the guest job or prove snapshot/manifest equality: that approval/equality integration remains pending in the parent.

No writable host filesystem share exists. The only guest-writable host-backed artifacts are the fixed-capacity boot/output RAW files and required bounded auxiliary storage. The output disk must already contain the separately provisioned filesystem/label `FoundryOutputs`; the guest runner uses `/Volumes/FoundryOutputs`. The helper does not format, mount, label, extract, inspect or package outputs. Guest disk contents, receipts and logs remain untrusted.

Descriptors are retained and advisory locks are acquired. Apple's selected RAW attachment API takes a URL; no unsupported `/dev/fd` alias or descriptor-attachment capability is claimed. Stable descriptor/path rechecks precede physical start, but URL consumption still depends on protected ancestry and owner-controlled lifetime. **Locks are cooperative.** An owner-enforced exclusive helper UID and no concurrent same-UID/root artifact mutation are mandatory. File ownership/mode checks do not exclude privileged administration, raw-block writes, APFS clone backing issues or another process under that UID. These are explicit trust prerequisites, not hard exclusion furnished by flock.

## Line protocol and physical activation fence

Stdin/stdout must be inherited private pipes or connected AF_UNIX stream endpoints. TTYs, ordinary files and other socket families reject. These host control endpoints are not guest socket devices or listeners. Caller must establish private descriptor inheritance; matching identity is correlation, not IPC peer authentication. The parent sends a minimal environment without credentials; the helper never evaluates environment/host commands.

After config, commands have exact keys:

```ts
{event: 'permit', identity: string, nonce: string, validForMs: number}
{event: 'stop', identity: string}
```

`validForMs` is an unsigned integer 1..1000, at most `floor(remainingMs)` from the parent's actual current lease/cancel/job-deadline fence. Zero, missing/invalid actual remaining authority, cancellation or a thrown parent fence must produce STOP/closed admission, never an invented budget. The helper cannot authenticate a broker lease from this number alone; the parent is the authority boundary.

Helper stdout emits only these JSON objects, each LF-terminated:

```ts
{event:'challenge', identity, nonce, generation,
 createdContinuousNs, deadlineContinuousNs}
{event:'started', identity}
{event:'stopped', identity}
```

Nonce is fresh 32-byte cryptographic randomness rendered as 64 lowercase hex characters; generation starts at 1. Continuous times are canonical unsigned decimal strings. **Wire deadline delta is exactly 1,000,000,000 ns. Challenge cadence is 500,000,000 ns.** Every issuance retires any previous unanswered nonce: only one nonce/generation can be outstanding. A permit consumes it once; duplicate, stale, superseded or identity-mismatched commands are terminal errors. Generation binding is internal to the nonce; no caller-supplied generation may replace it.

Accepted permit expiry is exactly:

```
min(challengeCreatedContinuousNs + validForMs * 1_000_000,
    challengeDeadlineContinuousNs,
    runDeadlineContinuousNs)
```

It is NEVER receipt time plus budget. An already-expired budget rejects. The initial challenge has a one-second no-permit admission timeout. Issuing later challenges does not extend that timeout or any accepted permit. Before processing a permit, expired authority is rejected; a delayed main-queue turn supersedes an elapsed generation instead of accepting buffered prior responses. There is no catch-up issuance/replay, automatic extension or resurrection after timeout.

Metadata/digest rechecks run on a separate artifact queue. Their completion must return within the same generation, before its next challenge, before permit expiry, before the job deadline, and with terminal admission still open. Only that fenced continuation calls `vm.start`, once. A newer permit cannot revive an admission whose generation elapsed while its I/O was pending. The parent returns its preparatory session after helper spawn, before asynchronous VM startup, with a durable identity marker already persisted. `started` reports the VZ start callback outcome only, not job success, lease validity forever, or a result.

A 10-ms dispatch watchdog uses Mach continuous time (includes sleep) and checks expiry before rechallenge. Continuous time anchors authority; dispatch scheduling and VZ APIs are not real-time guarantees. Framework configuration/attachment construction necessarily execute synchronously on the VM's queue; no bounded latency for those OS calls is established. A suspended/crashed helper or blocked OS service cannot be represented as guaranteed physical stop within one second.

## Stop, error and recovery semantics

EOF before terminal closure, invalid input/permit, timer expiry, fatal configuration, output-channel failure, signals or VM errors close admission permanently first. Explicit STOP and guest shutdown also close admission first. There is no resume, restart, retry-start or native fallback. Once the VM can be stopped, the helper uses asynchronous `VZVirtualMachine.stop`; an in-flight start must finish its callback and then be stopped, even if STOP/cancel arrived during startup.

All VZ access and delegates use `.main`. Input reading, bounded decoding, initial tree inspection and later metadata/digest inspection run off main. The decoder reads at most 4096 bytes at a time, retains at most an 8192-byte initial config / 2048-byte control line, and synchronously hands each decoded frame to main without accumulating unbounded pending work. JSON is deliberately restricted to flat objects with unescaped printable ASCII strings and unsigned canonical decimal integers. Unknown/duplicate keys, nesting, floats/exponents, signs, booleans/null, escapes, CR/BOM and trailing data reject. This is a restricted JSON wire format, not a generic parser.

Stdout/stderr use bounded nonblocking writes; stdout event frames are below 2048 bytes. A short/failed write is not retried as successful evidence. Normal STOP and guest shutdown produce **no stderr**. Errors emit fixed identifier strings only, never NSError descriptions, paths, argv, input or guest output. EOF after an already accepted STOP is ignored, so the parent's STOP followed by `stdin.end()` does not poison a clean stop.

`stopped` requires an attempted physical start, start callback returned, stop callback returned if any, no pending start/stop, and actual `vm.state == .stopped`. Callback flags clear in a subsequent main-queue turn, after the OS callback returns. VM and artifact FDs remain retained through that observation. Pre-start `.stopped`, helper exit/PID absence, guest receipt, requested shutdown, EOF and callback success alone are never stop proof. Unsupported/error transitions without observed stopped retain the VM indefinitely; parent observation timeout is unknown/quarantine, not proof.

After observed stopped, one complete event write is accepted by the channel, then the helper exits 0 only for a clean explicit stop or clean guest shutdown; startup/fence/channel/VM faults exit 2 even if physical stop is later observed. Parent evidence requires matching `stopped` plus clean helper close 0, no termination signal and an intact channel. It must drain/reject all stderr/invalid/trailing frames. A helper crash, partial event, lost channel, failed startup or observation timeout is unknown/quarantine. No event conveys a build exit code or output-success claim.

**Durable replay exclusion is external and mandatory:** parent must actually call `HostJournal.reserve(plan)` and persist the identity before spawn; an arbitrary `recordIdentity` callback is insufficient. Its permanent attempt record and held slot prevent reuse after crash. This helper is one-shot only in process; flock disappears on exit and does not prevent cross-restart disk/config replay. No helper-created claim file is supplied or claimed. Parent retains the HostJournal slot in quarantine even after a known VM stop; no automatic reuse/release. Bypassing that parent journal is outside the supported contract.

## Owner prerequisites and incomplete work

Root must provision an immutable, vetted, preinstalled macOS template with the guest runner, then supply separate per-attempt boot/auxiliary copies, compatible saved hardware model and unique machine identifier. No main VM installation is performed here. Owner also supplies fully allocated boot/output RAW files, an offline guest toolchain, the output filesystem/label, the sealed approved input/job tree, a real exclusive account, protected ancestry/local storage, disk headroom, CPU/RAM policy, helper signing/entitlement and actual binary pins. No such provisioned artifacts or live properties were inspected or attested.

The once-at-boot guest runner is a separately owned source lane: read `/Volumes/My Shared Files/job.json` and source, work guest-locally, write only guest disks, request guest shutdown. This document does not attest its implementation or trusted image content. Source hash/approved snapshot equality, exact job authorization, guest tooling, real host eligibility and current online lease wiring remain external acceptance work.

Future output intake requires a **separately gated root read-only mount**, immutable root-owned presentation and the concrete readonly guard/packager. Nothing in this helper mounts/extracts outputs or converts guest-owned files into trusted host data. Known VM stop alone does not imply a successful build, collected result, safely packaged artifact or publication approval. No RuntimeAdapter/controller integration, automatic eligibility lift, authority-policy change or Xcode placement approval is provided.

## Source findings and disposition

- Initial identity array order was reconciled to the parent's `[jobId,attemptId,profileHash]`; dots were allowed without permitting `.`/`..` path components.
- Callback-local pending flags were insufficient to say callbacks had returned; source now defers their clearing to the next main-queue turn.
- FIFO-only control validation rejected possible Node/libuv AF_UNIX endpoints; source now permits connected local stream sockets too.
- Normal stop diagnostics and post-STOP EOF could poison the parent's clean-close contract; normal stop is silent and terminal EOF is ignored.
- Initial 500-ms wire-expiry vs one-second client mismatch was reconciled: final wire delta is one second, cadence/supersession 500 ms.
- `guestJobSha256` is now mandatory and checked on a held descriptor again before physical start. This binds bytes without claiming snapshot equality.
- Parent's real remaining authority budget is now required as `validForMs`; the helper conservatively anchors it at challenge creation, then checks expiry before start.
- Independent review R2 identified a fail-open possibility in ACL text rendering. Source now uses `fstatx_np` + `filesec_query_property(FILESEC_ACL)`; present ACLs require successful property retrieval and direct `acl_get_entry(ACL_FIRST_ENTRY)`. Darwin entry success is 0; only -1 with captured EINVAL is accepted as empty. Allocation, query, entry and free failures refuse; no text rendering is accepted as proof. This is source remediation, not a compiled/runtime pass. R3/R4 are owned by parent/other source lanes and are not claimed fixed here.

## Primary Apple references

- [macOS boot loader](https://developer.apple.com/documentation/virtualization/vzmacosbootloader) and [Mac platform](https://developer.apple.com/documentation/virtualization/vzmacplatformconfiguration): required platform pairing.
- [RAW URL attachment initializer](https://developer.apple.com/documentation/virtualization/vzdiskimagestoragedeviceattachment/init(url:readonly:)-9qeco): actual selected public attachment API.
- [VM queue initializer](https://developer.apple.com/documentation/virtualization/vzvirtualmachine/init(configuration:queue:)): VM operations, callbacks and delegates on its serial queue.
- [Start callback](https://developer.apple.com/documentation/virtualization/vzvirtualmachine/start(completionhandler:)) and [stop callback](https://developer.apple.com/documentation/virtualization/vzvirtualmachine/stop(completionhandler:)): asynchronous lifecycle; stop may report an error.
- [virtiofs configuration](https://developer.apple.com/documentation/virtualization/vzvirtiofilesystemdeviceconfiguration): macOS 13+ automount and `/Volumes/My Shared Files` convention.
- [Apple Libc ACL entry implementation](https://github.com/apple-oss-distributions/Libc/blob/main/posix1e/acl_entry.c) and [filesec implementation](https://github.com/apple-oss-distributions/Libc/blob/main/gen/filesec.c): direct empty-vs-error ACL checks.

## RTD verification boundary

| Level | Evidence/status |
| --- | --- |
| Structure | Local source readback and exact output-path listings only; three owned files present. |
| Compilation | **DEFERRED explicitly by user.** No build, typecheck, imports/probes, tests or test authoring. SDK/compiler/concurrency compatibility remains unverified. |
| Integration | Source-only comparison with current runtime/types/native protocol, parent VM session and independent review. Final client must enforce this 18-field config, one-second challenge delta and `validForMs` permits. No executed integration proof. |
| Content | Manual source inspection of identity, descriptor policies, bounded parser/hash, generation/deadline fence, terminal transitions and proof limits. |
| Runtime/user journey | **DEFERRED explicitly by user.** No VM/helper/service starts or end-to-end validation. Headless boot, fully allocated image checks, locks vs attachment behavior and OS stop behavior remain unverified. |
| Deployment | **DEFERRED explicitly by user.** No signing, installation, provisioning, release, cloud operations, spend or deployment. |

Final source handoff only. Baseline and other workers' edits are preserved. Independent source re-review/acceptance remains separate; this report makes no passing validation or activation claim.
