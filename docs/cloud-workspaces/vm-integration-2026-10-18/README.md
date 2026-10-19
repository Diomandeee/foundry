# M3 — production VM integration, source complete

Status: **implemented / source-reviewed / validation-pending / not activated**.
Scope: Mac VM adapter, authenticated controller composition, guest capability matching, source/stop/intake/publication lifecycle. This is completed local implementation, not a request to delegate the same wiring again. Production readiness and the overall Foundry goal are not claimed.

Repository: `/Users/mohameddiomande/Developer/foundry-integration/source`, branch `codex/foundry-integration-20261016`, base `cf27ac662730bb98a509af8d1d1ebea4342eef7a`. The shared candidate remains uncommitted. Baseline/preimages preserve this batch separately from the frozen M1/M2 batch.

## Entry point and full path

`packages/build-runtime/src/mac-vm-worker.ts` exports `createMacVmBuildWorkerController(config)`. Construction is inert. It requires the concrete `NodeBuildTransport`, a branded owner `ParentProfileBinding`, actual enrollment/authority pins, provisioned source/capability seal configurations, a real metadata reader, real post-claim result-storage resolver, local packaging/CAS ports and explicit output classifications. No default credential/provider/grant/image/receipt exists.

1. Explicit run/poll refuses locally if host activation is disabled. The controller persists its intent before authenticated liveness/claim HTTP. Poll and claim produce distinct fresh censuses, paced above the authority's one-second minimum.
2. Liveness observes host capacity/storage plus the separately owner-pinned guest capability image. Host Xcode is not used by the VM composition. Placement requires the existing worker/profile approval AND the separate immutable `approveVm` owner command for the exact enrollment revision, profile, capability hash and activation-evidence hash. No such command was sent.
3. The actual claim returns the authority-approved guest capability hash. Controller context binds it to the source/profile/worker/attempt/fence. The supervisor reserves exactly one durable host slot before preparation.
4. `MacVmRuntimeAdapter.prepareAttempt` independently reads the real approved manifest/metadata through the supplied reader and verifies every required source file and underlying object against the concrete readonly source seal. It selects only an explicitly provisioned snapshot hash; unsupported or missing source images refuse. Private work/input roots hold host metadata, not a pretend restored checkout.
5. Guest job **v2** binds the approved capability and runner hash. `MacVmIoMailbox` persists exact staging request bytes and waits under current lease/cancellation/deadline for an owner-produced receipt. `acceptMacVmStaging` checks the actual readonly mount and complete tree; receipt JSON alone never authorizes launch.
6. Native host configuration **v2** adds the exact boot SHA. The native helper holds the boot descriptor, hashes it before configuring the VM, rechecks its identity before physical start and uses the existing challenge/generation/continuous-time permits. Initial artifact/hash admission is bounded to 300 seconds; the controller's overall execution deadline still includes this time. Current supervisor runway caps every permit. No host signing keys, host writable shared tree or network device is given to the guest.
7. The helper's callback-drained whole-VM stop is durably appended to the SAME host reservation before a private stop receipt is minted. The low-level API remains containment-only. The adapter separately requests stop-gated disk intake, waits for the owner helper, and verifies the resulting readonly tree. Guest result **v3** includes capability/runner lineage and actual checked guest macOS/Xcode, exit status, required outputs, modes, directories and log hashes.
8. Only successful `acceptMacVmIntake` can produce adapter Exit code 0. A helper exit, VM shutdown, missing result, failure envelope, timeout or transport error cannot do so. Logs are retained in artifacts; the adapter does not manufacture runtime stdout as success evidence.
9. The controller reports confirmed stop through authenticated authority commands, resolves real attempt-scoped storage, publishes via `publishMacVmIntake`, independently checks the publication bytes, and stages the real manifest. The authority returns `staged:true, verified:false`. Existing independent verification remains necessary for success.
10. The supervisor finalizes its host reservation once. Unknown launch/stop, lost renewal, failed intake, ambiguous publication or any failed persistence keeps local quarantine. Controller and authority reconciliation remain explicit owner operations; expiry/PID absence never grants a rerun.

## Explicit operator bridge, not an unattended privilege service

Root assembly/mounting remains an explicit owner tool. M3 supplies the request/wait/receipt integration; it does not install a root daemon, provide passwordless sudo, create a boot image, or automatically provision per-attempt disks. This supported pilot is operator-mediated at two points: stage and intake. It is not an unattended build farm.

The adapter durably writes `<journalRoot>/vm-io-<attemptId>-<stage|intake>-<requestSha256>.json`. `HostJournal.inventory()` includes these metadata entries. The owner inspects the exact attempt/hash, provisions the already-required attempt artifacts and `/Library/Foundry/VM/attempts/<id>/receipts` as a root-owned ACL-free readable directory, then invokes the reviewed root `native/mac-vm-io.py` with that exact request hash and the request bytes on stdin. Those operations require separate approval and were not performed here.

The helper preserves its root-private intermediate receipt and atomically publishes a root-owned 0444 receipt to `receipts/stage.json` or `receipts/intake.json` with exclusive rename. It cannot overwrite a previous receipt. Partial requests, images, mounts and journals remain for owner review. The worker performs same-descriptor bounded receipt reads and then actual guarded tree verification. The original raw output is never mounted for intake.

An owner who responds after cancellation/deadline may create retained I/O artifacts, but cannot revive the controller's closed launch or publication fence. A restart never resumes an in-memory private receipt or silently replays a request.

## Guest capability evidence and approvals

`native/mac-vm-guest.py --describe-capability <explicit developer directory>` is a later-approved **guest** observation mode. It reads actual architecture, macOS, Xcode build, SDKs and its own runner bytes. It does not execute a project or shutdown in this mode. It was not run. Running this on a host does not prove a guest image's contents.

After separately approved image construction/observation and shutdown, the owner binds the observed fields to the exact offline boot-image SHA and reviewed installed VM-helper/tree-guard SHA values. The resulting descriptor has the exact `MacVmCapability` schema. Its canonical hash pins `/Library/Foundry/VM/capabilities/<hash>/capability.json` on a concrete readonly volume. Source code hashes are not installed-binary hashes. No values or approvals were fabricated.

`approveVm` records owner attestation and the evidence document hash; it does not independently execute or cryptographically attest a guest. It is owner-only, transactional, immutable, and separate from ordinary worker enrollment/profile approval. Changing the accepted capability requires a newly approved enrollment revision. Revoking the enrollment credential/current worker identity uses the existing authority fence. Every VM renewal also requires a fresh census with the SAME approved capability hash. The boot bytes and guest runner/toolchain are checked again in the execution path.

The operator view separates host and guest toolchains and shows guest capability identity on attempts. Placement explains missing activation, capability mismatch, unavailable guest SDK, wrong architecture, unsupported VM resource limits, stale census and disk/storage blockers. No machine name grants eligibility; Pi remains excluded.

## Bounded supported behavior and retained HOLDs

- Apple Silicon macOS VM only; trusted, unsigned, offline Xcode recipes. Direct native host project execution remains denied. No signing, TestFlight, distribution, interactive guest shell or networking is added.
- VM CPU 1–64; guest memory 2–64 GiB plus 1 GiB host headroom; whole-second timeouts up to 60 minutes. Boot raw ceiling 128 GiB; output raw ceiling 8 GiB. These are limits, not allocated resources or a recommendation that current Macs have that capacity.
- Inputs remain at most 1,024 files / 2 GiB / 64 MiB per file in the VM pilot. Portable result budget remains 7 MiB including logs and packaging overhead; larger real applications may be unsupported. Required-input authority limit remains 128.
- The VM census includes `/Library/Foundry/VM/attempts` and takes the smaller free-space observation across VM and work volumes. Unknown/private/nested-mounted VM trees cause incomplete inventory, not zero bytes. Renewals can maintain an already running job while inventory is incomplete, but another admission is blocked. Retained private image intermediates therefore require owner reconciliation/approved cleanup before subsequent admission. No automatic cleanup is supplied or authorized.
- Generic writable CAS/materialization isolation remains an inherited prerequisite. The concrete readonly seals do not satisfy it. Real packaging ports must provide their documented guarantees; M3 does not substitute a no-op lock. Automatic GCS-to-source-image hydration and automatic VM image provisioning are not supplied by this adapter.
- Existing cumulative integration HOLD findings remain open. This batch does not integrate/merge the shared candidate or bypass the merge gate.
- Failed guest results are retained for review and quarantine; automatic publication of failed build diagnostics/retries is not implemented. A successful VM stop alone may be reported to the authority, but does not make failed/unknown outputs successful.

## Exact stopping point

M3 local source implementation and six inline source-review passes are finished. `SOURCE-REVIEW.md`, `FINDINGS.json`, `CHANGE-RECEIPT.json`, `SCOPE.json`, and `changes.patch` identify the actual delta. M1/M2 freeze remains unchanged.

Next: resolve inherited writable-storage/integration prerequisites, then M4 compilation and deferred acceptance only with matching approval. R7 installation/provisioning/activation, deployment, spending, credentials and cleanup each retain their separate gates. No tests were authored or run; no compiler/typechecker/linter, product import/probe, trial restore/build, helper/VM/service, installation, provider mutation, commit/push/merge/deploy, secret change or cleanup occurred.
