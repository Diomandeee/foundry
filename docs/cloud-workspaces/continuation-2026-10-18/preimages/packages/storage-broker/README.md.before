# Local authenticated storage broker core

This package implements a dependency-injected, read-only immutable-generation GET proxy. It uses actual Node `node:sqlite`, the repository's Vitest runner, and no new dependency. It does not implement HTTP authentication, a GCS adapter, upload, signed URLs, bearer/session delivery, publication, or deployment. This local core advances the proposed broker portion of `DISTRIBUTED-LIBRARY-ARCHITECTURE.md`; that document's operational gates remain in force.

## API and trusted-host wiring

Exports: `createStorageBroker`, `validateGrant`, `grantRevocationBinding`, `HARD_LIMITS`, and the types in `src/types.ts`. Parent integrations must import `./src/index.ts` or the workspace package after normal workspace reconciliation; no lockfile is changed by this package.

```ts
const { admin, reader } = createStorageBroker({
  db, // host-owned DatabaseSync; durable private local file in production
  binding: { environment: 'local', authorityId: 'storage-1' },
  now, // trusted monotonic wall-clock integer milliseconds
  observeCurrent, // SYNCHRONOUS current trusted authority observation
  readObject, // async (exactRef, maxBytes, abortSignal) => {ref, bytes}
});
admin.issue(grant); // trusted issuer role only
await reader.read(authenticatedPrincipalRef, { grantId, requestId });
admin.revokeGrant({ key, grantId, expectedBinding, evidenceId, reason });
```

The host keeps `admin`, SQLite and DI ports outside worker reach. It authenticates an issuer/revoker role before calling `admin` and independently authenticates the worker before supplying `authenticatedPrincipalRef`. A worker body can contain only `{grantId,requestId}`; it cannot supply its principal, grant, policy, context, current acceptance, object path, or provider URL. The separated handles are capabilities, not an authentication implementation. Never give arbitrary worker JavaScript direct access to this module's host process or database.

`ReadGrant` pins version `1`, unique immutable `grantId`, authenticated `principalRef`, `projectId`, exact `policyVersion` and `policyHash`, `intentId`, positive local `authorizationGeneration`, full `compute`, `operation:'GET'`, exact `object`, `byteBudget`, and `expiresAt`. The full compute binding is `{authorityId,workloadId,leaseId,epoch,generation,attemptId,capabilityDigest,workerId,incarnation}`. Epoch starts at one; compute generation and incarnation allow zero. They are distinct from positive library authorization generations.

The object reference reuses `library-jobs`' `ObjectRef`: `{projectId,objectKey,generation,sha256,sizeBytes}`. Keys must be exactly `projects/<projectId>/objects/<sha256>` or `projects/<projectId>/manifests/<sha256>`. Immutable object generations are positive decimal strings of 1–32 digits, with no leading zero. Compute/local library generations remain numeric. References and grants are copied and deeply frozen. Identifiers use the existing 1–96 character inert identifier format; evidence IDs and reason codes must use that format too (not prose). Unknown fields, accessors, proxies, symbols, inherited fields, unsafe prototypes, sparse arrays, overlong values and excessive JSON complexity are rejected without invoking user code.

`observeCurrent(expectedGrant)` must return exactly:

```ts
{ grant: expectedGrant, status: 'authorized', revoked: false,
  observedAt: now(), expiresAt: minimumCurrentAuthorityExpiry }
```

This port must validate the authenticated principal, CURRENT exact grant, project policy version/hash, library intent/generation and catalog authorization, and the entire current compute lease/attempt/epoch/generation/incarnation/capability digest. The parent compute fence adapter must inspect actual capability digest and permitted current states (RUNNING/VERIFYING, or authority-accepted SUCCEEDED when explicitly valid for verification), expiry and durable revocation/cancellation. An old acceptance, cached worker claim or merely matching JSON labels is insufficient. If any current authority cannot be observed, throw. Observation timestamps must fall between the broker's clock readings; expiry must remain in the future. The core checks the complete echoed binding and current grant/revocation/expiry locally. A dishonest adapter echoing its input is not independent authorization proof.

The synchronous port deliberately forces authority observation into the trusted host boundary. A future remote adapter must arrange a reviewed fresh observation mechanism rather than silently supplying stale cached state. No live `/v1/library/fence` or multi-authority delivery adapter is implemented or claimed by this package.

`readObject` must authorize and bound transport/allocation before reading, pin immutable provider generation, respect abort, and return only `{ref,bytes}`. The broker copies native nonshared bytes, checks exact returned reference, actual byte count and SHA-256 before sealing. An oversized allocation already made by a trusted adapter cannot be undone by checking its return value. Synchronous blocking trusted callbacks cannot be preempted by a JavaScript timer; host adapters need their own bounded execution/transport implementation.

## Revocation delivery contract for parent integration

`admin.revokeGrant(command)` accepts exactly:

```ts
{
  key, grantId, evidenceId, reason,
  expectedBinding: { projectId, authorizationGeneration, compute, policyHash }
}
// receipt (all statuses durable):
{ status: 'revoked' | 'already-revoked' | 'superseded', key, grantId, evidenceId }
```

`grantRevocationBinding(grant)` produces that exact immutable binding. The parent's registered target maps `resourceId -> grantId`, `generation -> authorizationGeneration`, `computeBinding -> compute`, and retains `projectId`/`policyHash`. Route `targetAuthorityId` to the corresponding broker instance; its environment/authority identity is constructor-bound to its SQLite database. The target authority field is a trusted routing concern, not a body-controlled database selector. The full grant is immutable; exact grant ID plus this binding fences changed targets without needing to retain object bytes in the delivery ledger.

The HTTP/service adapter is parent-owned: authenticate trusted owner/delivery role, validate/bound body and routing, call this method, and acknowledge only after receiving its durable receipt. It must never expose admin through the worker-read route. Reuse the stable delivery key on retries. An exact command replay returns the original durable receipt, including after restart and lost response. Reusing a key with any different field throws. `revoked` creates an immutable tombstone; `already-revoked` records a matching historical tombstone; `superseded` records a mismatched immutable binding and does not revoke that target. All three are terminal durable delivery outcomes; errors are not acknowledgments. A not-yet-issued exact target can be preemptively revoked; delayed issuance of that grant ID then fails closed. A conflicting future binding remains fenced by the tombstone. No broad project/worker/epoch revocation is inferred here.

## Durable state, resource and replay limits

All configurable limits may only be reduced from `HARD_LIMITS`. They are part of the immutable constructor binding. Reopening with another environment, authority or limits fails without repairing or rewriting evidence. Schema is compared exactly with a fresh in-memory reference; changed/partial/foreign schemas and integrity failures are rejected. There is no automatic migration, reset, archival rollover, deletion or ambiguous-operation recovery API.

| Limit | Hard default |
|---|---:|
| Lifetime grants | 32 |
| Lifetime read reservations | 128 |
| Single immutable read | 1 MiB |
| Cumulative reserved/sealed payload bytes | 8 MiB |
| Unresolved provider operations (SQLite aggregate) | 8 |
| Concurrent admitted calls per broker instance | 32 |
| Provider wait deadline | 10 seconds |
| Grant lifetime at first issue | 1 hour |
| Preemptive unknown-grant tombstones | 32 |
| Normal revocation journal commands | 128 |
| Reserved first-revocation command capacity | 32 issued + 32 preemptive |

The revocation journal has a total hard cap of 192 commands. Once its normal 128 commands fill, only a first matching revocation of an unrevoked target can use reserved slots; already-journaled exact-key replay always works. Grant/read capacity does not consume this reserve. Noisy new keys for already revoked or superseded targets are refused at normal capacity. Disk-full/I/O failure can still prevent a durable commit; callers must retain and retry delivery, never acknowledge on error. Reserved logical capacity is not a filesystem-space guarantee.

An immediate SQLite transaction atomically reserves `(grantId,requestId)`, exact size, per-grant byte consumption and global result-storage capacity before the first asynchronous provider read. Reads progress `reserved -> completed` with sealed verified bytes, or `reserved -> unknown`. Sealed bytes and identities cannot change. Failures never refund bytes or reservation capacity. Local concurrent same-key reads share one provider promise and debit. Cross-instance same-key contention fails closed: the second caller marks an unowned reservation unknown and the original caller cannot seal it. There is no cross-process promise sharing or second provider execution.

A reservation found after restart has no trusted execution owner and is treated as unknown; the first replay durably marks it unknown. This blocks new execution for that exact key even if no result was received. A completed replay serves only the stored copied bytes, without a provider call or another debit. Every reply, including each concurrent waiter and each cached replay, rechecks current authority, local grant state, revocation and expiry. Issuer exact replay returns the immutable historical grant identity and creates no new authority or read permission.

Unknown operations permanently retain an unresolved-operation slot because the provider may still be executing. A timeout aborts the adapter, returns failure, retains the debit and ignores late results; local active resource accounting also retains the slot until the adapter settles. This conservative prototype may stop new work after eight ambiguous reads. Parent/operator recovery requires a separately reviewed reconciliation/rollover design; changing replay keys cannot bypass consumed budgets or unresolved capacity. Completed/unknown histories are never evicted to admit new side effects.

Rows, identifier lengths, JSON complexity, provider concurrency, waiters and reserved bytes are bounded. SQLite payload storage is at most 8 MiB, plus bounded metadata, page and journal overhead; this is not an 8 MiB whole-file cap. In-process result copies may include one per admitted waiter (up to 32 MiB at the per-read maximum), active provider results (up to 8 MiB), plus SQLite/transient copies. Returned byte arrays retained by the caller are outside the broker's ownership. The host owns SQLite lifecycle, private file permissions, journal/checkpoint policy and single-instance HTTP admission. SQL guards protect immutable identity, replacement, deletion, monotonic clock and permitted read transitions even across reopened connections. They do not protect against an operator able to rewrite the database/schema itself.

## Proof gates and local checks

Run from this package directory, using the existing repository executables:

```sh
../../node_modules/.bin/tsc --noEmit -p tsconfig.json
../../node_modules/.bin/vitest run --config vitest.config.ts --configLoader runner --cache=false
```

Tests exercise actual `node:sqlite`, not a SQL mock. File/restart/crash fixtures write only into this package's `.test-state` and remove their own case directories. Config uses runner loading and disabled caches to avoid writes outside the package. The package intentionally reuses the sibling `library-jobs/src/data.ts` inert-data/native-byte primitives and its public types without modifying that package. Integration changes to those helpers must retain their validation semantics.

RTD: structure = package/types/schema/docs; compilation = package and parent source typechecks; integration = actual local SQLite and sibling contract reuse; content = actual byte/hash/generation and authority binding checks; local journey = issue/read/replay/restart/revoke/ambiguous-crash tests. Executed counts and boundaries are in `REPORT.md`. Deployment, cloud/network operations, credentials/IAM, installation, spend, commits and pushes are NOT authorized and were not performed.

Before live use, parent-owned gates include authenticated HTTP routes and role isolation, reviewed live compute/catalog observation and durable revocation delivery, an actual bounded immutable-generation provider adapter, failure/recovery/rollover policy, operational storage permissions/backups and explicit owner activation approval. Local fixture authority/provider ports do not establish those live proofs.

Revocation cannot retract bytes that already left the broker/provider, erase bytes already delivered, or atomically synchronize compute, catalog, broker and storage. A revocation may commit immediately after the final observation. The broker prevents further replies once it observes revocation and refuses stale completion; it makes no cross-authority atomicity or physical-transfer-stop claim.
