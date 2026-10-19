# Durable worker enrollment — local domain

`WorkerEnrollment` owns enrollment records only. It shares the compute authority's iterable `sql.exec` / synchronous `transactionSync` port structurally, with no dependency on compute or runtime packages. No install, deployment, network mutation, token generation, raw-token input/output, callback registration, compute registration, or quarantine operation occurs here.

## API

Import the class and types from `src/index.ts`. Exact public types are in `src/contracts.ts`.

```ts
new WorkerEnrollment(storage: TransactionPort, options: Options)
enroll(owner: OwnerContext, request: EnrollRequest): MutationResult
revoke(owner: OwnerContext, request: RevokeRequest): MutationResult
authenticateDigest(tokenSha256: string): ExecutorBinding | null
heartbeat(binding: ExecutorBinding, request: HeartbeatRequest): EnrollmentStatus
requireFresh(binding: ExecutorBinding): EnrollmentStatus
status(owner: OwnerContext, query: {afterWorkerId: string | null; limit: number}): {
  workers: EnrollmentStatus[]; observedAt: number; heartbeatFreshnessMs: number;
}
```

Signatures above describe methods, not standalone functions. `Options` fixes `environment`, `authorityId`, optional trusted `now`, and persisted freshness/admission/capacity policy. Schema version is 2. Version 1 candidates are rejected without migration or evidence pruning. `OwnerContext` is `{role:'owner', principal:string}`; it must come from the parent's verified owner identity. Executor contexts must come from digest authentication, never request-body identity claims. This is a trusted in-process domain, not a bearer parser or authorization middleware.

`ApprovedIdentity = {workerId,principal,workerClass,cpu,ramMib,devices}`. Class is `general | edge`; devices are `{id,kind:'cuda'|'metal',vramMib}`. IDs and request keys are 1–64 ASCII letters/digits/`.`/`_`/`-`. Exact shapes reject unknown fields. Device order is canonicalized, IDs are unique, and numeric fields require safe integers. General workers require positive CPU/RAM; edge requires zero CPU, zero RAM and no devices. Bounds match compute: CPU ≤65536, RAM/device VRAM ≤1073741824 MiB, ≤64 devices. Owner-approved capacities should already exclude the host's operating reserve; this package cannot measure physical availability or enforce host resource isolation.

`EnrollRequest` adds `{key, tokenSha256, expiresAt, expectedRevision, incarnation}`. `expiresAt` is absolute server milliseconds. Initial `expectedRevision` is 0; initial incarnation may be 0. Later versions require exactly current revision +1 through CAS and strictly higher incarnation. Each worker's principal, class and complete approved geometry remain immutable across all versions. Changing geometry requires a separately reviewed identity/migration flow. Principal is unique per worker in the namespace. Digest is lowercase SHA-256 hex, globally unique across all retained credential versions in this namespace; expired/revoked digests can never be rebound. A successful new version immediately supersedes all previous digests, even if they were never explicitly revoked. No digest is returned in statuses or audit results.

`ExecutorBinding = {role:'executor', workerId, principal, revision, incarnation}`. No arbitrary role can be produced by lookup. Lookup returns null for unknown/expired/revoked/superseded digests; malformed digest input throws. Authentication deliberately permits stale heartbeat state so an active executor can recover through heartbeat. Lookup does not inspect the compute incarnation; parent compares it with actual core state before admitting execution.

`HeartbeatRequest = {key,sequence,observedIdentity}`. Sequence starts at 1 per version and must increase exactly by one. Heartbeat checks current revision/incarnation/principal and exact observed identity before considering idempotency. Only the exact latest key/sequence/request can replay its original historical heartbeat result and **never refreshes lastSeen**; consumers must use `requireFresh` for a current freshness decision. Changed payload under the latest key conflicts. Older sequences reject even if their keys were previously accepted. Replay history is deliberately limited to the latest heartbeat per credential, rather than retaining every key. No heartbeat can edit approved capacity or revive a credential. A persisted `heartbeatMinIntervalMs` policy defaults to `min(1000, heartbeatFreshnessMs)` and must be between 1 and the freshness window. Each worker/version independently rejects a new sequence before this interval with `heartbeat-rate-limited`; exact latest replay bypasses rate admission without changing liveness. No shared heartbeat count or permanent audit budget exists.

Freshness defaults to 60000 ms, configurable from 1 to 300000 and bound to the database on first initialization. Fresh means `serverTime - lastSeen < heartbeatFreshnessMs`; equality is stale. Never-seen credentials fail `requireFresh`. Expired/revoked/superseded credentials fail heartbeat and freshness checks. The committed server-clock high-water mark is monotonic across restart; rejected or rolled-back transactions do not commit observations. Status and authentication persist its high-water mark. Status supplies observation time and `never-seen | fresh | stale | inactive`, with lastSeen and expiry/revocation. It never claims a worker is connected. Owner reads are keyset-paginated, at most 128 current worker versions, without credential digests. No historical audit read route is exposed.

## Mutation results and parent composition

`MutationResult = {status: EnrollmentStatus, applied:boolean, replayed:boolean, isCurrent:boolean}`. Status contains identity, worker/principal, fixed executor role, revision/incarnation, expiry/revocation, lastSeen, sequence and freshness. Every accepted enrollment/revocation records an immutable audit event with actor, operation, key, request hash, worker/version, server time and historical result. Permanent lifecycle idempotency is `(actor,operation,key)`; these results and request hashes cannot be overwritten or deleted. Heartbeats instead update a separate bounded latest-liveness/replay row per credential, atomically with credential lastSeen/sequence; prior heartbeat snapshots are not permanent lifecycle evidence. Rejected requests throw `EnrollmentError` with a stable `.code` for API validation/fencing; unexpected SQL errors (including SQL capacity backstops) propagate and roll back. Rejections do not consume immutable command/audit space. This package does not issue credentials, test credential entropy, or log caller payloads.

Owner enrollment replay is allowed only while that version is current and active. It returns current status with `applied:false,replayed:true`. An old enrollment command cannot reactivate an expired/revoked/superseded version. Revoke targets an explicit `{key,workerId,revision}`. It is irreversible for that credential, including expired historical versions. Revocation replay returns historical status with `applied:false` and recomputes `isCurrent` against today's latest version. Repeating a completed revocation under a different key rejects with `already-revoked`; only the original scoped key receives successful replay. Rejected requests do not reserve keys. At most one revocation event exists per credential.

Parent must establish one outer synchronous transaction on the **same storage**. Nested `transactionSync` must compose atomically (native nested transactions/savepoints or a synchronous join adapter); do not use a naive adapter that issues nested SQL BEGIN. No async/thenable callbacks or separate databases belong in this transaction.

- Enroll: validate parent epoch and actual core incarnation; call `enroll`; register exactly `result.status.identity` only if `applied`. A rejected core result must be converted to a throw so all enrollment/audit changes roll back. Replay must not reset core registration or quarantine.
- Revoke: call `revoke`; quarantine only when `applied && isCurrent`, and only after checking current core incarnation equals the returned credential incarnation. Pass that incarnation as `expectedIncarnation`. Replay or historical revocation must never fence a successor. Core owns lease fencing, incarnation increment, reservation quarantine and stop-proof reconciliation; enrollment never releases resources or clears quarantine.
- Executor: strictly hash the supplied bearer in the parent; use only returned worker/principal/version scope; reauthenticate after awaits. Require current enrollment and core incarnation plus `requireFresh` for claim/renew/upload. Permit active stale executors to heartbeat. Managed-mode static executor configuration must not bypass lookup or revocation. Static owner/verifier policy and expectedEpoch remain parent responsibilities.

No callback is registered here, and no enrollment success is evidence that a process was installed, running, isolated, connected or stopped.

## Capacity, audit reserve and SQL guards

Default retained bounds: 128 workers, 4096 credential versions, 65536 immutable events. Options may lower these bounds, with `maxEvents > maxCredentials`; policy cannot change on reopen. No deletion/GC API exists. Enrollment writes stop when lifecycle event count reaches `maxEvents - maxCredentials`. The remaining `maxCredentials` slots are reserved exclusively for the single possible revocation event per retained credential. Revocation remains possible after enrollment journal exhaustion. New enrollment rolls back completely if its audit insertion cannot fit. Executor traffic cannot consume lifecycle journal capacity. Heartbeats use at most one bounded liveness row per retained credential (4096 maximum by default), replaced in place on the next admitted sequence. They continue independently when the lifecycle non-revocation budget is full. Liveness/storage failure rolls back its lastSeen, sequence and replay response together. Capacity is conservative and permanent; superseded identities still consume their credential and potential revocation slot. This limits record counts and payload sizes, not total SQLite billing, host disk capacity or global traffic. Capacity policy changes/retention/namespace migration require separate review.

SQL guards reject identity/lifecycle-audit updates, deletes and INSERT OR REPLACE, even when recursive triggers are disabled. Credential digests, worker/version/incarnation, issue/expiry times cannot be edited. Version insertions enforce monotonic CAS/incarnation, global digest uniqueness and capacities; heartbeat updates enforce sequence, current version, clock and expiry; revoked rows cannot be updated at all. Direct SQL identity inserts enforce class/capacity/device bounds. Liveness SQL guards enforce one row per credential, monotonic next sequence/current version, and prevent deletion/replacement or changes after revocation. Application transactions couple lifecycle mutations with immutable audit and heartbeat state with its latest replay record. The trusted database owner can still drop triggers, destroy or restore the database; this is application immutability, not tamper-proof storage.

## Local verification

From `source/`, using existing dependencies only:

```sh
./node_modules/.bin/vitest run packages/worker-enrollment/src/enrollment.test.ts --no-cache
./node_modules/.bin/tsc --project packages/worker-enrollment/tsconfig.json --pretty false
```

Tests use actual Node SQLite, including a database closed/reopened on disk under this package. The 20-contender checks are explicitly serialized synchronous CAS tests across separate domain instances, not a multi-process SQLite locking benchmark. Fault tests cover coupled outer-transaction rollback, lifecycle audit failure and liveness failure. Busy-worker tests admit 1000 heartbeats with one liveness row and unchanged lifecycle event count, then prove independent worker enrollment/heartbeats and revocation safety reserve. File restart preserves exact latest replay. These are bounded logical row/payload guarantees; SQLite file/WAL maintenance belongs to the host. Parent owns actual workerd route tests, static-executor bypass tests, cross-principal transport enforcement and compute quarantine integration. No deployment was attempted.
