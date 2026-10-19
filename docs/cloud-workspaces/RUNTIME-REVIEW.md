> Historical initial source checkpoint. For current broker, v2 input, reservation, runtime integration and native HOLD changes, read [the 2026-10-18 continuation](continuation-2026-10-18/README.md). Statements below describing unimplemented project segmentation or broker host wiring are superseded by that source receipt. Runtime validation remains absent.

# R4 build runtime — static source review

Status: Linux/controller source implemented for review; operational behavior UNVERIFIED.
Native Mac hard-stop/descendant containment is BLOCKED without a supported real host attestor.
This is not a claim of complete native support, an operational worker, or an end-to-end build.

## Scope and exact files

All edits are inside the assigned paths. Existing worker-runtime and other dirty/untracked
work were preserved. No root manifests, lockfiles, existing worker code, credentials,
services, history, or deployment configuration were changed by this work.

- `packages/build-runtime/package.json`
- `packages/build-runtime/README.md`
- `packages/build-runtime/src/index.ts`
- `packages/build-runtime/src/types.ts`
- `packages/build-runtime/src/plans.ts`
- `packages/build-runtime/src/parent-profile.ts`
- `packages/build-runtime/src/host.ts`
- `packages/build-runtime/src/process.ts`
- `packages/build-runtime/src/adapters.ts`
- `packages/build-runtime/src/supervisor.ts`
- `packages/build-runtime/src/controller.ts`
- `packages/build-runtime/src/receipts.ts`
- `packages/build-runtime/src/node-transport.ts`
- `packages/build-runtime/src/liveness.ts`
- `packages/build-runtime/src/discovery.ts`
- `packages/build-runtime/src/storage-inventory.ts`
- `packages/build-runtime/src/storage-integration.ts`
- `docs/cloud-workspaces/RUNTIME-REVIEW.md`

No tests were authored. No tests, builds, typechecks, execution/import probes, discovery,
service starts, installs, cloud operations, credential operations, cleanup, commits,
pushes, merges, or background work were performed. Shell use was limited to source/docs
inspection, source-file writes, directory creation in the owned paths, and file listings.

## Interfaces and trust boundaries

`RuntimePlan` exports exactly the requested attempt/job/kind/profile/input/work/timeout/
CPU/RAM/argv/env/image/outputPaths fields. `RuntimeAdapter`, `Running`, `StopProof`,
`LeasePort`, `SupervisorResult`, `HostPolicy`, `Limits`, and recipe types are exported.
Controller interfaces additionally export `WorkerPollResult`, `WorkerAuthorityBinding`
and `BuildAttemptContext`, plus `BuildResponseSource`; `BuildTransport` requires both
commands and next routes. WorkerAuthorityBinding requires environment/authorityId/workerId.
`approveRecipe` and `buildPlan` brand deeply frozen configurations/plans in private
WeakMaps. Adapters reject structurally matching unbranded remote plans.

`approveParentProfile(ownerProfile, expectedServerHash, localPolicy)` returns a branded
`ParentProfileBinding` with TWO independently checked identities:

- `serverProfileHash`: SHA-256 of the parent sorted-key canonical BuildProfile JSON.
- `localRecipeHash`: runtime digest of the local recipe, resource limits and host paths.

The controller checks the claimed job, profile and input hash against local bindings;
it does not equate those two digests or approve the claim response as a new recipe.
Owner-only approval APIs must never receive remote-selected recipe configuration.
All runtime dependencies in the core are Node standard library. Contracts use sibling
TYPE imports. The optional `@foundry/build-runtime/storage` entrypoint deliberately
composes existing sibling build-storage code; no external dependency was installed.

## Linux adapter

Supports parent owner-approved `npm`, `cargo`, and `cmake` args through explicit canonical
absolute `HostPolicy.imageExecutables` mappings INSIDE the pinned, owner-vetted image.
No image/tool default, remote argv, shell wrapper, pull, configure/install download,
privileged container, device, host network, or inherited environment is supplied.
`approved-dependencies` rejects until an explicit supported dependency policy exists.
Image path canonicality/content is an owner image-vetting prerequisite, not a claim
that the host filesystem inspector can inspect executable paths inside an image.

The adapter requires a native Linux host with matching x64/arm64 architecture, local
canonical Docker executable/socket, and an empty owner-private Docker config directory.
Preflight checks Linux/cgroup-v2 CPU/RAM/PID capabilities, builtin seccomp, no daemon
warnings, actual image digest/architecture and absence of declared anonymous volumes.
The container uses runc, read-only root filesystem, nonroot dedicated UID/GID, dropped
capabilities, no-new-privileges, private namespaces, CPU/RAM/swap/PID/nofile/core limits,
bounded tmpfs/shared memory, no network, disabled Docker logging, and bounded capture.
The daemon/admin/image remain trusted. Rootless/user-namespace configurations that
cannot access the dedicated UID bind mounts are unsupported rather than relaxed.

`/input` is the copied verified snapshot mounted read-only; `/work` is the dedicated
host workRoot mounted writable so real outputs survive for the host collector.
CMake runs explicit shell-free configure (`-S /input -B /work/build` plus local approved
configure flags) and build phases in separate containers sharing this directory.
The parent CMake args must begin `--build /work/build`; a phase cannot start after
lease/cancel admission closes. Previous phases require actual inspected stop evidence.
The storage composition also materializes a verified working source COPY at
`/work/source` for npm/cargo. Their fixed owner args run there; dependencies must be
present offline. Both logs and output publication have explicit byte/count bounds.
The work mount is NOT a filesystem disk quota: scratch growth requires owner volume
quotas or operational disk policy. Free-space admission and bounded published bytes
must not be described as a hard workspace disk ceiling.

## Native Mac adapter — containment BLOCKED

Requires the real dedicated nonroot UID/GID, canonical private staging roots with no
symlink ancestry, a copied input project/workspace, trusted native project approval,
explicit DEVELOPER_DIR, exact expected macOS and Xcode BUILD number, and exact SDK
identifier observed from the selected installation. Destination and unsigned build
flags are explicit; no xcode-select mutation, signing request or automatic dependency
resolution is performed. HOME/TMP/DerivedData/cloned packages/module caches are isolated
per attempt. The storage helper creates fresh staging subdirectories, not original
project edits. Actual offline package contents must be provisioned from approved data;
missing dependencies fail. The native environment is a fixed allowlist.

Node launches and signals a real process group and reads a real process table.
Neither group kill, an empty group, a closed leader nor exit zero proves daemonized,
launchd/XPC or shared build-service descendants stopped. No supported concrete native
containment inspector was found/supplied in this scope. With no `NativeDescendantAttestor`,
stop remains UNKNOWN and the slot stays quarantined even on natural completion.
An injected inspector must independently attest ALL descendants and return the exact
attempt identity with `host-containment-inspect` evidence. No fake inspector ships.
Native CPU parallelism is a build hint; hard native CPU/RAM/PID sandbox quotas and
native network isolation are unsupported. Native projects are trusted only; do not
advertise hostile-code isolation or native hard-stop readiness.

## Journal, supervisor, controller and liveness

`HostJournal` uses one fixed exclusive host slot per provisioned canonical journalRoot,
plus permanent per-attempt journals. File data and parent directory entries are fsynced
before activation. Slot races fail closed; records never authorize re-execution.
Controller and liveness mutexes prevent overlapping HTTP workflows/sequence reservations.
Every outbound command key/operation/request hash is persisted before HTTP. No raw
capability, bearer, environment, source or process output is journaled. Runtime/container
identities and both profile hashes are recorded. Only ephemeral mutex files are removed
on a confirmed terminal path; attempt/sequence/controller history and outputs are retained.
There is no cache/history deletion or automatic stale-lock stealing.

`LongJobSupervisor` requests a 60s lease and renews every 15s. Renewal request start,
not response arrival, anchors the local monotonic expiry. The controller's whole-job
monotonic deadline starts BEFORE claim and includes restore/build/publish time. Requests
and controls have deadlines; cancellation or renewal rejection/loss closes synchronous
physical-start fences and requests real stop. Unknown stop, ambiguous activation/HTTP,
lease uncertainty, restart, or durable-write failure retains quarantine. OS/filesystem/
daemon stalls and an event-loop/host crash cannot be given a physical-stop guarantee.
Use one local durable filesystem and one owner-configured journal root for the host;
separate roots or an unrelated legacy executor do not share this package's mutex.

`BuildWorkerController` is inert until `run(localJob, claimKey, signal?)`:

1. Reserve durable controller intent; refresh enrollment liveness and real census.
2. Claim via `/v1/builds/commands` with `{expectedEpoch,command}` and `{jobId}` body.
3. Validate claimed lineage/fence, then reserve and fsync the runtime marker.
4. Refresh enrollment+census during EVERY lease-renewal cycle; send monotonic renew sequence.
5. Restore and independently verify actual input manifest/file bytes before activation.
6. Inspect physical stop; send exact stopped body including `proofHash`, `confirmed`,
   and REQUIRED `outcome: SupervisorResult.outcome` on normal and fallback paths.
7. Only completed, physically stopped work may publish bound result receipts and stage.
   A stage acknowledgment means `staged-awaiting-verifier`, never verified success.

`pollOnce(claimKey, signal?)` explicitly refreshes idle liveness/census, then reads
`/v1/builds/next` with exactly `{expectedEpoch,profileHash: serverProfileHash}`. An exact
`{ok:true,job:null,source}` response with validated source returns `{state:'idle'}`; a returned job must match the pinned
profile/project and enters the same durable claim/run path. Read errors, cancellation,
busy/quarantined journals and malformed replies never become idle. The lookup has a
10-second bound and retains controller occupancy until ignored cancellation settles.
Successful lookup occupancy spans the full job. No timer/loop/autostart runs at construction,
and no optional autonomous polling loop was added. Server preference ordering is retained.

`NodeBuildTransport` is a concrete bounded fixed-HTTPS-origin implementation for commands
plus `/v1/builds/next` and enrollment heartbeats, with a host credential-REFERENCE resolver,
clean request headers, no redirects/retries/cookies and generic public errors. Request
JSON remains <=70,000 bytes; responses allow <=262,144 bytes with JSON or application
structured-suffix JSON media types, native Uint8Array chunks, <=1,024 chunks, fatal UTF-8
decoding and abort/deadline checks before and after awaited operations and parsing.
The absolute eight-second monotonic budget includes queued time, credential resolution,
HTTP and response cleanup. At most eight request slots are occupied; actual HTTP work
serializes so lease/liveness and stop/stage calls can share the instance. An outward
timeout rejects immediately but keeps its slot until underlying resolver/fetch/reader
work settles. Queued expired work cannot issue late HTTP or return late success; no retry
is substituted. A permanently stalled provider retains occupancy and fails closed.
No credentials are discovered/read from files or environment. It was NOT invoked.
`NodeWorkerLiveness` provides real CPU/RAM capacity checks, fresh toolchain/disk/storage
census, and enrollment heartbeats. It requires owner-confirmed initial enrollment/census
sequence baselines and exact revision/incarnation. Each new sequence is durably reserved
BEFORE HTTP; fresh sequences advance liveness, exact replay never substitutes for freshness.
The parent binds stored census to enrollment revision/incarnation; a successor enrollment
cannot reuse the old revision's fresh census. No Census wire shape was changed here.
Ambiguous responses retain the liveness mutex and require owner reconciliation.
The CPU-only observer rejects nonempty GPU identities until real GPU observation exists.
Only this host-controlled sequencer may own that enrollment revision; an existing external
heartbeat writer must not race it. No idle daemon/poller/service is started here; the
parent must drive idle census updates and scheduling. Owner worker preferences remain
server policy; no machine-name scheduling rule or changed claim body exists here.

## Real storage composition and receipts

`createStorageWorkerPorts` / `createStorageBuildWorkerController` (the `/storage` entrypoint)
call the actual sibling exports `materializeLocalSnapshot`, `collectOutputs`, and
`writeResultManifest`. There are no stand-in restore/publish implementations.
The reader verifies approved manifest/chunk SHA-256, size, generation-bound ObjectRef,
project binding and actual CAS receipts before invoking the real materializer. Fresh
attempt directories are exclusive and partial failures are retained. Snapshot shape is
EXACTLY sibling `InputSnapshot`: version/project/files/requiredInputs/missingInputs/git/
historyEvidence, with each file's whole hash/size/chunks/localChunks/mode. `snapshotHash`
is the hash of the manifest BYTES; no invented `snapshotHash` JSON field is required.
Selected source/history originals are never moved/deleted, and no new history attestation
is fabricated. The approved snapshot and CAS must use the compatible actual local-ref
format; incompatible local refs fail explicitly. Undeclared files, symlinks and special
input files are rejected before execution.

The real collector writes output/log chunks and the real publisher supplies actual grant
and generation receipts; the integration reads back real local CAS bytes using the actual
returned refs. `verifyPublish` requires the COMPLETE approved output path set, rejects
path collisions, verifies ordered per-file/archive chunks and combined SHA-256/size, and enforces
at most 31 chunks across all output chunks and logs, <=1MiB per object,
and <=profile budget total output/log bytes. Portable profiles accept 1..24 required
outputs and <=7MiB for ALL output/archive/log bytes together. One additional <=1MiB
result manifest means at most 32 result grants and <=8MiB namespace admission. These are
domain ceilings, NOT a claim of empty namespaces, available headroom or guaranteed
reservation success. Existing grants/objects, prior attempts, snapshots and other
retained evidence may occupy capacity. Real reserve/assertCurrent must admit actual
current state before writes, otherwise publication rejects without eviction or reset.
Captured runtime logs are written
exclusively into workRoot under the real tree seal; nothing is fabricated for empty logs.
Each output requires `format`: exact approved paths ending in .app/.dSYM/.xcarchive
require `tar`; ordinary file paths require `file`. The sibling collector's deterministic
bundle tar bytes are verified through the SAME ordered chunk hash/size checks; packaging
does not prove app behavior, signing, native containment or any unstated provenance.
Suffix matching is case-sensitive, exactly as in the parent result contract. Other
directory types and empty ordinary files remain unsupported by this runtime receipt path;
parent support for a broader state is not a claim that this adapter supports it.

`BuildWorkerController` additionally requires explicit immutable host pins
`{environment,authorityId,workerId}`. Claimed `workerId` must match the pin. After claim validation it
brands/freezes a nonsecret `BuildAttemptContext` and passes it to
`publishResult(job,plan,result,context,signal)`. Its actual `ComputeBinding` contains the
pinned authority/worker IDs, claimed attempt as lease/attempt ID, job as workload ID,
claimed epoch/generation/incarnation, and SHA256 of the UTF-8 capability STRING (not
hex-decoded capability bytes). Server and local recipe hashes remain separately pinned.
The context also retains the actual validated claim `source`; compute.authorityId is
taken from that validated response, not supplied as an unchecked local self-assertion.
The raw capability stays confined to fenced command transport and is never placed in
this context, artifacts, public receipts or journals.

`StorageWorkerConfig.authority` supplies those same pins to the composed controller.
`resultScope(job,plan,context,signal)` receives this branded claim context directly and
must supply real namespace/principal policy metadata. The storage helper rejects any
returned compute object that differs in ANY field from the supplied binding before
collection/publication. The existing real issuer/current-observer/capacity ports still
validate actual grant and policy receipts. No worker-side owner credential or
owner-authenticated `/v1/builds/fence` lookup is required or performed. Generic runtime
`approveRecipe` accepts output budgets through 134,217,728 bytes (128MiB);
`approveParentProfile` separately enforces the wired portable BuildProfile ceiling of
7*1048576 bytes (7MiB) and 24 required outputs. Neither the old 16MiB local ceiling nor a
portable 128MiB publication promise is present.

Final wrapper-source binding fix: `/v1/builds/commands` and `/v1/builds/next` responses
must contain exactly `source:{environment,authorityId,epoch}` matching owner environment,
authorityId and expectedEpoch. `send()` snapshots response JSON and checks actual source
BEFORE writing command acknowledgment or accepting claim/renew/stop/stage results.
`pollOnce()` checks source before accepting a job or idle; next replies now have exactly
ok/job/source. Missing, bare domain-core, malformed or mismatched source fails closed.
No locally manufactured source substitutes for the response.

Constructor contract: `BuildWorkerController(binding, expectedEpoch, ports, adapter,
maxInputBytes, authority)` retains that argument order but authority now REQUIRES
environment as well as authorityId and workerId. `NodeLivenessConfig.authority` and
`StorageWorkerConfig.authority` require those same immutable pins. Node liveness validates
the direct census commands reply source before durable census acknowledgment. Its
`WorkerLivenessPort.refreshLiveness(activeJobs, signal)` returns the ACTUAL validated census
source as `Promise<Readonly<BuildResponseSource>>`; controller validates that source again
before claim or lease renewal. Enrollment heartbeat keeps its existing status binding;
the heartbeat route does not return or fabricate a builds-wrapper source. Storage
composition additionally rechecks the branded context source against environment/authority
pins and the compute epoch before publication. No new current-authorization implementation,
default-success provider, owner credential flow, or live probe is introduced.

Concrete remaining host configuration (no fake defaults): canonical dedicated account,
base/journal/cache/CAS roots and sufficient disk; approved server profile hash and local
recipe config/image binaries; local Docker config/socket or actual Xcode installation;
fixed HTTPS origin/credential reference resolver; authoritative enrollment identity and
sequence baselines; explicit environment/authority/worker ID pins; authenticated input-manifest/chunk reader; real publication writer,
grant issuer/current-authority observer, namespace capacity reservation, exclusive managed
tree seal and local CAS; real result GrantScope; complete output classifications. Native
containment is additionally BLOCKED as above. No Cloudflare auth/authority is implemented
inside the runtime. Parent must validate origin, credential scope, grants and server epoch.

## Read-only discovery and storage inventory

`discover`/`discoveryCli` inspect explicitly selected Xcodes with version/build-number and
SDK observations plus free disk; `discoverCensus` exports exact SDK identifiers, OS/arch,
available RAM and real observations. None was invoked. The discovery CLI accepts only
explicit `--root` and `--developer-dir` inputs and never changes developer selection.

`managedStorageInventory` traverses only supplied approved host roots with bounded entry,
depth, duration and root counts. It streams directory entries, reads metadata only,
requires owned protected entries, and rejects symlinks, special files, file hardlinks,
nested mounts and observed mutations. Partial scan observations include apparent FILE
bytes and allocated blocks (512-byte units) separately; missing roles/failed/limited
scans yield null totals and incomplete status. These are neither APFS reclaimable nor
exclusive physical bytes (clones/compression/snapshots can change that relationship).
`observedAt` and source describe the actual scan; completeness means traversal coverage,
not an atomic guarantee against a trusted owner changing trees afterward.

Node liveness fills mandatory `Census.storage` from actual scans. Verified empty cache
can report zero; unknown cache never becomes zero. New admission requires complete scan
and cache <=20GiB; there is NO eviction. Active builds continue lease renewal while
reporting honest incomplete observations. Census carries no invented freshness timestamp;
the authority owns census observation time. The full inventory includes source/time for
parent UI display. UI code is outside this package's ownership and was not changed.

## Static review findings and RTD evidence

Structure: reviewed package exports, owned file inventory and source call graph. Type-only
parent contracts and the explicit optional storage composition are separated.
Content: reviewed recipe branding, dual hashes, shell-free phases, exact SDK matching,
real manifest format/chunk contract, durable sequence/request identities, stop/outcome
command bodies and fail-closed paths. Fixed obsolete single-artifact receipt handling,
unconfigured CMake build-tree behavior, lack of host-visible Linux outputs, omitted
long-job enrollment refresh, and missing stopped outcome while authoring this source.

Compilation: DEFERRED pending approval. No compiler/typecheck/build was invoked.
Runtime Integration: DEFERRED pending approval. No imports/probes/processes/HTTP were run.
User Journey: DEFERRED pending approval. No claim/build/restore/publish/stage was exercised.
Deployment: DEFERRED pending approval. No service/account/cloud state was changed.
Static review is not proof of compilation, physical containment, cloud storage semantics,
or end-to-end wiring under real credentials. Native containment remains BLOCKED. Explicit
owner reconciliation must inspect actual surviving processes/containers and retained
journals before authority reconciliation and any local mutex release; automatic replay,
cleanup and release-by-expiry are intentionally absent.

## Final handoff and explicit holds

Assigned source/interface/docs edits end with this receipt. No background work or
automatic continuation remains; parent owns subsequent source-hash freezing.

- Native-attestor HOLD: no supported concrete descendant containment inspector exists
  here. Unknown stop, including native exit zero without an attestor, retains quarantine.
- Current-authorization HOLD: host actual-current grant/policy/namespace providers still
  require the parent's evidence and approval. Interfaces and receipt validation do not
  establish that those live providers are configured or correct. No default success ships.
- Project-scale HOLD: portable 7MiB/24-output/31-chunk ceilings and actual namespace
  occupancy may reject real projects. Generic runtime 128MiB, bundle byte packaging and
  filesystem inventory are not project-scale readiness or available-capacity proof.
- Compilation, runtime integration, user journey and deployment remain DEFERRED pending
  explicit approval. No tests, probes, imports, builds, typechecks, runtime/network actions,
  live modifications or new feature expansion were performed for final handoff.
