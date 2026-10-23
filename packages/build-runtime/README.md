# Build runtime

> Current validation (2026-10-18): see `../../docs/cloud-workspaces/validation-2026-10-18/` for local compiler/test evidence and remaining operational acceptance. The one-attempt executable composition is `../../tools/foundry-build-pilot/`. Earlier source-only statements below describe their original batches. No installed helper, real VM/container build or fleet activation is claimed. Direct native host Xcode remains denied.


Inert host-side build execution and durable worker orchestration. Construction does not
start polling, discover tools, resolve credentials, execute jobs or send HTTP. Only static
source review has been performed; tests/builds/typechecks and operational checks remain
DEFERRED. Direct native Mac launch remains denied. The concrete Mac VM adapter
and authenticated controller composition are now implemented as source: see
`../../docs/cloud-workspaces/vm-integration-2026-10-18/README.md`. They are not
installed or operationally validated. Root stage/intake I/O is explicitly
operator-mediated. The low-level containment primitive still reports containment
only; the adapter separately verifies intake, then the controller publishes and
stages for the independent authority verifier. ES process evidence stays diagnostic.

## Entry points

- `@foundry/build-runtime`: types, branded owner recipes/plans, `approveParentProfile`,
  `HostJournal`, adapters, `LongJobSupervisor`, `BuildWorkerController`, bounded Node
  transport/liveness, read-only discovery and managed storage inventory.
- `@foundry/build-runtime/storage`: `createStorageWorkerPorts` and
  `createStorageBuildWorkerController`, composing actual sibling build-storage functions.
- `@foundry/build-runtime/discovery`: explicit read-only discovery CLI implementation.
- `createMacVmBuildWorkerController`: concrete VM adapter, image-pinned guest census,
  authenticated Node transport and real post-claim result storage. Construction is inert.

`BuildWorkerController.pollOnce(claimKey, signal?)` refreshes enrolled idle liveness and
census, queries `/v1/builds/next` for the pinned server profile, returns idle only for an
explicit null job, and otherwise enters the same durable `run(job, claimKey, signal?)`
flow. Neither method starts an autonomous polling loop. Mutating command identities,
sequence reservations and pre-run records are durable before HTTP/activation; ambiguous
state is retained for owner reconciliation and never automatically re-executed.

## Current portable publication bounds

| Boundary | Current ceiling |
| --- | --- |
| Generic `approveRecipe` runtime capture/output policy | 128 MiB |
| Portable `approveParentProfile` output/archive/log budget, combined | 7 MiB |
| Required portable output paths | 1..24; complete set required |
| Result output chunks plus log chunks, combined | 31 |
| Individual chunk/object or result manifest | 1 MiB |
| Result grants including one manifest | 32 |
| Wired publication namespace admission | 8 MiB |

The 128 MiB generic runtime ceiling does not authorize a 128 MiB portable BuildProfile.
Runtime log bytes, ordinary file bytes and packed bundle tar bytes share the portable
7 MiB budget. `verifyPublish` checks exact approved output paths, expected file/tar format,
actual ordered chunks and combined file/archive SHA-256 and size, plus the 31-chunk limit.
Packing bytes proves neither app correctness nor signing or native containment.

The 32-grant/8-MiB domain bounds do NOT mean a namespace is empty or has available space.
Actual host publication capacity and current-grant receipts remain mandatory before
writes and after provider awaits. Existing objects/grants, previous attempts, snapshots,
partial publication and retained evidence can consume that capacity. No automatic fresh
namespace, quota increase, eviction, deletion or cleanup is provided. Unsupported capacity
must reject; generic input/storage maxima are not promises that they fit this namespace.

## Host integration

Provide canonical dedicated account/base/journal/cache/CAS paths, local approved recipe
configuration and server profile hash, environment/authority/worker ID pins, fixed-origin credential
reference transport, exact enrollment revision/incarnation and authoritative sequence
baselines, plus real input reads, publication/grant/capacity/tree-seal/CAS providers.
The server profile hash and local runtime digest are independently pinned.

`WorkerAuthorityBinding` is now `{environment, authorityId, workerId}`; all three are
required owner pins. The constructor remains
`BuildWorkerController(binding, expectedEpoch, ports, adapter, maxInputBytes, authority)`.
`StorageWorkerConfig.authority` and `NodeLivenessConfig.authority` require the same binding.
Every accepted commands/next reply must carry the ACTUAL compute-wrapper
`source:{environment,authorityId,epoch}` matching those pins and expectedEpoch. Controller
commands validate it before durable acknowledgment or claim/renew/stop/stage acceptance;
poll validates it before job or idle acceptance. Bare domain-core replies, missing source
and mismatched environment/authority/epoch reject and cannot authorize physical activation.

`WorkerLivenessPort.refreshLiveness(activeJobs, signal)` now returns
`Promise<Readonly<BuildResponseSource>>`, the actual validated census wrapper source.
Node liveness validates census source BEFORE committing the census sequence; controller
also checks that returned source before claim or renewal. Enrollment heartbeat retains
its existing real status identity/revision/incarnation checks; its route does not acquire
a synthetic builds source. No source or successful status is fabricated from local pins.

`publishResult(job, plan, result, context, signal)` receives a branded actual claim context.
`StorageWorkerConfig.resultScope(job, plan, context, signal)` must return real namespace/
principal policy metadata with EXACTLY that compute binding. The context contains the
actual validated claim source and UTF-8 capability digest, never the raw capability/bearer; the worker needs no owner
credential or owner-authenticated `/v1/builds/fence` lookup.

Enrollment and census sequences are separately durable and scoped to the exact enrollment
revision/incarnation. The parent also binds stored census to that revision/incarnation;
old fresh census must not authorize a successor enrollment. This introduces no Census
wire fields. Census carries exact observed SDK identifiers and actual/unknown storage
measurements; unknown is not zero. Cache admission above 20 GiB rejects, without eviction.

Only Linux/digest-pinned offline npm/cargo/CMake/python recipes are supported by the Linux
adapter. A python recipe may carry owner-approved `installArgs`, run first as
`pip install --no-index --no-cache-dir --target /work/site <installArgs>` (wheels ship in the input). Owner-approved executable mappings are explicit. CMake configure/build phases
share host-visible work storage. `NativeMacAdapter.prepare/start` and the ES client's
`start` reject before any callback or process invocation. `reviewRecovery` still reads
bounded historical signed journals; a process seal never establishes service closure.

The separate `launchMacVmContainment(plan, policy, guestJob, staged, currentFence, signal)`
source API reserves a durable host slot and requires owner-provisioned images, roots,
signed helper and a privately verified staged input. A concrete readonly guard spans
fresh full input verification through whole-VM stop and guard postflight. Unknown
observations and even a clean stop retain the slot pending explicit reconciliation.

Guest IO source is now supplied: `verifyMacVmInput` → `encodeMacVmGuestJob` →
`prepareMacVmStaging` → separately owner-invoked `native/mac-vm-io.py` →
`acceptMacVmStaging` → containment launch. After actual observed startup and stop,
`prepareMacVmIntake` hashes the stopped backing file; the same owner-operated helper
copies it, mounts the copy readonly, sanitizes the bounded result envelope, and seals
a separate collection image. `acceptMacVmIntake` independently checks its complete
tree, guest result v3, guest capability/runner pins, modes, logs, lineage and approved outputs. `publishMacVmIntake`
composes the existing real storage broker/writer/collector and `verifyPublish` boundary.
Publication returns a manifest claim; it does not submit or verify it in the authority.

M3 composes these APIs in `MacVmRuntimeAdapter` and the production controller factory.
The supervisor passes its branded reservation to containment and owns finalization;
standalone containment calls retain quarantine. Guest job/config v2 and result v3
are required together. Old candidate artifacts are not silently upgraded.
The helper is an explicit root operator tool, never a setuid/network service or
automatic escalation. Its exact request SHA must be provided at invocation. It
creates only fixed per-attempt paths, retains partial artifacts/mounts, and never
overwrites, retries, detaches or cleans up. Installation, invocation, tests and all
operational work remain gated. See `docs/cloud-workspaces/guest-io-2026-10-18/README.md`
for the preserved M1/M2 source contract. The current M3 contract and remaining M4
boundary are in `../../docs/cloud-workspaces/vm-integration-2026-10-18/README.md`.

Current source verdict: M3 wiring plus the bounded Mac VM writable-storage path
are implemented and source-reviewed. `MacVmAdapterConfig.storage` now requires
actual installed interpreter/helper pins and constructs the concrete privileged
immutable CAS client. There is no injected placeholder writable seal. The CAS
service source is separate from the still operator-mediated VM image helper;
neither has been installed or started by this batch.

Generic Linux writable materialization, project readiness, actual resources and
independent cumulative acceptance remain explicit gaps/gates. No default-success
attestor, authorization port or large-project readiness claim is supplied. Native
host execution remains denied. Compilation/tests, operational validation and
activation require separate approval. Current source and exact limits:
`../../docs/cloud-workspaces/writable-integration-2026-10-18/README.md`.
