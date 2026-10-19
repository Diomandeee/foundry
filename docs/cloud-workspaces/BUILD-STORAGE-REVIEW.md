> Historical initial source checkpoint. For current broker, v2 input, reservation, runtime integration and native HOLD changes, read [the 2026-10-18 continuation](continuation-2026-10-18/README.md). Statements below describing unimplemented project segmentation or broker host wiring are superseded by that source receipt. Runtime validation remains absent.

# Build storage source review

Status: implemented source, static review only. No tests, build, typecheck, imports,
installation, service invocation, cloud request, spend, credential retrieval, Git
operation, or cleanup was performed. No runtime/provider success is claimed.
Only `packages/build-storage/` and this document were written by this worker.
Parent contracts, authority, authentication transport and operator integration are
owned by the parent/other workers and were read without modification.

## Controller API

Import from `packages/build-storage/src/index.ts` (or the package export):

```ts
const collected = await collectOutputs(request, privatePackagingPorts, signal);
const staged = await writeResultManifest({
  jobId, attemptId, inputHash, profileHash, exitCode, collected,
}, privatePackagingPorts, signal);
// Parent authenticates/fences the separate stage command using staged.artifact.
```

`CollectOutputsRequest` contains `root: {path, uid}`, the approved `profile`, a
host-selected `scope`, and explicit `outputs`/`logs` selections. Each selection is
`{path, classification}`. Scope is `{projectId, principalRef, compute, namespaceRef}`;
compute is the actual current broker `ComputeBinding`, including capability digest
but never a raw build capability or credential. Do not accept scope/roots/providers
as worker-selected authority. Output selections must cover all exact approved profile
paths. Logs are separately host-approved file selections; no glob/archive traversal.

Output shape matches the coordinated parent contract:

```ts
{path: string, format: 'file'|'tar', sha256: string, sizeBytes: number, chunks: ArtifactClaim[]}
```

Chunks are ordered, nonempty, at most 1 MiB each. Whole-file digest and size are
computed from actual bytes. The WIRED reviewed pilot permits profiles with at most
7 MiB `maxOutputBytes`, 24 required output paths and 31 total artifact chunks across
outputs plus logs. Generic `MAX_TOTAL_BYTES` (128 MiB) and `MAX_CHUNKS` (128) remain
primitive ceilings, not accepted collector profile limits. `PILOT_LIMITS` exposes
the wired bounds. Parent result syntax still allows up to 64 log claims, but nonempty
log chunks share the stricter 31-chunk total. All output/log bytes, including tar
overhead, count against `profile.limits.maxOutputBytes`. Preflight rejects excess before
publication; no truncation. Empty files retain SHA-256(empty), size zero and empty
chunk arrays; no zero-byte cloud/local CAS object is created for their contents.
Empty logs remain identifiable in retained file lineage although `logs` has no claim
for them. The updated parent validator permits size-zero outputs with empty chunk
arrays. Collector hashing supplies SHA-256(empty); manifest staging retains that
representation and publishes only the nonempty manifest, never a zero-byte chunk.

Required outputs are checked as a complete exact set in both directions, with unique
selected and profile paths, before the seal, `capacity.reserve`, CAS or cloud calls.
Missing, extra, duplicate and aliased paths fail preflight; reordered exact sets pass.

### Approved Xcode bundles

Exact, case-sensitive `.app`, `.dSYM` and `.xcarchive` output suffixes REQUIRE
`format:'tar'` and an actual directory. Every other output requires a regular file
and `format:'file'`; logs remain regular files. No directory is passed off as a file
digest. The UI/download owner must append `.tar` when serving a tar output.

The in-process tar writer inventories the entire explicitly approved bundle before
capacity reservation/publication. It rejects symlinks, hardlinked regular files,
special files, cross-device entries, wrong ownership, writable-by-others paths,
escape paths and case/Unicode sibling collisions. The combined selection is capped
at 20000 entries INCLUDING directories and ordinary outputs/logs (a conservative
bound on 20000 files). Input snapshot pilot limits are unchanged. No shell, tar
command, subprocess, archive library or provider invocation runs during construction.

Archive entry ordering is bytewise UTF-8. The root is the selected bundle basename;
all descendants use relative paths below it. Deterministic POSIX PAX path records
support UTF-8 and long names within the existing 512-character source-path policy.
Headers use uid/gid/mtime zero, empty owner names, normalized directories 0755 and
regular files 0755 when executable, otherwise 0644. No symlink/hardlink/PAX link
entries, absolute names, parent components, device nodes, xattrs or cleanup actions
are emitted. Empty files and directories are included. Original source is unchanged.

Exact planned archive size includes all PAX/USTAR headers, 512-byte data padding and
two EOF blocks. That size, plus all other outputs/logs, must fit the approved profile
budget (wired pilot maximum 7 MiB), and all artifact chunks must fit the shared 31-chunk
limit. Excess entries or archive overhead fail before cloud publication. The stream
coalesces into <=1 MiB chunks rather than publishing each small entry separately.
The output's SHA-256 and size cover ACTUAL serialized tar bytes, including headers
and padding, and the writer verifies each actual chunk by pinned byte readback.
Directory membership/stats and regular-file bytes/EOF are rechecked under the host
seal. `OutputLineage` retains the root classification and required `format`; nested
debug symbols within a retained archive are kept as archive contents.

No signing or extraction validation was executed. Bundles containing framework
symlinks fail closed under the explicitly requested no-symlink policy. Tar does not
preserve macOS extended attributes/resource forks, ACLs or original ownership/time;
operator acceptance of the resulting bundle remains a deferred parent gate.

`writeResultManifest` validates the parent result shape, stages canonical bytes in
the real local CAS, then publishes a <=1 MiB manifest and obtains an actual current
grant. Existing shared canonical JSON limits are stricter: 262144 serialized bytes,
16384 nodes and depth 16. Those bounds fail closed. It returns `manifest`, `artifact`,
`local`, `lineageLocal`, and `receiptLocal`. The last local record binds manifest
claim, job, attempt, input/profile hashes, compute fence, reservation and retained
file lineage. Collection identity is private and same-process; one manifest attempt
per collection prevents repeated consumption of its capacity reservation. After an
ambiguous failure, reconcile retained evidence rather than replaying publication.

## Trusted interfaces and providers

- `TrustedWriter`: create-only `write(projectId, kind, bytes, signal)` returning a
  real verified `ObjectRef`.
- `createGcsWriter(config, GcsWritePorts)`: fixed GCS origin, host bucket/project,
  opaque credential reference, private token lookup and injected streaming fetch.
  POST uses `ifGenerationMatch=0`. Creation response metadata is bounded and checked,
  then the existing private `createGcsReader` independently reads actual bytes with
  generation/metageneration preconditions. Digest, size and exact ref must match.
  A 412 only permits metadata discovery followed by the same pinned byte verification;
  it does not manufacture a success receipt. No overwrite, delete, list, SDK, retry,
  signed URL, ambient token, global fetch, token logging or token output. Provider
  exceptions are sanitized. Two active writes maximum (or a smaller configured read
  limit), deadline/abort propagation, bounded metadata and chunk buffers; slots remain
  occupied while an uncooperative provider has not settled.
- `TrustedGrantIssuer`: private `issue`, `observeCurrent`, `now`. `issue` MUST call
  the real approved broker issuance path and return its actual `ReadGrant` receipt.
  Package verifies object, principal, project, GET, policy fields, byte budget, full
  compute binding, current observation, revocation and expiry. It generates no grant
  IDs, object generations or authorization receipts. DI is a host trust boundary,
  not cryptographic proof that an arbitrary callback is honest.
- `TrustedPublicationCapacity`: host-fence-bound durable `reserve` and `assertCurrent`. Publication
  reserves all chunks plus one manifest and up to 1 MiB manifest overhead before
  writes. Parent must admit against the actual namespace's remaining durable grant,
  read and byte limits and bind consumption to the reservation/fence. The default
  broker is still 32 grants / 8 MiB stored / 1 MiB per read. Collector preflight checks
  at most 31 chunks plus one manifest (32 grant slots) and at most 7 MiB artifact bytes
  plus 1 MiB reserved manifest overhead (8 MiB requested capacity). The actual durable
  namespace may already contain grants, stored/read bytes or reservations: admission
  MUST refuse insufficient REMAINING capacity before any publication. Arithmetic
  against the hard maximum does not prove capacity is available. The package neither
  expands limits nor creates/rotates namespaces or falls back to another namespace.
  Larger profiles are rejected even if a custom capacity adapter would accept them.
  All-empty file selections still
  reserve the nonempty manifest. Import reserves the manifest first, then the bounded
  chunk set after reading its schema; admission must account for cumulative usage.
- `ManagedTreeSeal`: required host implementation of exclusive tree access for the
  entire callback, covering concurrent writers, renames, ancestors and mounts. Must
  support nested access to a separate CAS root without deadlock. Roots must be distinct,
  dedicated and preprovisioned. No default seal or assumed success implementation.
- `createLocalContentStore(root, seal)`: real create-only on-disk CAS, <=1 MiB per
  object, file and directory fsync, byte readback, verified existing-object reuse.
  Local refs are `{kind:'local-cas', sha256, sizeBytes, relativePath}`; they contain no
  fabricated GCS generation or grant ID. Directory enumeration is bounded to 4096
  entries. No in-memory provider fallback or automatic recovery/deletion.

Construction only validates data and captures ports. No factory contacts a provider,
gets a token, touches disk, creates a database or starts a timer until an operation is
explicitly called. Private host adapters must honor AbortSignal and bound transport
allocation; no claim is made that JavaScript can force an uncooperative provider to stop.

## Input snapshots and local recipes

`packageInputSnapshot(request, ports, signal, optionalHistoryAttestor)` reads only
explicit approved source/history files and produces a byte-addressed manifest, actual
remote chunk claims, local chunk references, modes, SHA-256/size, required/missing
input paths and Git metadata supplied by the owner. It performs no Git operation or
implicit repository scan. Empty source files, including `.gitkeep`, are preserved.

Generic input snapshot primitives support 1–128 selected input files, at most 128
nonempty chunks and 128 MiB of input bytes; all-empty selected files are supported.
Those structural ceilings do not establish wired namespace capacity. Input publication
still reserves chunks plus a manifest and manifest byte overhead against the actual
namespace; the wired 32-grant/8-MiB namespace must reject requests exceeding its
remaining capacity. The reviewed output pilot is limited to 7 MiB/24 paths/31 chunks,
not general project archive capacity. There is
no segmented manifest implementation for larger source trees. This is NOT evidence
that the parent's unknown project estate, or all 585 projects, is buildable.

Returned `approval` is a candidate with `reconstructable:false` ALWAYS. Absence of
known missing paths does not establish dependency/asset completeness. Parent must
record a separate owner-reviewed completeness evidence reference bound to the exact
snapshot manifest SHA-256/ref, then explicitly approve a new input record and recompute
its authority input hash. Returned `inputHash` hashes the false candidate only.
There is no submitter-controlled approval boolean in this API.

Git history is never removed. `historyPreserved` defaults false; optional trusted
history attestation requires a real local evidence reference that is read from CAS.
It does not authorize input completeness. That evidence reference is local; parent
must separately preserve/transport history evidence if required across hosts. Source,
Git metadata, history files and recipes require host secret review before publication;
the package is not a secret scanner or proof that an owner-selected file is safe.

`populateLocalSnapshot({manifest, snapshotHash, scope}, importPorts, signal)` is the
concrete remote-to-local bridge. It resolves new actual current grants with the private
issuer, reads manifest and every nonempty chunk through `TrustedSnapshotReader`, checks
the actual generation/ref, exact size and byte digest, observes current grant state
again after reading, verifies ordered whole-file hashes, and populates the real CAS.
Serialized old grant IDs are never replayed. `SnapshotImportPorts` requires `local`,
`issuer`, `capacity`, `reader`. `TrustedSnapshotReader.readArtifact` must be an actual
principal/fence/namespace-authorized broker read, not a metadata or fabricated-ref
adapter. The bridge returns `{snapshot, local}`; empty files need no chunk grant.

`materializeLocalSnapshot(localRef, inputRoot, localStore, seal, signal)` validates
snapshot bounds and creates directories/files exclusively, verifies each local chunk,
whole-file digest and final file readback, and fsyncs. It never replaces source/history.
On failure partial evidence remains and the parent must quarantine the destination.
Byte reconstruction alone does not authorize a build or assert completeness.

`storeLocalRecipe(profile, localStore, signal)` validates and stores inert canonical
profile bytes and returns its actual local ref/profile hash. It never approves or
executes the recipe, resolves dependencies or discovers a toolchain.

## Filesystem review and remaining host work

Checks reject relative escapes, backslashes, colon/control/invalid-surrogate names,
trailing dots/whitespace, oversized components, selected file/directory conflicts,
case/Unicode normalization aliases (NFKC plus case folding) and colliding sibling
names. Explicit filesystem names must match. Every ancestor is lstat checked: no
symlink, wrong owner or group/other write. Selected files are regular, single-link,
same-device files; nested mounts, special files and non-bundle directory selections
are rejected. Approved bundle directories are inventoried under the same owner/device
rules. Reads use O_NOFOLLOW/O_NONBLOCK, fixed-size chunks, inode/device/mode/
size/time checks and an extra EOF probe. Portable Node has no openat-style traversal
here; these checks REQUIRE the real host exclusion seal to prevent adversarial
ancestor swaps, same-UID mutation and concurrent mount changes. Bundle inventory
allows up to 20000 sibling entries within the shared tree cap; ordinary file/CAS
enumeration retains its 4096-entry limit. Filesystem-specific
alias semantics beyond the conservative name policy remain a host acceptance check.

Signed archives/app bundles and debug symbols require explicit retained classifications;
debug symbols nested inside archives take precedence when individually selected.
Approved bundle roots are packaged as described above; arbitrary directories remain
rejected. No automatic signing, archive extraction, stripping, pruning or cleanup exists.

Parent still owns authenticated transport, current namespace routing/admission, broker
issuance/read adapters, stopped-process containment/exclusive-tree seal, owner
completeness evidence, project-scale segmented input snapshots, dependency/asset
policy, durable retry/reconciliation, independent verifier integration, operator UI,
and all runtime/deployment gates. Local CAS paths must remain separate from source,
history and build outputs, and host disk capacity/retention must be provisioned.

## RTD receipt

| Layer | Receipt |
| --- | --- |
| Structure | STATIC: package entry/config, exports and dependency source shapes reviewed |
| Compilation | DEFERRED: explicitly prohibited; no typecheck/build/import execution |
| Integration | DEFERRED: no authenticated/broker/filesystem/provider calls executed |
| Content | STATIC: contracts, byte bounds, actual-ref lineage and failure paths reviewed |
| User Journey | DEFERRED: parent controller/operator flow not exercised |
| Deployment | DEFERRED: no service/cloud/release action authorized or performed |

Exact changed files: `packages/build-storage/package.json`,
`packages/build-storage/tsconfig.json`, `packages/build-storage/src/index.ts`,
`packages/build-storage/src/types.ts`, `packages/build-storage/src/checks.ts`,
`packages/build-storage/src/filesystem.ts`, `packages/build-storage/src/tar.ts`, `packages/build-storage/src/gcs-writer.ts`,
`packages/build-storage/src/local-store.ts`, `packages/build-storage/src/publication.ts`,
`packages/build-storage/src/packaging.ts`, `packages/build-storage/src/snapshots.ts`,
and `docs/cloud-workspaces/BUILD-STORAGE-REVIEW.md`.
