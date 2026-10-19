# Project input snapshots — bounded source candidate

2026-10-18. Local source edits and static review only. This lane owns only
`packages/build-storage/**` and this report. The authorized base is
`codex/foundry-integration-20261016` at
`cf27ac662730bb98a509af8d1d1ebea4342eef7a`, already dirty. Supporting preimages
are recorded in this directory's `BASELINE.json`; no Git state was changed.
Existing work was preserved. No tests were authored or executed, and no build,
typecheck, product import/probe, service, install, provider operation, spending,
credential change, cleanup or Git mutation was performed. Existing reviews are
context, not additional authorization or validation of these bytes.

## Format and bounds

V1 entry points and default flat CAS behavior remain. V2 is selected explicitly
by `packageProjectInputSnapshot`; the existing input approval's `manifest`
ObjectRef points to the v2 root without inventing a different authority ref type.
The root is `{version:2,kind:'segmented-input',projectId,segments,totals,git,
historyEvidence:null}`. Each ordered segment ref pins the actual metadata object
SHA-256, generation, project, key and size, plus its file/object/byte/required/
missing counts. Segment index/project/version and every summary must match.

Each segment contains `objects:ObjectRef[]`, file descriptors, required paths and
missing paths. Files carry path/classification/retention/mode/whole-file digest/
size and ordered `{object,offset,sizeBytes}` ranges into that segment's objects.
Every data object is hash/generation pinned. Range validation rejects gaps,
overlaps, unused objects/tails, invalid indexes and wrong file chunk order/size.
The summed file bytes must cover every referenced data object exactly.

Nonempty files <=32 KiB are packed together within their descriptor page, up to
1 MiB of packed data. Larger files stream in <=1 MiB chunks. Empty files use the
real empty digest and no object/range. No synthetic generation, grant, namespace,
history evidence, completeness approval or zero-byte storage object is created.

`PROJECT_INPUT_LIMITS` exports finite, intersecting structural ceilings:

| Quantity | Ceiling |
| --- | --- |
| Selected files / owner required paths | 8,192 each |
| Ordered metadata segments | 512 |
| Files / required paths per segment | 32 each |
| Data objects per segment | 128 |
| File ranges per segment | 128 + 32 |
| File chunks / file size | 64 / 64 MiB |
| Referenced data objects / total selected file bytes | 8,192 / 4 GiB |
| Root / individual metadata segment | 256 KiB each |
| Individual data object | 1 MiB |
| Distinct selected/required path bytes | 4 MiB |
| Path components / depth | 65,536 / 32 |
| Sibling names per directory | 20,000 |
| Aggregate observed names / name bytes | 200,000 / 16 MiB |
| Explicit approved namespaces | 512 |

Shared inert JSON limits still apply per object: 256 KiB serialized bytes,
16,384 nodes, depth 16 and array/property limits. They are not raised. The bounded
selection request is copied item by item; all file descriptors are never placed
in one serialized manifest. Packaging retains bounded selection/stat plans;
import, materialization and verification stream one metadata page at a time and
retain bounded global path sets. Directory names along selected paths are cached
only under the exclusive seal to avoid repeated full sibling scans. Unselected
file contents are not discovered or opened.

Global validation rejects exact duplicates, case/Unicode aliases, inconsistent
ancestor spelling and file/directory conflicts across all segments. Required
and selected lists are separately unique; exact overlap is intentional. Every
declared missing path must be required and actually absent; every absent required
path must appear in missing paths. Import/materialization/verification reject
nonempty missing sets. Packaging may retain an explicitly incomplete snapshot.

## Namespace and reservation compatibility

The namespace set is an explicit host-supplied `ProjectInputRouting` value,
never manifest data. Each entry has its exact scope and real issuer/capacity plus
writer or reader. Entries must share the project, principal and complete compute
fence; namespace refs are distinct and include the request's primary namespace.
`selectNamespace({operation,kind,ordinal,sha256,sizeBytes,ref},signal)` selects
once per distinct immutable operation within the invocation from that finite
set; duplicate operations reuse the selected route. No fallback, retry, namespace
creation, rotation, automatic rollover or quota reset exists in this package.

Each selected route must durably reserve the real object's exact byte size and
one artifact before publication/read issuance. Capacity must include cumulative
usage, previous runs, concurrent reservations, grants, reads and retained partial
operations. All receipts are rechecked before return; real current grants and
actual returned generation/bytes are checked. Namespace selection alone is not
capacity or owner approval. Host callbacks remain a trust boundary.

The concrete broker's **32 grants / 8 MiB total per namespace remain unchanged**.
A single legacy namespace cannot serve arbitrary project-scale snapshots. For
8,192 nonempty files each <=32 KiB, the layout uses 256 packed data objects, 256
metadata objects and one root: 513 objects, at least 17 namespaces by grant count
alone. Byte limits, cumulative reads/usage and existing reservations can require
more or reject the operation. At the structural 4-GiB data ceiling, metadata adds
up to 513 * 256 KiB, so even 512 otherwise empty 8-MiB namespaces cannot cover
that worst-case payload plus metadata. Structural maxima are not an assertion
that every combination is usable. No approved set, real capacity or operational
compatibility was established by this source change.

Admission is incremental per object, not atomic admission of an entire project.
Insufficient later capacity leaves retained partial objects and fails without
trying another namespace. Parent coordinator must budget/admit the whole finite
set when atomic preflight is required, retain real routing/admission records and
select approved read scopes for the immutable refs on another host. Root/segment
metadata deliberately contains no grant IDs or namespace-routing authority.

Reservation API changes requested by the parent are implemented:

* `TrustedWriter.write(projectId,kind,bytes,signal,reservation?)`.
* `TrustedGrantIssuer.issue(ref,scope,signal,reservation?)`.
* `publish` passes its exact reservation to writer and `issueCurrent`;
  `issueCurrent` forwards it to issuer.
* V1 import passes its actual manifest/chunk reservation into its read helper
  and issuance. V2 reads pass the route's actual per-object reservation.
* `TrustedPublicationCapacity.reserve(need,signal,operationKey?)` and the storage
  reserve helper forward a stable SHA-256 operation key. Every owned reserve
  call supplies one. Concrete hosts must require the key, return the original
  debit after a committed reservation's lost reply and reject changed exact need.

Project operation keys hash canonical `{scope,operation,kind,sha256,sizeBytes,ref}`
for the selected namespace; ordinal is excluded. Duplicate immutable operations
reuse both route and key within an invocation. Parent coordinator must retain
the same approved route choice across restarts; it must not rotate a retried
operation into another namespace. V1 package keys bind scope, input-package kind,
selections, required paths and supplied Git metadata. V1 import keys bind scope,
manifest ref and distinct manifest/chunks kinds. Output keys bind scope, output
kind, approved profile and selections. Result manifest keys bind scope, job,
attempt, input/profile hashes and the actual manifest byte hash.

`projectInputOperationKey(scope,request)` is exported from the package and used
by the router itself. It accepts either `ProjectInputOperation` (without ordinal)
or the selector's `ProjectInputRouteRequest` (with ordinal). Its exact formula is
`sha256(canonical({scope:scopeCopy(scope),operation,kind,sha256,sizeBytes,ref}))`.
For publication `ref` must be null; reads require the exact pinned ref with
matching hash/size/project/kind. No default/guessed generation is substituted.
The selector must call this helper with EACH approved candidate scope and search
that host's `reservation(operationKey)` before considering remaining capacity.
One existing exact-need receipt selects that existing namespace; conflicting
multiple prior debits must reject and reconcile. Only when the entire approved
set has no existing receipt may it admit a new stable route. This is a required
concrete coordinator behavior; this storage package cannot inspect host durability
through a selector callback alone. Its local cache prevents duplicate route
selection within one invocation and is not a claimed cross-process journal.

Output admission is split without raising its combined limits: nonempty chunks
reserve their exact count/bytes; the actual result manifest separately reserves
one artifact and its exact bytes using its job/attempt/hash key. Combined
31-chunks + one manifest and <=7-MiB data + <=1-MiB overhead checks remain.
`CollectedOutputs.reservation` is now `PublicationReservation|null`: all-empty
outputs have no chunk reservation, and only the actual nonempty result manifest
is admitted. The retained result lineage records both the nullable chunk
reservation and `manifestReservation`. No zero-byte or placeholder reservation
is fabricated. Admission is incremental, so a later manifest rejection retains
partial chunk evidence rather than claiming the whole result was admitted.

The arguments are optional only for source compatibility with existing provider
implementations. The concrete admitted host must require and verify the exact
scope-bound receipt; no mutable ambient "current reservation" is needed here.
Output profile, output bytes/chunks, output selection and result budgets were
not widened.

## Stable runtime integration APIs

All exports below are available through `packages/build-storage/src/index.ts`:

```ts
createLocalContentStore(casRoot, seal, 'sharded-v2');
projectInputOperationKey(candidateScope, selectorRequest);
packageProjectInputSnapshot(request, packagingPorts, signal);
populateProjectInputSnapshot({manifest, snapshotHash, scope}, readPorts, signal,
  maxInputBytes /* optional; defaults to the structural 4-GiB ceiling */);
materializeProjectInputSnapshot(localRootRef, destination, local, seal, signal,
  maxInputBytes /* optional */);
verifyLocalProjectInputSnapshot(localRootRef, destination, local, seal, signal,
  maxInputBytes /* optional */);
```

`ProjectInputPackagingPorts` is `{local,seal,routing}`. Publication route entries
are `{scope,writer,issuer,capacity}`. `ProjectInputReadPorts` is `{local,routing}`;
read entries are `{scope,reader,issuer,capacity}`. Reader is the existing
`TrustedSnapshotReader`, enforcing current broker authorization and returning
the generation actually read. Import returns `{snapshot,local}` after validating
all metadata, fetching each data object and verifying every complete file digest.
The optional caller byte limit rejects an oversized root before source data
reads; root and bounded metadata remain real authorized reads.

The sharded CAS layout is `sha256/aa/bb/sha256-<digest>` with real digest-derived
directories. Default construction is still `flat-v1`. Reads accept both canonical
layouts; writes use only the selected layout. No existing CAS is moved/migrated
or cleaned. The host must provision a dedicated private root, adequate disk and
a real tree seal supporting nested access to distinct CAS and source/destination
roots. A full old flat root can still exceed its legacy sibling limit; use an
explicitly provisioned sharded root for new project inputs.
Legacy v1 manifests using flat local refs still require the legacy flat staging
layout; their importer does not silently rewrite immutable local lineage to the
new sharded layout. Parent should select the appropriate CAS per format.

`materializeLocalSnapshot` now dispatches a local v2 root to the new materializer;
its v1 path is retained. `populateLocalSnapshot` stays the legacy importer. Parent
runtime must select the v2 importer using the approved input root/format and the
finite namespace-set coordinator, rather than its current v1 direct-chunk loop.
Use the same local v2 root for a separately provisioned working-source copy when
needed. Preserve no-overlay/quarantine behavior on any failure.

The independent verifier returns `{snapshotHash,projectId,files,bytes,git,
requiredInputs,missingInputs}`. Under `ManagedTreeSeal`, it reads and hashes the
actual CAS root, streams/validates every segment and its counts, checks global
required/missing relationships, hashes actual CAS ranges, walks the destination,
rejects undeclared files/directories and unsafe entries, verifies each actual
reconstructed file's size/mode/digest and checks actual file/byte totals. It does
not accept a restore receipt as byte evidence. Parent `receipts.ts` must bind
returned hash/project/Git/complete required-path list to the exact approved input,
job and plan, retain its maximum-input-byte policy, and require missing paths to
be empty. This helper is not readiness, build authorization or deployment proof.

The existing `InputApproval` permits only 128 required paths. Packaging returns
`approval:null,inputHash:null` for a larger complete required list, without
truncation or a fabricated authority record. At <=128 required paths the candidate
is validated by the existing parent validator and ALWAYS has
`reconstructable:false`. Parent must separately resolve its approval-contract
extension and owner completeness gate; the v2 format alone grants neither.

## Static review and limits

Source review traced actual exports, reference validation, bounded reads, range
coverage, source seal lifetime, streaming file digests, global path indexes,
required/missing closure, CAS binding, namespace selection and explicit receipt
forwarding. All owned reserve callsites were inspected for stable operation-key
forwarding; no reserve callsite in this package omits its key. Review also checked
empty-output handling after the split admission, page-local packed-byte caching,
directory-handle closure and directory-entry fsync after creation. Independent
verification covers actual reconstructed bytes and extra
entries rather than accepting only importer success. Partial writes remain
evidence and require parent quarantine/reconciliation; no retry/cleanup is added.

V2 Git metadata is owner-supplied. `historyPreserved:false` and
`historyEvidence:null` are mandatory. Explicit `source-history` selections retain
their bytes but do not attest full history. No automatic Git/assets/dependency/
secret closure or complete-project reconstructability is claimed. Extended
attributes/resource forks, ACLs, directory metadata and external dependencies
are not captured. Modes are restored with the existing `mode & 0755` policy.

RTD: Structure inspected in real files/exports; compilation DEFERRED/FORBIDDEN;
integration is static callsite/shape reasoning only; content boundaries and
failure paths reviewed; user journey traced in source only; deployment gated
with no activation. No tests passed claim is made. Parent runtime/broker/common
docs are outside this lane's write scope and remain parent-owned.

## Exact changed paths

* `packages/build-storage/src/filesystem.ts`
* `packages/build-storage/src/index.ts`
* `packages/build-storage/src/local-store.ts`
* `packages/build-storage/src/local-refs.ts` (new)
* `packages/build-storage/src/packaging.ts`
* `packages/build-storage/src/project-input-format.ts` (new)
* `packages/build-storage/src/project-input-io.ts` (new)
* `packages/build-storage/src/project-input-tree.ts` (new)
* `packages/build-storage/src/project-inputs.ts` (new)
* `packages/build-storage/src/publication.ts`
* `packages/build-storage/src/restore-file.ts` (new)
* `packages/build-storage/src/snapshots.ts`
* `packages/build-storage/src/types.ts`
* `docs/cloud-workspaces/continuation-2026-10-18/PROJECT-INPUTS.md` (new)
