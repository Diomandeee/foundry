# Foundry fleet project library — local implementation candidate

This bridge connects the delivered fleet source archives to a project browser and explicit local pulls. Its source is in the Foundry repository. It does not replace the transactional `packages/library-catalog` authority, enroll projects into that authority, publish snapshots there, attest compute leases, promote canonical revisions, or consult the merge gate. The fleet index is a browse/read model of source-copy receipts.

## Current state

Implemented locally, source-reviewed, **not runtime-validated**. No software tests, builds, browser session, restore trial, service start, remote client installation, cloud upload, provisioning or credential operation was performed for this change. The catalog was actually assembled and packaged from existing transfer manifests; that is data processing, not evidence that the new client works end to end.

Current catalog revision: `47c1a94efec4584c69f5aaec4856e40c3789e80de555eb878e12976d11e1f127`.

The actual output is at:

`/Users/mohameddiomande/Documents/Codex/2026-10-15/ran-command-inventory-review-package-contents/foundry-project-library-2026-10-17/catalog-r3/`

| Observation from assembly | Count |
| --- | ---: |
| Delivered distinct machine/path records | 146,743 |
| Project/directory entries | 585 |
| Entries with delivered source | 457 |
| Inventory entries without delivered source | 128 |
| Preserved source-copy versions | 589 |
| Entries with a suggested starting copy | 419 |
| Entries requiring an explicit version choice | 38 |
| Held/unavailable paths across the source estate | 535 |
| Referenced source archives | 10 |

These are catalog counts, not a claim of 585 unique applications. Nested repositories and four uncatalogued directory collections are visible. Parent project copies retain their nested source; the same delivered path can therefore appear in multiple browse views without another cloud upload. Name-only families remain provisional. Held counts within parent/child project views can overlap; the estate total remains 535.

## User flow

The Operator desk now has a Projects section linking to `http://127.0.0.1:9148/`. That link does not start a service. Once separately activated on a Mac, Library shows the same reviewed catalog revision and project grouping on every client. Search, inspect a project's versions and differing/unique paths, then choose a version to pull to that Mac.

The browser calculates a destination under its configured workspace directory from project title and version identity. It never accepts a browser-supplied destination path. Restored workspaces contain `.foundry-workspace.json` identifying project, catalog revision, version and archive generations. Library recognizes those receipts when displaying a project on that Mac; recognition does not prove that subsequent local edits are unchanged. Existing destinations are refused, even when empty. There is no automatic overlay, deletion, merge, editor launch or execution of restored files.

A suggested version contains every observed path in the grouped copies with matching SHA-256 and permissions. Stable member order breaks identical-content ties. This is neither timestamp-based selection nor canonical promotion. Where no such superset exists, selection remains explicit; alternatives are retained. Captures are assembled from directory reads, not filesystem-atomic snapshots. The current assembly observed zero paths changing between supplemental captures.

## Files and responsibilities

| File | Responsibility |
| --- | --- |
| `build_catalog.py` | Match source catalog and per-archive manifests to transfer hashes; group proposal members; preserve uncovered files; materialize project comparisons and content-addressed detail files |
| `common.py` | Catalog/detail/version hashes; relative path, permissions, size and macOS case/Unicode collision validation |
| `cloud.py` | Read-only generation-pinned GCS downloads, verified local cache, optional existing-SSH read-through via Mac1 |
| `pull.py` | Stage selected files, resolve internal archive hardlinks without extracting links, verify SHA/size, fsync and publish by atomic no-replace rename |
| `bridge.py` | CLI list/show/pull and loopback browser/API; one browser pull at a time |
| `web/` | Search, versions, differences, held coverage, captured path browser, pull and local workspace receipt display |
| `package_catalog.py` | Produce a portable immutable catalog package plus a clearly unpublished descriptor |
| `sync_catalog.py` | Fetch a genuinely published pinned catalog package into a new local revision directory; reject prepared templates |
| `ssh_reader.py` | On-demand Mac1 helper: stream only scoped GCS bytes; no daemon or credential forwarding |
| `readiness.py` | Revision-bound input/dependency/held declarations and explicit lineage; always unknown or incomplete, never build-ready |
| `snapshot.py` | Explicit CLI-only local content snapshot against a selected base; atomic no-overwrite directory publication, no upload |
| `snapshot_policy.py` | Explicit added-file selection, protected-path rejection and bounded conservative source-content screening |
| `broker_reader.py` | Independent credential-reference DI client for existing scoped broker grants; fails closed for fleet archives |
| `bounded_http.py` | Concrete default one-shot stdlib HTTPS transport in supervised spawn children; bounded private-pipe response and acceptance deadline |
| `chunk_package.py` | Explicit local chunk preparation, segment requirements and reviewed remaining-capacity planning; never cloud publication |
| `chunk_reader.py` | Published pinned package validation and actual granted manifest/chunk reassembly into existing verified archive cache |
| `cache_budget.py` | 20 GiB shared cache admission, bounded metadata inventory, exclusive directory locking and read-only storage observations; no cleanup |

## R2 source extensions (not executed)

`--readiness-metadata FILE` is an optional global CLI argument, before the subcommand. Supply only an explicitly operator-approved, nonsecret JSON declaration. One declaration applies to one catalog/project/version; other versions remain unknown. The bridge validates the binding and calculates `metadataSha256`; it does not validate approval authority or elevate an `approvalRef` into a grant. Fields are:

```json
{
  "format": "foundry.reconstructability.v1",
  "catalogRevision": "<full catalog SHA-256>",
  "project": "<exact project id>",
  "version": "<full version SHA-256>",
  "approvalRef": "<opaque nonsecret operator approval reference>",
  "lineage": {"repositoryId": "<opaque repository identity>", "revision": "<explicit 40 or 64 hex revision>"},
  "requiredInputs": [{"path": "relative/source/path", "sha256": "<full content SHA-256>", "bytes": 123}],
  "dependencies": [{"id": "<opaque dependency id>"}],
  "heldMissing": [{"path": "relative/missing/path", "reason": "held-by-source-policy"}]
}
```

`lineage` may be null; neither a name nor a timestamp nor an origin URL is used to establish lineage. Required input hashes and sizes are compared to verified catalog entries. Dependencies remain unknown until parent-owned build contracts and durable authority establish their availability. Empty lists, no held paths, or a suggested version never establish readiness. CLI `show` and the project detail UI expose this conservative assessment without modifying the catalog/version hashes. Existing catalog distributions need no repacking.

Prepared CLI shape for separately approved local capture (not run here): `bridge.py --catalog CATALOG snapshot PROJECT --version BASE_VERSION_SHA --workspace EXISTING_WORKSPACE --destination NEW_SNAPSHOT_DIRECTORY --include-new src/new-file.py --include-new docs/new-note.md`. `--include-new RELATIVE_PATH` is repeatable and optional, naming one known added regular file each time, never directories, recursion or globs. `snapshot(..., metadata=None, include_new=None)` exposes the same local interface. Explicit additions must be absent from the selected base, distinct and free from case/Unicode or file/directory collisions; at most 1024 added files are allowed. Missing explicitly included files fail closed. Missing base files are recorded as deletions. The capture visits only base paths and named additions, with no automatic workspace/unknown-file/history scan. Other local work stays outside the selected capture and is untouched.

The destination parent must already exist and be outside the source. Before any `mkdtemp`, the code compares the source root's **device/inode identity with every existing destination ancestor**; case-insensitive or Unicode filesystem aliases cannot evade the ordinary ancestry check by spelling the workspace differently. This is rechecked immediately before staging. A matching `.foundry-workspace.json` base receipt remains required. Selected file opens anchor every directory component with `O_NOFOLLOW`, check root identity and current-user ownership, reject unsafe write permissions, links, privileged/special files and hardlink aliases, and compare metadata before/after capture. System ancestors must be root/current-user owned; selected workspace directories/files must belong to the current user.

The conservative fallback policy rejects protected history, Git stores, credential stores, environment/key/credential-shaped names **before opening source content**. No reusable copy-policy filter was found in the inspected source paths. Candidate source is limited to UTF-8 text with no binary/control payload, at most 4 MiB per file and 4 GiB total; this applies to both base and added files. One candidate is buffered and screened in memory before any of its bytes reach staging, using whole-text private-key, token/bearer, sensitive assignment, credential-URL and opaque-literal patterns. Denial emits no matched value, path, line, snippet or digest; rejected content is not written to a partial file or manifest. Known credential-store paths are refused before opening, and no actual workspace/credential content was read in this implementation session. This pattern policy can have false positives and cannot prove the absence of arbitrary, encoded or unknown secrets. There is no bypass flag; operator source review and publication approval remain required. Binary/large source files and protected history are held rather than silently included.

The new directory contains `content/`, `manifest.json`, and `publication.prepared.json`. The manifest binds the full catalog revision, base version, base-entry digest and every captured file's full SHA-256/size/mode. Entries carry `change: added|modified|unchanged`; `includedNewPaths`, `addedEntries`, `changedEntries`, and `deletedPaths` are all included in the manifest digest. `sourceSelection` explicitly records selected base-plus-added source, not a complete workspace backup. Files/directories become read-only and existing atomic no-replace publication is reused. This is application-level immutable evidence, not OS-enforced WORM storage. Input capture is stat-checked, not a filesystem-atomic source snapshot; stop writers first. Source permission/owner checks and credential screening do not attest build readiness or authority. No upload, overwrite or deletion occurs; a failed stage retains only previously accepted source files. Arbitrary concurrent same-user namespace tampering remains outside the single-OS-user trust boundary.

The publication descriptor is always `prepared-not-published`, with `publicationAuthorized: false` and `object: null`. It has no fabricated cloud generation or latest pointer. No snapshot has been created during this implementation. Browser snapshot creation/listing and save-back/upload are unsupported and explicitly stated in the UI.

`BrokerReader(endpoint, credential_reference, resolve_credential, binding_for, cache, bounded_transport=None)` can be passed directly to `restore`; an embedding host can supply `serve(args, catalog, reader_factory=...)`. Explicit trusted-host construction defaults to concrete `BoundedHTTPTransport(endpoint)`; a reviewed alternate transport may be injected. Construction/import does not start a child or contact the broker. There is no browser activation flag or browser-supplied endpoint/credential/transport. This path never constructs the gcloud/SSH login flow. The credential reference stays an opaque in-process DI handle, with an approved resolver supplying an existing executor bearer only in memory (32–8192 characters). No automatic secret resolver, credential files, copied credentials, SDK, login or grant issuance is added. The HTTP body remains exactly `{grantId, requestId}`. `binding_for` must independently resolve the already-issued grant to the exact expected bucket/object/generation/SHA/bytes and stable replay identities; client/catalog fields cannot create authority. Cached reads still reenter authenticated broker checks. SHA/size validation completes in a <=1 MiB memory buffer before any broker body is written to cache/staging. Browser responses expose neither host paths nor credential values.

`BrokerReader.stream_to(reference, stream, deadline=None)` accepts an absolute monotonic deadline, capped to 30 minutes from entry. `ChunkReader` passes its one absolute reassembly deadline through every manifest/chunk read. The reader performs <=64 KiB response reads, passing the same deadline and freshly computed remaining per-operation timeout (capped at 30 seconds), with before/after checks. `max_response_bytes` is the **exact expected size**, including exact 1 MiB chunks; the child privately probes one extra byte to refuse oversize and never returns a body over 1 MiB. A socket timeout by itself is not treated as an absolute bound.

The concrete stdlib transport creates a multiprocessing **spawn** worker only for one configured HTTPS POST. Secret headers travel after a ready handshake through a private in-memory `Pipe`, never worker argv/env, files or logs. The child uses `http.client` with the default TLS context, no proxy discovery, redirects, retries or debugging, and bounds the returned body to the exact requested size <=1 MiB. Returned headers are a small allowlist; non-200/redirect bodies and raw exceptions are not returned. Parent private-pipe reads/writes are nonblocking and framed/bounded (64 KiB request packet, 2 MiB response envelope), with monotonic poll/wait checks; a readiness event never triggers an unbounded `recv_bytes` call. The parent accepts a buffered response only after the owned worker is confirmed dead with a successful exit **before the absolute deadline**.

On timeout/error, only that supervisor-owned worker is terminated, then killed if necessary, with bounded 0.25-second joins for each stage. Late response bytes/success are refused. Unconfirmed startup/stop remains tracked and occupies capacity; the client never labels that state stopped or creates replacement capacity to hide it. At most two supervised HTTP workers per parent process can occupy slots, shared across transport instances; slots release only on confirmed death. Standard multiprocessing may also use its own interpreter resource helper; this is a two-HTTP-worker bound, not a quota for every OS process. Buffered `read/close` enforce the pinned deadline and have no live child behind them. No installed daemon or SDK is introduced.

Default supervisor support is limited to unfrozen Python 3.10+ on macOS/Linux, with a trusted import-safe file entrypoint for spawn. Interactive/frozen/other platforms and reuse after parent fork fail closed; host code must guard its executable entrypoint. Kernel/process-start/scheduling stalls cannot be universally preempted, and failure shutdown can consume its bounded cleanup window after expiry; no accepted late success, universal OS return-time bound or physical provider-stop receipt is claimed. Current authorization, native attestation, durable authority and project-scale runtime acceptance remain **parent-owned HOLD**. No transport, child process, capture or validation was executed here.

**Fleet activation gates:** `workers/library-broker` accepts existing grants only, with 1 MiB/read and 8 MiB cumulative reserved/sealed payload capacity, plus 32 lifetime grants and 128 lifetime reads. Whole fleet tar.gz objects (and the existing approximately 12 MB catalog package) exceed these limits. `BrokerReader` still refuses a whole object over 1 MiB. The chunk implementation below supports explicitly published packages and reviewed independent durable broker namespaces; no such real package, namespace allocation, provider mapping or grant has been activated here. Fleet provider paths never implicitly become authorized broker object keys. There is no range-read escape, automatic database/instance rotation, history deletion, upload, or direct/SSH fallback after denial. Existing direct/SSH modes remain explicit separate choices.

### Chunk preparation and reviewed capacity contract

`chunk_package.py` is a separate explicit CLI. Its required arguments are `--archive APPROVED_LOCAL_ARCHIVE --reference SOURCE_REFERENCE_JSON --project BROKER_PROJECT_ID --bucket APPROVED_CHUNK_BUCKET --destination NEW_DIRECTORY`. This is a prepared command shape, **not executed here**. The source reference is the exact existing catalog archive (or published catalog-distribution object) reference: bucket/object/positive generation/full SHA-256/bytes. The local file must match its full size/hash. The code streams at most 1 MiB per chunk, without extracting or recompressing the tar.gz, with a 4 GiB archive/4096 chunk limit. Only the explicitly named archive and nonsecret reference/session metadata are read.

New package layout:

- `projects/PROJECT/objects/SHA256` holds each distinct chunk, at most 1 MiB, under the **existing broker-supported** content-addressed object namespace. Repeated content reuses local bytes; planning conservatively counts every occurrence.
- `manifest.prepared.json` has `format: foundry.chunk-manifest.v1`, `status: prepared-not-published`, the project, approved target bucket, exact `sourceArchive` reference, and ordered `chunks` of `{sha256, bytes, generation: null}`. It is bounded to 1 MiB so the final manifest can itself fit a scoped broker read; final publication must recheck that bound.
- `publication.prepared.json` has `format: foundry.chunk-package.v1`, `status: prepared-not-published`, the source reference/project, and a prepared manifest reference under `projects/PROJECT/manifests/SHA256` with `generation: null`, plus `publicationAuthorized: false`. It is never accepted for reads.
- `session-requirements.json` lists ordered segment byte/grant/read requirements and the count of required independent durable namespaces. It allocates no namespace or authority. Each segment respects the hard lifetime caps, counting the manifest too.

The preparer writes an exclusive private staging directory, fsyncs file/directory data, makes it read-only and reuses atomic no-replace local publication. Failed staging remains for review. No source package or published history is replaced. Optional `--sessions REVIEWED_NONSECRET_JSON --rollover-review-ref REVIEW_REF` validates a supplied namespace/budget list and writes `session-plan.prepared.json`; insufficient byte/grant/read capacity refuses local package publication. Requirements made from null-generation templates must be recomputed after the real manifest's generations and byte size are known.

Each supplied session record requires `environment`, `authorityId`, `namespaceId`, `durableStoreRef`, `approvalRef`, `sourceArchiveSha256`, `historyPreserved: true`, `availableBytes`, `availableGrants`, `availableReads`, and `maxReadBytes`. Identifier fields are opaque nonsecret IDs, never database paths, provider URLs or credentials. Remaining budgets cannot exceed 8 MiB, 32 grants, 128 reads or 1 MiB/read. Exhausted or reduced budgets are respected; no default free capacity is assumed. Duplicate authority/store/namespace aliases are rejected. Multiple sessions require an explicit rollover review reference. `plan_sessions(...)` returns exact ordered task/session assignments and `planSha256` (canonical plan digest excluding that field); it refuses insufficient supplied capacity. This deterministic sequential plan can conservatively reject fragmented budgets. Actual current broker admission/grant reservations remain authoritative; the plan is not a reservation or an approval proof.

No code creates, resets, deletes, prunes or rolls over a broker database. The owner/parent must explicitly review and supply independently durable per-archive namespaces, confirm that each opaque ID names genuinely independent retained storage, preserve every prior namespace's grant/replay/revocation history, and issue the exact scoped grants through its existing authority. The planner cannot establish those facts from caller strings. Changing identity strings is not proof of rollover. Across all archives of a pull, the client refuses reused authority/store/namespace IDs rather than assuming shared free capacity.

After separately approved create-only chunk publication, the parent records **actual** positive provider generations in a **new** canonical manifest with `status: published`, publishes that manifest under its new content SHA path, and records its actual bucket/object/generation/SHA/bytes in a new `foundry.chunk-package.v1` descriptor with `status: published`. The descriptor preserves the original `sourceArchive` reference. Prepared artifacts remain unchanged. There is no publisher/finalizer, fake generation, mutable pointer or automatic grant issuance in this code.

### Chunk transport integration

`ChunkReader(package_for, broker_for, cache)` implements the existing reader interface. Pass it to `restore(..., reader)`, the loopback server's trusted `reader_factory`, or `sync_catalog.sync(descriptor_path, destination, reader=reader)`. Injected catalog sync uses the reader's cache and needs no gcloud project/account. Catalog sync still requires its outer `foundry.catalog-distribution.v1` descriptor to be published and verifies its SHA/size against its pinned object, then verifies the extracted catalog revision/detail hashes as before. Existing catalog/version/archive identities are preserved; package lookup keys the exact original source reference, not a latest pointer. No new CLI/browser credential, grant, endpoint or arbitrary filesystem controls were added.

`package_for(expected_source)` is trusted host DI returning `{descriptor, manifestBytes, sessions, rolloverReviewRef}`. The host bounds local manifest loading to 1 MiB and selects an approved published descriptor. The client independently checks descriptor/manifest publication status, exact source-reference equality, project namespace, canonical manifest bytes/hash/size, positive pinned manifest/chunk generations, sum of chunk sizes, and sufficient reviewed lifetime budgets **before any broker read**. Null, zero, leading-zero, missing and malformed generations fail closed. Package/plan metadata is pinned for the reader's lifetime (up to 128 packages and 16 MiB of manifest data); it supplies no live authorization.

`broker_for(session, package_digest, task, expected_object)` returns an existing scoped `BrokerReader`. Each task includes its `planSha256`; the trusted host must check the approved exact package/plan/task, real durable namespace, current issued grant's exact provider reference and stable `grantId/requestId`. Retries must replay those identities and must not mint a replacement key or select new namespaces to evade consumed/unknown budgets. Credential resolution remains opaque reference DI in `BrokerReader`; no credential copying or gcloud flow is used. Available-budget snapshots can conservatively refuse an otherwise valid replay; the client provides no reservation reconciliation or automatic recovery.

The client obtains and verifies the **actual granted manifest** first, then each **actual granted chunk**, checking full SHA/size and final archive SHA/size. Reassembly holds bounded buffers and writes incrementally. Its single 30-minute monotonic acceptance deadline is propagated into the supervised broker transport, rather than renewed per chunk or enforced solely by a socket timeout. A reviewed alternate port must enforce the same bounded contract; post-call clock checks cannot preempt a blocking arbitrary callback. No per-chunk disk cache is added. Shared `CloudReader.fetch` independently checks the full staged archive before cache publication; the unchanged extractor verifies selected files. Even an archive cache hit rechecks the granted manifest/chunks through a discard sink. Denial, mismatch or expiry stops without fallback or automatic namespace change.

Static review receipt: `docs/cloud-workspaces/LIBRARY-REVIEW.md` in the repository. Structure and Content were inspected from source only. Compilation, runtime Integration, User Journey and Deployment remain deferred pending approval.

## R5 cache storage admission (source only)

The default cache admission limit is **20 GiB** (`20 * 1024**3` bytes), enforced centrally by `CloudReader.fetch` for direct, SSH, scoped-broker and chunk reassembly readers. It is not an unlimited retention promise. Before any archive download or cache-hit broker reauthorization/reassembly, the client opens the owner-configured cache directory without following its final component, checks every ancestor for symlinks, verifies directory identity/ownership and refuses group/other-writable roots. A nonblocking exclusive `flock` on the directory serializes the full inventory, staging reservation, stream, verification and no-overwrite publication across cooperating clients. Missing/unsupported locks fail closed; there is no unlocked fallback or lock-file cleanup. The root may be created with the existing explicit cache configuration, but a metadata GET never creates it.

The bounded, nonrecursive metadata inventory permits only regular, current-user-owned, single-link, non-group/other-writable files named `SHA256.tar.gz` or the bridge's `.download-XXXXXXXX` temporaries. Unknown names, subdirectories, symlinks, hardlink aliases, special files, oversized entries, inaccessible metadata, unsupported allocated-byte/free-space observations and detected concurrent changes refuse admission. At most 4096 entries and a two-second checked inventory interval are allowed; native filesystem calls themselves cannot be preempted. No content or secret discovery occurs in the storage observation. Hash-named archives are still independently content-verified before reuse.

Accounting charges each existing file and the root directory by `max(logical size, observed allocated blocks * 512) + 4096` bytes. This conservatively charges sparse/compressed/cloned files by at least their logical size. Existing partial downloads remain fully charged. New download admission reserves the complete expected archive size rounded to the observed allocation unit, a file-entry allowance and an extra allocation unit for directory growth; that reservation stays protected by the exclusive directory lock through completion. Filesystem free space must also cover the reservation plus a 64 MiB margin. The stream wrapper rejects any byte beyond the declared reservation **before writing**. A complete rescan and full archive SHA/size verification precede atomic no-replace rename of the staging file into the cache; rename creates no second archive copy. No existing cache object or failed partial is deleted, evicted, truncated or repaired automatically. Operator-approved cleanup remains a separate gate. Unknown capacity, an over-limit existing cache, a busy lock or insufficient headroom refuses reuse/download rather than treating unknown as free space.

`GET /api/storage` and `reader.cache_metadata()` expose metadata-only observations from the configured cache root: `status`, observation time, `limitBytes`, accounted/payload/allocated bytes, managed/partial file counts, remaining quota and observed filesystem free bytes. The loopback storage view refreshes at load, during existing pull-status polling and with its Refresh storage button. No browser input selects the root or limit; paths, names, file contents, credential references and raw filesystem errors are never returned. An injected reader must use the same configured root; if no root was configured, its trusted factory establishes the root on the first accepted pull attempt. The API observes no other cache.

While an exclusive writer is active, metadata returns `status: unknown`, `reason: cache-busy` and null usage/reservation/free-space fields. It does not invent a live zero reservation or stale usage total. Unconfigured, missing, changing or invalid roots likewise remain unknown with a fixed reason code; the 20 GiB policy limit is still known. Idle complete observations report zero active reservation because the shared directory lock excludes cooperating writers. Remaining quota is an observation, not a guarantee that a future archive fits; admission rechecks the full expected size. No cache has actually been inventoried or measured in this implementation session.

This is an application cache budget for an owner-controlled local directory, not a filesystem quota or protection against a same-user process ignoring the lock. Stop/upgrade earlier clients and other writers before activation; shared/network filesystems and platforms without reliable directory locks/statvfs/atomic rename remain unsupported until separately approved runtime verification. Workspace restore stages, prepared chunk packages and local snapshots are outside this cache quota and retain their separate headroom checks/boundaries. No cache cleanup controls, automatic eviction, service activation or runtime checks were added.

## Read transport and credentials

Direct mode uses an already-installed `gcloud` with an explicit account and project on every token request. It performs no login, global account switch, ADC setup, key creation, IAM edit or credential persistence. Bearer values remain in memory and never enter browser responses, subprocess error output, catalog packages or workspace receipts.

Read-only environment discovery found Python on all three Macs. `gcloud` was found on Mac1 but not through Mac4/Mac5's current SSH PATH or `/opt/homebrew/bin/gcloud`; this does not prove that no SDK exists elsewhere. Optional `--cloud-via mac1` avoids depending on a remote SDK: existing BatchMode SSH invokes the canonical Mac1 helper, using its existing CLI login. Verified archive bytes stream to the target Mac without an intermediate archive on Mac1. SSH host-key checks are retained. No new credential is copied to another Mac.

The helper is fixed at:

`/Users/mohameddiomande/Developer/foundry-integration/source/tools/foundry-library-bridge/ssh_reader.py`

Its scope is the existing private pilot bucket's current clean-source prefix and the prepared `catalogs/fleet/` namespace. It is a compatibility path, not a high-availability service: Mac1 must be awake, reachable through existing SSH and able to use the explicitly selected existing account. A future independent per-device identity remains separately gated.

## Commands prepared for later activation

The following are operator instructions, **not commands run during implementation**. Python 3.9+ and the standard library are used. No pip or npm install is required by the client. The client/canonical helper and catalog must first be placed at their approved destinations; no remote placement happened here.

Read-only browsing on Mac1, using the already assembled local catalog:

```sh
/opt/homebrew/bin/python3 /Users/mohameddiomande/Developer/foundry-integration/source/tools/foundry-library-bridge/bridge.py --catalog /Users/mohameddiomande/Documents/Codex/2026-10-15/ran-command-inventory-review-package-contents/foundry-project-library-2026-10-17/catalog-r3 serve --port 9148
```

For activated clients, the intended common layout is `/Users/mohameddiomande/Developer/Foundry-Library/client/` and `/Users/mohameddiomande/Developer/Foundry-Library/catalogs/r3/`. Those directories have **not** been installed on the Macs. After approval and placement, Mac4/Mac5's command is:

```sh
/opt/homebrew/bin/python3 /Users/mohameddiomande/Developer/Foundry-Library/client/bridge.py --catalog /Users/mohameddiomande/Developer/Foundry-Library/catalogs/r3 serve --port 9148 --enable-pull --workspace-root /Users/mohameddiomande/Developer --cache-root /Users/mohameddiomande/Library/Caches/FoundryLibrary --gcp-project project-8380e794-e4d6-4ad4-aaf --account granddiomande7907@gmail.com --cloud-via mac1
```

The account is the operator account recorded for the source transfer; current usable authentication is not re-proven by this implementation. Mac1 can use the same client command without `--cloud-via mac1`, relying on its existing installed CLI. There are no launch agents, background installation scripts or auto-start hooks in this package. A foreground server requires separate activation approval.

CLI operations are `list --search QUERY`, `show PROJECT_ID`, and `pull PROJECT_ID --version VERSION_SHA --destination NEW_ABSOLUTE_PATH`, with the same explicit cloud flags for pull. Catalog path precedes the subcommand. A pull destination's parent must already exist and contain no symlink components.

## Central catalog distribution

`catalog-distribution-r3.tar.gz` is a 12,094,956-byte local package containing catalog metadata, not a second upload of project contents. Its prepared descriptor has `status: prepared-not-published` and `object: null`. No cloud generation is invented. After owner-approved create-only publication in the existing bucket, record the real bucket/object/generation/bytes/SHA and catalog revision in a `foundry.catalog-distribution.v1` descriptor with `status: published`.

`sync_catalog.py` accepts that descriptor, explicit account/project/cache and a new destination; `--cloud-via mac1` is optional. It verifies the package, catalog revision and all detail hashes before publication. An installed client can use the same immutable revision on all three machines. There is no mutable latest-pointer writer, automatic catalog polling, project save-back or live filesystem synchronization in this slice. A newer catalog is a separately reviewed publication and explicit client revision update, never an unverified replacement during a pull. The catalog's `cloudPublished: false` records its assembly-time state; a subsequent distribution descriptor carries actual publication evidence.

## Safety and failure behavior

- GCS reads name an exact recorded generation; no current-version fallback. Full archive SHA and size are checked before source extraction; selected files are checked independently.
- No `extractall`, restored symlinks, special files, unsafe relative paths, case/Unicode collisions, file/directory collisions, or privileged permission bits. Only declared regular content is written. Internal hardlinks are read as bytes, not created in the workspace.
- Downloads and extraction are bounded. Disk headroom is checked conservatively for required archives and staged files. Archives are cached on the receiving Mac and are not automatically evicted. The first pull can download a whole machine archive even for a small project.
- Selected regular members are read in archive-offset order. Multiple paths referencing one internal hardlink source are copied from the first verified staged file through its open descriptor, with each output hashed; path order does not cause repeated gzip rewinds for those copies. This performance correction is source-reviewed, not benchmarked.
- Failed download temporaries, corrupt existing cache objects and failed restore stages are retained. Cache partials count toward the 20 GiB admission budget. A retry does not overwrite a published workspace, existing cache object or old failed stage. Downloads restart rather than resume after interruption; no automatic cleanup or durable in-progress queue is claimed.
- Loopback-only server, exact Host/Origin checks and JSON/custom-header mutation requests; no CORS, public listener, external scripts, cookie reuse or forwarding of Operator credentials. The client is for the local OS user, not a multi-user service. OS users with access to that user's account are outside this boundary.
- Source-copy scope excludes complete Git stores, installed dependencies/SDKs, secrets, bulk media/models/data and held files. A successful pull would establish delivered-content integrity, not buildability, runnable dependencies, successful tests, complete backup or canonical authority.

## Review and next gate

See the workspace `ROUTE.md` and `review/SOURCE-REVIEW.md` for the exact stop. No tests, remote relay invocation, browser validation or trial pull was run. Operational acceptance remains open. Deployment, remote client placement/installation, cloud publication, cost-bearing reads, spending and secret changes remain gated. The existing R2 integration HOLD and unrelated R3–R7 work are not closed by this bridge.
