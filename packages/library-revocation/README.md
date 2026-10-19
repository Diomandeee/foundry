# Library revocation relay

`RevocationRelay` retains a compute fence feed and schedules generation-bound revocation deliveries to registered catalog or storage-broker targets. It owns an independent source cursor: consuming this feed does not acknowledge or advance the compute projection outbox.

This is a local library over injected storage and delivery ports. A live authenticated delivery host/transport is not installed or verified by this package's tests. There is no atomic cross-authority guarantee: a compute revocation may commit before a separate catalog or broker observes it. Delivery success does not grant publication, canonical promotion, restore, deployment, or Git merge authority. See the [Library architecture](../../../DISTRIBUTED-LIBRARY-ARCHITECTURE.md), [documentation policy](../../../DOCUMENTATION-POLICY.md), and [architecture decision](../../../docs/compute-fabric-v2/evidence/sources/execution-plan/01-ARCHITECTURE-DECISION.md).

## Host contract

Construct `new RevocationRelay(transactionPort, options)` with `environment`, `authorityId`, `sourceAuthorityId`, distinct `ownerPrincipal` and `dispatcherPrincipal`, and optionally `now: () => number` in milliseconds. Configuration is durably bound to the database. Reopening requires the same binding and exact expected schema; mismatches reject without replacing evidence. There is no automatic schema migration or evidence pruning.

`TransactionPort.sql.exec(query, ...bindings)` returns iterable rows. Its synchronous `transactionSync(fn)` must serialize writers and roll back **every** write if the callback throws. Callbacks must not be asynchronous. Production hosts must supply this guarantee; an adapter that merely invokes the callback is insufficient. Constructor schema creation, feed ingestion, target registration, claims and settlement depend on it.

Every operation receives an identity-bound `{ environment, principal, role }` context from a trusted host. Owner and dispatcher roles must match their configured principals; a caller-supplied role label is not authentication. The owner registers targets, inspects snapshots and recovers blocked deliveries. Owner or dispatcher may read the cursor, ingest pages, claim, settle and call `deliverOne`.

## API

| Method | Behavior |
| --- | --- |
| `cursor(context)` | Returns the independent contiguous source position. |
| `ingest(context, page)` | Accepts a version-1 `FencePage` bound to the configured environment and source authority. Requires consecutive event sequence numbers from `after + 1` through `through`, with `through <= head`. Exact retained-page replay is idempotent; conflicting duplicates, gaps and wrong sources reject. Noops advance the cursor without becoming revocation evidence. Empty head polls do not advance it. |
| `register(owner, target)` | Retains a version-1 catalog or broker target and checks previously retained revocations. Repeating the exact target is idempotent; changing an existing target ID conflicts. A matching target registered before a fence gets the same eventual delivery behavior as one registered afterward. |
| `claim(context, ttlMs = 10000)` | Returns one leased `Delivery`, or `null`. TTL is 1–30 seconds. Each lease increments revision and lifetime attempts. An expired lease can be reclaimed with a new revision. |
| `settle(context, settlement)` | Accepts `{ deliveryId, revision, outcome, receipt }`, with outcome `ack`, `retry` or `blocked`. Settlement must refer to the current unexpired claim; exact settlement replay is idempotent. An ack requires a bound receipt; retry/blocked require `null`. |
| `recover(owner, deliveryId)` | Reopens a blocked delivery, increases its lifetime budget by 32 and preserves its attempt count. Rejects at the 1024-attempt budget ceiling. |
| `deliverOne(context, deliveryPort)` | Claims and invokes `deliver(delivery)`. Returns `idle`, `acked`, `retry` or `blocked` as `{ status }`. A transport exception or five-second deadline schedules retry; malformed/wrong acknowledgements block for owner recovery. Storage failures reject the promise and must remain visible to the host. |
| `snapshot(owner)` | Returns retained targets, non-noop events, cursor and delivery state for local inspection. |

A target includes its destination authority, project/resource identity and generation, plus the full `TransferBinding`: project, policy version/hash, compute authority/workload/lease/attempt/capability digest/worker/epoch/generation/**numeric incarnation**, and content manifest/object hashes, scoped object key, object generation and byte length. The destination must validate this complete binding and its own generation when applying the revocation; merely recognizing a target ID is insufficient.

Fence matching uses these source scopes:

- Lease revocation requires equal lease, workload, worker, epoch, generation and incarnation. A newer attempt using a new lease remains unaffected. The feed has no attempt-ID field: changing only an attempt ID while reusing the same lease is not a distinct fence scope.
- Epoch bump matches compute epochs strictly below the new epoch.
- Worker quarantine matches the same worker with a strictly older incarnation.
- Workload cancellation matches the same workload with generation at or below the cancelled generation.

The first matching retained event creates one delivery per target. Later matching events do not replace that delivery or its evidence. Register a distinct immutable target identity for a distinct destination binding/generation.

## Delivery and replay

`Delivery` contains `version`, `deliveryId`, claim `revision`, `target`, `event`, `evidenceId` and stable `key`. The evidence ID is SHA-256 of canonical `{ source: sourceAuthorityId, event }`. The key equals the delivery ID and remains stable across claim revisions and relay reconstruction.

The delivery port returns a version-1 `DeliveryReceipt` containing the exact `deliveryId`, `evidenceId`, `targetId` and a status of `revoked`, `already-revoked` or `superseded`. A valid acknowledgement means the destination reports that bound outcome; it is not independent proof of destination state. The host must authenticate the destination and wire the actual catalog/broker delivery method to this port.

The destination must durably deduplicate the stable key with its revocation transaction. A lost response after destination commit causes replay with the same key and a newer relay revision. The five-second deadline does not cancel the underlying transport: a timed-out request can still finish. Stable-key idempotency is therefore required even after retry. Claims fence relay acknowledgements; they do not provide exactly-once network execution.

Retry delay starts at one second and doubles to a maximum of 60 seconds. The initial lifetime budget is 32 claims. Exhaustion blocks further claiming until owner recovery adds 32 attempts, up to 1024. Wrong receipts also block; recovery does not erase attempt history. A storage failure while recording an ack or retry must propagate rather than falsely report persisted progress.

## Retention and limits

Pages contain at most 64 events. Storage retains at most 1024 pages, 512 non-noop events, 128 targets and 128 deliveries. Event JSON is limited to 2048 bytes and target JSON to 8192 bytes at the SQL boundary; input canonicalization/validation may impose additional limits. Immutable evidence rejects update, delete and identity replacement, including `INSERT OR REPLACE`. Delivery identities are retained, revisions/attempts/budgets cannot move backward, and acknowledged rows cannot be rewritten.

Capacity exhaustion fails the whole affected transaction and retains prior evidence. Existing pending deliveries can still be claimed and settled at capacity. Limits are not an eviction policy. Hosts need an explicitly reviewed lifecycle/migration design before using this bounded store for an unbounded feed.

## Focused local verification

From `source`, using existing dependencies and a Node runtime with `node:sqlite`:

```sh
node node_modules/vitest/vitest.mjs run packages/library-revocation/src/relay.test.ts --cache=false
node node_modules/typescript/bin/tsc --ignoreConfig --noEmit --incremental false --strict --skipLibCheck --target esnext --module esnext --moduleResolution bundler --types node packages/library-revocation/src/relay.test.ts
```

The tests use real in-memory SQLite with `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK`, full transfer fixtures, identity-bound contexts, injected storage failures and simulated destination delivery. Reconstruction reuses retained SQLite state; it is not a disk/process-crash durability test. The 20-claimer check races separate relay instances through one serialized transaction port in one process; it does not establish multiprocess scheduling or production storage behavior. No network endpoint or installed delivery host is exercised.

Initial delegated run on 2026-10-17 (historical; superseded below): **44 passed, six failed out of 50 tests**. Focused TypeScript compilation passed (exit 0). All six failures expose `SCHEMA_MISMATCH` on reconstruction: the constructor extracts table names with `sql.split(' ')[2]` even though table DDL has no space before `(`, producing names such as `library_revoke_meta(id` instead of `library_revoke_meta`. This prevents valid reopen and masks binding mismatch. The implementation owner can strip the parenthesis suffix when extracting the name while retaining exact SQL comparison. Regression expectations remain strict. This was a local implementation blocker; the parent fixed it without replacing retained evidence.

RTD scope: structure and content inspected; focused compilation, integration and local simulated user journey checked as recorded above; the initial six reconstruction failures were subsequently closed by the parent fix. Deployment, installation, live transport, cloud checks and full-repository test validation are outside this package receipt and are not authorized by it.

## Parent integration and current validation

The initial six constructor-reopen failures recorded above were fixed by extracting table names without their opening parenthesis. The package now passes the full50-case relay suite in parent aggregate runs. Added HTTP tests cover fixed origins/credential references, source binding, abort/deadline/body bounds and streaming503 cleanup. Current final totals and review closure are in integration/evidence/library-resilience/VERIFICATION.md.

Compute worker quarantine annotations are compact-feed noops because success also quarantines resources. Actual revoked sibling leases retain explicit full-fence invalidations. Source cursor progress never acknowledges the existing projection outbox and remains readable after another consumer acknowledges it. Target terminal replies are durable in catalog service archives; new authorization generations require new registered targets.
