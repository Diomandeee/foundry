# Library project authority — local service

This is a locally tested metadata service, not a deployed Library. It owns per-project snapshot provenance, independent verifier references, competing candidates and canonical revision compare-and-swap. It neither holds bulk project bytes nor merges code. The existing merge gate retains code-merge authority.

## Host configuration

`LIBRARY_TRANSPORT_ENABLED` must be exactly `true`. Absence or any other value disables transport. `LIBRARY_ENVIRONMENT`, `LIBRARY_AUTHORITY_NAME`, `LIBRARY_AUTH_CONFIG`, `LIBRARY_PROJECTS` and the SQLite `LIBRARY_CATALOG` Durable Object binding are required for a configured service. There is intentionally no deployment script or active production binding in this slice.

`LIBRARY_PROJECTS` is a JSON array of up to 100 exact records:

```json
[{"projectId":"project-a","policyVersion":"v1","ownerPrincipal":"owner-a","writerPrincipal":"writer-a","verifierPrincipal":"verifier-a"}]
```

The three project principals must differ. The entire map is validated before routing. Changes to a persisted project's authority/policy binding require a future reviewed migration; a restart must not relabel old evidence. `LIBRARY_AUTH_CONFIG` uses the existing compute transport format: a bounded array of token SHA-256, principal, role and environment records. Only secret references belong in operational handoffs; never copy real bearers into this file. Empty maps revoke every caller. Invalid host configuration returns a generic 503; rejected credentials return 401.

The service maps transport `submitter` to catalog `writer`; `owner` and `verifier` retain their roles. Both the outer router and actual project object enforce the configured project principal. Callers cannot supply their actor, policy or object identity. Authentication and project policy are rechecked after the bounded body read. The object ID must equal the configured environment/authority/project name even when a request reaches an object directly.

## API

Only HTTPS POST requests to these exact paths are accepted; query parameters and extra envelope fields are rejected:

- `/v1/library/<configured-project>/commands`: `{ "operation": "...", "key": "stable-command-id", "body": { "version": 1, "...": "..." } }`
- `/v1/library/<configured-project>/snapshot`: `{}`; project owner only.

Commands and their exact bodies are defined in `packages/library-catalog/src/types.ts` and that package's README. Accepted commands return `accepted:true`; canonical contention returns HTTP 409 with a stable historical `accepted:false` reply while preserving the competing candidate. Reusing a command key for another principal or payload is rejected. The durable reply and domain rows commit together. Unexpected storage or downstream errors return generic no-store 503 JSON without internal details.

Each project admits at most four writer, four verifier and two separately reserved owner requests while processing bodies/commands; excess requests return 429 before allocating the body buffer, and every exit releases its slot. These are local service limits, not a platform-wide memory guarantee.

The request body is bounded to 64 KiB while streaming, with a deadline inherited from the shared compute helper. Domain envelopes and retained records have smaller limits. This read model is a bounded owner snapshot, not a paginated browse UI, backup or full journal export.

## Job evidence bridge

`src/evidence.ts` maps a strictly validated read-only Library verification job to a catalog transfer binding. It retains project/policy version and hash; manifest key, generation, digest and size; compute authority, epoch, workload, generation, attempt, lease ID, capability digest, worker and numeric incarnation. A capability digest is a non-authorizing reference; no raw capability or cloud session URL belongs in the binding.

`prepareTransferAttestation` verifies actual bounded fixture/adapter bytes and trusted current compute acceptance before preparing a verifier command body. It carries acceptance expiry into the catalog. The manifest is the bound catalog object; its digest pins the complete independently checked object set. The helper does not submit HTTP, dispatch a job, publish a snapshot or promote canonical state. An authenticated project verifier must submit its output. A writer's structurally valid worker report cannot replace that verifier role.

The byte-read and compute-observation ports are trusted host adapters. Their fixtures test the contract; this slice does not implement live GCS reads, a storage broker, compute cancellation delivery or a production verification job handler. A compute revocation occurring after observation is not atomically visible to a separate catalog. A future durable reconciler must cancel/reauthorize catalog intents before that live path can be enabled. Catalog cancellation, authorization generation and expiry are already enforced transactionally.

## Local checks and operating limits

The test fixture uses actual workerd and persistent local SQLite, disables account registration and telemetry, and contains test-only clock/fault/config controls. Those controls are not in the production entry point. It does not claim enforced outbound network isolation. No cloud calls or host installations are required by these fixtures.

The catalog is intentionally bounded for local verification: up to 32 staged intents, 192 normal records and 33 reserved cancellation/revocation records; 1,024 normal command replies and 33 control replies. These are permanent lifetime ceilings, not rolling quotas. No automatic pruning, migration or rollover is implemented. Operational activation requires a reviewed retention/restore strategy preserving the full reply journal and stale fences. `snapshot()` alone is not sufficient backup.

Run focused tests with the repository's Vitest runner and typecheck. Parent evidence lives at `evidence/library-catalog/` in the integration home. Actual deployment, IAM/secret distribution, spending, host activation, live broker integration and full independent catalog recovery remain gated.

## Revocation and full service recovery additions

Additional owner-only routes are `/v1/library/<project>/revocations`, `/export`, `/restore`, `/recovery-status` and `/reconcile-recovery`. Revocations use `{delivery}`; export/status/reconciliation use `{}`. Restore accepts exact raw UTF-8 service archive bytes with media type `application/vnd.foundry.catalog-recovery+json` and separately trusted `x-catalog-archive-sha256`. No request supplies a trusted context, storage adapter selection or reconciliation proof. The existing feature flag still disables transport by default.

Catalog checks/cancellation and every terminal delivery outcome commit atomically. Delivery receipts retain the semantic request/reply; retries with another relay claim revision return historical truth, while changed semantic payloads reject. Applied receipts reserve32 slots separately from256 terminal noops. A superseded reply never authorizes a later generation; the host must register a new target for every new authorization.

Service export wraps the full catalog command journal and immutable delivery receipts under its own digest. This differs from the core recovery package's archive format. Import requires an entirely empty dedicated destination and restores both inside one transaction; it never overwrites an initialized target. Actual DO callers select the Cloudflare storage adapter explicitly; native SQLite recovery retains its original attached/temp/identity checks. The service archive is capped at16MiB total; export fails rather than dropping records to fit.

Every import atomically creates a new persistent quarantine guard. Readiness is never imported. Normal commands and historical write-reply replay remain blocked; owner inspection, export, cancellation, policy revocation and durable delivery remain available. The guard also blocks an older backup from reviving an authorization whose cancellation was already acknowledged by a surviving relay. Restore is exclusive while its body streams, and requests admitted before it began cannot initialize/mutate the destination afterward. BOM bytes are preserved for exact-pin rejection and deadlines are checked after reads, including EOF.

`host.reconcileRecovery` is a trusted optional DI port, not an HTTP body field. Without it, reconciliation returns503 and the restored service stays quarantined. Before returning proof, the host must consult an independent latest-approved service-archive checkpoint, observe every remaining current compute fence, register its new restore/generation target and catch the independent relay cursor up through the observed source head. The service checks restore identity, archive pin, freshness, full bindings and target/watermark coverage, rechecks owner identity after await, then atomically cancels invalid attempts before marking ready. A checkpoint echoed from the imported backup is insufficient; no production checkpoint/reconciliation adapter is configured by this slice.

Recovery excludes broker, relay and compute databases, host configuration and provider sessions. Separate content rehearsal verifies exact manifest/object bytes; metadata restore alone is not content, whole-bucket or whole-fleet recovery. Current architecture/review/proof limits are in integration/evidence/library-resilience/ARCHITECTURE.md and VERIFICATION.md.
