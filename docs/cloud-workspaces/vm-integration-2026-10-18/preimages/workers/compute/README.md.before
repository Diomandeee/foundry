# Compute authority transport and sealed artifacts

This is a local implementation. No deployment configuration, accounts, credentials, or cloud resources are created. Transport is off unless the host explicitly configures `COMPUTE_TRANSPORT_ENABLED=true` together with all bindings below.

## Authority and identity

`AUTHORITY` must bind a SQLite Durable Object namespace exporting `ComputeAuthority`. `COMPUTE_ENVIRONMENT` and `COMPUTE_AUTHORITY_NAME` select a fixed object name; clients cannot select objects. The issuer ID/key remain trusted host bindings, independently required by the durable core. `COMPUTE_AUTH_CONFIG` is a JSON list of `{tokenSha256,principal,role,environment}` entries. Only SHA-256 digests of high-entropy bearer credentials belong in that configuration. Provisioning, credential delivery, expiry/rotation/revocation operations and deployment require a separate owner-approved rollout; this change creates only test credentials in local fixtures. Never put a real bearer or issuer key into repository files, CLI arguments, logs or handoffs.

The authority verifies the original Authorization header itself. Roles are owner, executor, verifier, projector and submitter. Identity headers/body fields do not grant authority. TLS is mandatory. Transport handles no browser cookie identity and emits no CORS permission. Invalid credentials fail closed; removing/replacing a configured digest revokes that credential when the new configuration is actually applied. No token-rotation control plane or distributed rate limiter is implemented.

## HTTP contract

POST JSON only, with exact envelope fields:

- `/v1/workload`: `{expectedEpoch,workloadId}`; authenticated owner-only, one bounded immutable-spec workload row or null, fenced against the current authority epoch. This point lookup avoids loading unrelated history; mutation commands still reconcile lease expiry and enforce generation CAS.
- `/v1/status`: `{}`; authenticated owner-only, read-only epoch/environment/authority/schema discovery. It returns no issuer material and grants no stale write permission. This lets dispatchers recover epoch hints before a fenced snapshot/command.

- `/v1/commands`: `{expectedEpoch,command:{key,operation,body}}`; existing domain roles and fences apply. Direct `stageResult` is forbidden; submit policy maxBytes cannot exceed 1 MiB.
- `/v1/artifacts`: `{expectedEpoch,key,fence:{leaseId,epoch,generation,incarnation,capability},bytesBase64,exitCode}`; executor role only. Uses canonical base64. Actual bytes determine their hash and length; the caller cannot provide a trusted pointer/hash. A live matching lease owned by that principal is mandatory.
- `/v1/verify`: `{expectedEpoch,request:{key,leaseId,epoch,generation,incarnation}}`; verifier role, independent byte reader, and transactional post-read fences apply.
- `/v1/snapshot`: `{expectedEpoch}`; owner only. It is an administrative view, not a tenant dashboard.
- `/v1/artifacts/read`: `{expectedEpoch,reference}`; owner/verifier only. Returns bounded verified bytes, not arbitrary SQL or bucket keys. References are not bearer capabilities. Tenant/executor download is deliberately unexposed.

Domain replies preserve `{ok,code}` and replay semantics, including rejection replies. HTTP 401/403 are authentication/transport-policy failures; invalid envelope is 400, excessive body 413, artifact conflict 409, byte capacity 507, unexpected storage failure 503 (retry with the same key). Configuration-disabled transport is 503. No responses echo credentials. Request reads have a ten-second absolute deadline and a 65,536-read limit; empty chunks consume no buffered space. Request bodies are capped during streaming: 70,000 bytes for commands and 1,450,000 for upload envelopes.

## Immutability and atomicity

The sealed store lives in the same private SQLite authority database as accepted staging metadata. One byte record per lease; references derive from a versioned lease-ID/content-hash tuple. Immutable SQL triggers prohibit update, deletion and replacement. Hash/length/reference are rechecked on every read. The independent verification callback also checks the sealed record against its server-derived lease ID, so even trusted-host staging of a foreign pointer cannot pass verification. A different lease cannot select a foreign sealed pointer through HTTP: upload constructs its reference from its own lease and actual bytes.

Upload performs sealed insertion and the durable stageResult command in one synchronous outer transaction. Rejected lease/capability/epoch/policy, idempotency conflict, or storage/outbox failure rolls back new bytes and all coupled domain changes. Successful redelivery returns the same seal; a conflicting body cannot overwrite it. The core continues to read independently of caller assertions and rechecks all fences before recording its immutable receipt.

Artifacts are limited to 1 MiB each and 64 MiB aggregate sealed bytes per authority. Admission reserves maxBytes × maxAttempts per workload in the same transaction as submission (and before an existing workload receives a claim). Outstanding commitments and retained artifacts therefore cannot overbook the cap. Legacy workloads without a budget are included at their full worst-case commitment, including active unsealed leases; upload also reserves before sealing. Existing legacy overcommit fails closed pending reviewed migration. Reservations are conservatively permanent; cancellation or small outputs do not reclaim unused budget. The cap excludes SQL/audit overhead; it is bounded-output admission, not a storage billing quota. No garbage collection, delete API, bucket migration, large media support, global admission rate control or physical process stop is implemented. Operator-level database destruction/restore is outside this application immutability boundary. Recovery/retention/schema migration must preserve receipts and sealed bytes and require a separate reviewed design.

## Local evidence

Tests use workerd/Miniflare and disposable local SQLite directories, with no account calls. The actual Worker and authority class cover authenticated submit, claim, sealed upload, restart/lost-response retry, independent verification, receipt replay and download. Fault injection checks byte/domain/outbox rollback; competing uploads and SQL overwrite/delete attempts test immutability. Focused Node tests cover authentication and store integrity. Full results and review findings are in the task's `outputs/foundry-transport-artifacts-2026-10-16` folder.

The existing merge gate remains sole merge authority. Fleet execution, enrollment ceremony, process-stop attestations, remote pilot, D1 consumer and dashboard UI remain separate work.


## Managed fleet enrollment — local implementation

Set COMPUTE_ENROLLMENT_ENABLED only through reviewed host configuration. Once a database enters managed mode it cannot restart with the flag disabled. The fleet schema/namespace binding rejects pre-metadata or incompatible local candidates instead of silently repairing them. No migration is supplied. Static owner/verifier identities remain host configured; all executor credentials must resolve to an active enrolled digest. Static executor entries cannot bypass revocation. The original header is reauthenticated after body streaming.

POST /v1/enrollment/{enroll,revoke,heartbeat,status,profile} uses `{expectedEpoch,request}` with exact package request fields. Owner enrollment approves immutable identity/geometry and token digest/expiry, never issues or returns a bearer. Registration commits in the same transaction. Revocation commits with current-incarnation lease fencing and resource quarantine. Replayed old revocation cannot fence a successor credential. Rotating to a newer credential incarnation never clears quarantine or proves the old process stopped.

Heartbeat uses per-credential monotonic sequence and exact latest-reply recovery. Latest replay does not refresh lastSeen. Per-worker minimum interval and bounded mutable heartbeat state prevent permanent audit exhaustion by heartbeats. Permanent enrollment/revocation evidence retains reserved revocation capacity. Freshness is liveness observation, not connection or stop proof. Pi/edge identity has zero CPU/RAM/devices and cannot execute.

Owner-only profile approval receives `{workerId,revision,profile}`. The full fixed runtime profile must use a digest image in host COMPUTE_EXECUTION_IMAGES and fit the approved worker. One immutable profile per credential revision records actor, time and canonical profile hash. No image, runtime or key is installed by this operation.

POST /v1/worker/poll uses `{expectedEpoch,request:{key,sequence,ttlMs,profileHash}}`. It requires current fresh enrolled identity, matching worker incarnation and no quarantine. Profile digest and feasible lease duration are checked against approval BEFORE claim; CPU/RAM matching is exact. No approved profile yields idle with execution-profile-required, never a lease. Direct managed claim commands reject approved-poll-required. Only the validated pure epoch-event-summary template is offered. A rotating bounded scan can progress past rejected candidates; speculative rejections do not create command history.

The latest poll head is retained per credential (at most 4096). Exact head replay returns the same result; next sequence must advance by one, older or changed requests reject. Successful claim, small-output commitment and head response commit together. Idle polling does not consume a permanent shared event budget. Head rotation is not a complete poll-request log; successful leases/attempts remain in the existing compute audit.

The host client validates returned profileHash, lease identity, deadline, exact allocation and output. It persists execution ambiguity before invoking the runtime, refuses repeat execution after a crash, and uploads only verified stopped output. Upload is staging; a distinct verifier still decides acceptance. Runtime uses a mandatory private empty Docker configuration directory and explicit local activation gate. Local fake Docker/actual benign child tests do not prove real container isolation.

Readiness and rollout limits are recorded in the integration home’s evidence/fleet-enrollment directory. Live deployment, per-device credential provisioning, host installation, image vetting/preload, real daemon limits, monitoring and stop/reconciliation drills remain gated. This slice installs none of them.
