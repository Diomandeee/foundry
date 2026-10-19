# Library jobs v1 — bounded read-only contracts

Local implementation of the read-only adapter boundary in `DISTRIBUTED-LIBRARY-ARCHITECTURE.md`. This package builds inert jobs, validates untrusted summaries and independently checks bytes through trusted synchronous ports. It does not execute workers, import/upload content, select a backend, mutate the catalog, publish snapshots or promote candidates.

## Exported API

Import from `@foundry/library-jobs` (workspace export `src/index.ts`). All public interfaces are in `src/types.ts` and re-exported from the entry point.

```ts
validatePolicy(input: unknown): LibraryPolicy;
policyDigest(input: unknown): string;
manifestBytes(input: unknown): Uint8Array;
buildVerificationJob(input: unknown, trustedHost: TrustedHost): VerificationJob;
validateJob(input: unknown): VerificationJob;
buildWorkerReport(input: VerificationJob): WorkerReport;
validateWorkerReport(input: unknown): WorkerReport;
verifyEvidence(job: unknown, report: unknown, ports: VerificationPorts): HostAttestation;
canonical(input: unknown): string;
```

`OPERATION` is exactly `verify-library-snapshot`. Every versioned record requires numeric `version: 1`; unknown or missing fields are rejected. Validators return detached deeply frozen snapshots. The byte renderer returns a fresh byte array. Validation errors use fixed messages without echoing rejected data.

The request body is `VerificationBody`: `{version, operation, projectId, policyVersion, policyHash, manifestRef, manifest, compute}`. It contains no principal or role. `TrustedHost` is `{principalRef, policy, compute}`, constructed by the authenticated host, never copied from a request. The builder adds `principalRef` and `jobId`.

`LibraryPolicy` is `{version: 1, projectId, policyVersion, authorizedManifest, authorizedObjects, limits}`. The host supplies the entire exact manifest/object authorization and its bounds. `policyHash` is `policyDigest(policy)`, binding the complete policy including resource limits. A policy label alone grants nothing. The parent must authenticate and authorize its owner/writer/verifier identities and keep the project policy current.

## Shared reference and compute contracts

`ObjectRef` is `{projectId, objectKey, generation, sha256, sizeBytes}`. A manifest reference must use `projects/<projectId>/manifests/<sha256>`; each content reference must use `projects/<projectId>/objects/<sha256>`. The lowercase 64-hex suffix must equal that reference's hash. Generation is an immutable positive decimal string of 1–32 digits, with no leading zero. A project label without its physical namespace is insufficient. Paths, traversal, encoded separators, external URLs and freeform backend/command fields are rejected.

The manifest is `{version: 1, projectId, objects: readonly ObjectRef[]}`. Its actual pinned bytes are **exactly** `manifestBytes(manifest)`: canonical UTF-8 JSON. Manifest generation, digest and size are separately pinned. Content keys cannot repeat, even at different generations. V1 requires a nonempty, complete exact ordered object sequence matching the policy; subsets and duplicate physical keys are unsupported. Manifest/order changes require new pins. Empty snapshots and a looser logical-file manifest format are outside v1.

`ComputeBinding` is:

```ts
{
  authorityId: string;
  workloadId: string;
  leaseId: string;
  epoch: number;
  generation: number;
  attemptId: string;
  capabilityDigest: string;
  workerId: string;
  incarnation: number;
}
```

Epoch is a positive safe integer. Compute incarnation and workload generation are nonnegative safe integers, matching the durable compute authority's initial `0` identities; library authorization generations are a separate positive domain. `capabilityDigest` is a SHA-256 digest, never a raw lease capability. `attemptId`, worker ID and incarnation must be preserved by the catalog bridge along with all other fields. Earlier drafts using a string incarnation or `leaseTokenHash` are superseded. References/principal/policy IDs use `[A-Za-z0-9][A-Za-z0-9_-]{0,95}` with an absolute end check; hashes and generations also reject terminal newlines. IDs are opaque reference names, not credentials or URLs.

## Worker reports and host verification

`WorkerReport` has kind `library-worker-report`, job ID, complete compute binding, manifest digest, object-set digest, object count, total content bytes and report ID. `buildWorkerReport` renders this claim deterministically; it does **not** inspect storage or execute a worker. Anyone knowing the job can reproduce the summary and hashes. `validateJob`/`validateWorkerReport` prove only structure and digest consistency, never authenticated origin or permission.

`VerificationPorts` supplies:

```ts
{
  host: TrustedHost;
  now(): number;
  readObject(ref: ObjectRef, maxBytes: number): {
    ref: ObjectRef;
    bytes: Uint8Array;
  };
  observeAcceptance(expected: AcceptanceExpectation): unknown;
}
```

`AcceptanceExpectation` is `{version: 1, jobId, reportId, projectId, principalRef, policyVersion, policyHash, manifestDigest, compute}`. A `ComputeAcceptance` must contain exactly those fields plus `{status: 'accepted', revoked: false, observedAt, acceptedAt, expiresAt}`. All times are integer milliseconds from the trusted clock. The observation timestamp must lie within the synchronous observation call; acceptance must have occurred by observation time and remain unexpired when the call returns. The clock cannot go backwards during verification. Async results, stale receipts, worker summaries and absent authority fail closed.

The verifier reauthorizes the job against the trusted host policy/principal/fence, compares the complete expected report, checks current acceptance **before any reads**, verifies exact returned reference metadata and SHA-256/size of actual manifest and content bytes, then checks current acceptance again. Expiry or revocation during reads prevents an attestation. Every read gets the exact pinned size as its maximum, never an unbounded read request. Reads occur once per reference; copied byte views are hashed independently. Shared-memory bytes are rejected.

`HostAttestation` has kind `library-host-byte-attestation` and proof `trusted-acceptance-and-local-byte-digests`. It contains the expectation, object-set digest/count, `verifiedBytes` (manifest plus content), final acceptance/expiry/attestation times and `attestationId`. Its `publicationAuthorized` and `promotionAuthorized` fields are always `false`. The worker report and host attestation are deliberately distinct types and identities.

## Catalog bridge obligations and proof limits

The parent owns mapping the verified job and host result into catalog `TransferBinding`, `attestTransfer` and `recordVerification`. Preserve project, policy version/hash, exact manifest and content references, and **all** compute fields. `HostAttestation.manifestDigest` maps to the catalog manifest hash; `verifiedBytes` includes manifest bytes, while `WorkerReport.totalObjectBytes` does not. Do not silently interchange the byte measures.

Only a trusted host invocation may submit an attestation to the catalog. JSON returned by a client is forgeable, even with a valid `attestationId`: the identifier is an unkeyed consistency hash, not a signature, certificate or bearer permission. Persist a trusted receipt/reference and recheck project policy, current acceptance/fences, expiry, transfer intent/generation and expected catalog revision at the authoritative transition. Publication/promotion is a separate domain decision. An attestation is a point-in-time observation; it does not create an atomic transaction across compute, catalog and storage, or remain authorization after revocation.

The synchronous acceptance port must derive acceptance from current authoritative state and verify the complete expected bindings; spreading the expectation into an unconditional `accepted` object is **only a test fixture**. The read port must independently authorize project/object/generation, return actual provider metadata and enforce the supplied bound **before** reading/allocating. Core validation bounds copied and hashed bytes but cannot undo excessive allocation, side effects, lies or blocking inside a malicious trusted adapter. The parent must implement timeouts/resource discipline outside these synchronous calls if needed. Snapshotting the host policy is not a live policy service.

This proves local byte consistency against exact pins and a trusted acceptance observation under those adapter assumptions. It does not prove Docker use, process isolation, worker execution, real cloud storage, GCS availability, backup/restore, a deployed broker, network authentication or an actual compute-service integration. No live adapters/auth/CLI are included. `node:crypto`/`node:util` target the existing Node test host; a different runtime needs compatibility review.

## Bounds and stable identities

Policy limits may tighten but cannot exceed 64 objects, 8 MiB per object, 64 KiB canonical manifest, and 32 MiB total including manifest. Sizes and counts must fit safe integers. Zero-byte content is allowed; empty object lists are not. Native JSON inspection is bounded to 256 KiB, 16 nesting levels, 16,384 visited nodes and 4,096 own properties per container. Accessors, proxies, custom prototypes, symbols, sparse/decorated arrays, cycles, hidden properties, `toJSON`, functions and nonfinite/negative-zero numbers are rejected before field access. Byte envelopes reject accessors/proxies; native typed-array copying avoids caller species/length getters.

Canonical object keys are sorted; JSON property order does not change identities. Arrays retain order. IDs are SHA-256 of a versioned domain, newline and canonical binding: `library-policy/v1`, `library-job/v1`, `library-worker-report/v1`, `library-objects/v1`, `library-host-byte-attestation/v1`. The same inputs/time produce the same result. A fresh attestation at a different time has a different identity by design.

## Local checks

From this directory, using already-installed parent dependencies:

```sh
../../node_modules/.bin/tsc --noEmit -p tsconfig.json
../../node_modules/.bin/vitest run --config vitest.config.ts --configLoader runner --cache=false --reporter=dot
```

The suite imports `test` from Vitest and uses `src/index.test.ts`, so parent Foundry aggregate discovery includes it. Standalone config/cache paths stay inside this package. `src/fixtures.ts` exports `fixture()` for the parent's integrated local journey; all fixture bytes, acceptance and principal references are synthetic and in memory. No installs are needed. `REPORT.md` records executed checks and outstanding boundaries.
