# Library catalog implementation receipt

Scope: `/Users/mohameddiomande/Developer/foundry-integration/source/packages/library-catalog` only. No service, jobs, gate, architecture root, task ledger or historical evidence files were edited. Directory was created with `mkdir -p` and files verified with `ls -la`. Test cache and transient SQLite files were confined to this package; tests removed only their own transient databases. No subagents/background work were dispatched.

## Delivered files and API

- `src/index.ts`: public exports.
- `src/types.ts`: options/context/envelope/body/reply/snapshot/port/binding types and `LibraryRejected`.
- `src/catalog.ts`: synchronous transactional command domain, immutable evidence, replay, authorization fencing and canonical CAS.
- `src/schema.ts`: exact versioned SQLite namespace and immutability/replacement/capacity triggers.
- `src/validation.ts`: canonical inert JSON, strict runtime shapes, project/object/compute fence validation and bounds.
- `src/catalog.test.ts`: 26 node:sqlite tests.
- `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`: private package, no-emit compile, package-local test artifacts.
- `README.md`, `API.md`, this receipt: current API, trust/expiry semantics, limits and evidence boundaries.

Public API: `LibraryCatalog(port, options)`, `execute(context,envelope)`, `snapshot(context)`. Final transfer binding includes required policyHash; attempt/capability digest/worker/numeric incarnation; and the immutable manifest object generation/hash/size. Attest body includes the complete binding plus attestedAt/expiresAt. Parent host maps authenticated owner/submitter/verifier to separately configured owner/writer/verifier principals and owns all transport/compute/jobs adapters.

## Executed checks

Working directory for both commands was this package. Existing dependencies were used; no install was run.

```sh
/Users/mohameddiomande/.nvm/versions/node/v24.12.0/bin/node ../../node_modules/typescript/bin/tsc --project tsconfig.json
/Users/mohameddiomande/.nvm/versions/node/v24.12.0/bin/node ../../node_modules/vitest/vitest.mjs run --config vitest.config.ts --configLoader native
```

Final code check: TypeScript exit 0; Vitest exit 0, **26/26 passed**. Test runtime emitted Node's experimental SQLite warning. README/API-only updates followed that successful code run.

Evidence includes 20 independently opened catalogs sharing one disk database with exactly one canonical winner and 19 retained conflicts; disk reopen and stable replay; actor/request-bound mismatched-key rejection; injected failures before audit and after a first evidence write with complete rollback; generation/attempt/capability/worker/content fences; unauthorized verifiers; publish rejection after cancellation, policy revocation, local expiry or independent acceptance expiry; future attestation rejection; stale-candidate retention; separate verification/promotion; promotion of valid historical snapshots after transfer/acceptance expiry; all-table SQL UPDATE/DELETE/INSERT OR REPLACE rejection; incomplete schema/binding failures before repair; exact manifest path/32-digit generation validation; accessor/proxy/cycle rejection; immutable returned-data isolation; simultaneous 192-record/1024-command pressure with 32 cancellations and one revocation preserved; and maximum-identifier staging/reauthorization feasibility to prevent stranded intents.

The command-capacity pressure fixture inserts bounded journal rows directly to reach that quota, while domain commands fill real data capacity and exercise the entire safety reserve. This does not simulate 1024 successful production operations. Contender callbacks execute synchronously under SQLite BEGIN IMMEDIATE transactions; no overlapping worker-thread stress claim is made.

## RTD assessment

1. Structure: package exists with explicit exports and local config; final `ls -la` performed.
2. Compilation: strict local TypeScript no-emit check passed.
3. Integration: SQL iterable/transactionSync port follows epoch-chain and the parent's inspected Durable Object adapter. Parent reports actual-workerd transport tests, but this receipt claims only this lane's local node:sqlite checks. Final workerd/aggregate results belong to the parent.
4. Content: strict exact v1 shapes, bounded canonical request digests and immutable/audited lifecycle checks passed locally. Rows are attributed domain state; no actual bulk-byte verification is inferred.
5. User journey: local stage → host attest → publish → independently verify → candidate → CAS promote, including durable reopen/replay and rejection/recovery paths, passed.
6. Deployment: **NOT AUTHORIZED; not performed**. No commit/push/network/cloud/credentials/install operations were performed.

## Risks and remaining boundaries

This is a bounded local domain with lifetime capacity (192 normal records, 33 safety records, 32 intents, 1024 normal command rows, 33 safety command rows), not a production retention implementation. Snapshots are <=512 KiB inspection projections and omit replay/audit rows; they are not recovery backups. Full catalog/content restore, migration, retention, actual broker/job delivery, byte reads and independent verifier implementation remain host/integration work.

The host must maintain current compute acceptance and deliver local revoke/cancel/reauthorization. No atomic transaction spans compute, storage and catalog. A late external result cannot bypass the current local generation/expiry/revocation or attestation-expiry checks; an unobserved remote revocation is not magically visible here. Legitimately published historical snapshots remain eligible after transfer cancellation/expiry, with policy revocation still blocking promotion. No candidate withdrawal command exists in v1.

Environment discrepancy: in this process, the requested integration directory had no `.git`; Git resolved its ancestor repository as `/Users/mohameddiomande`, branch `main`, HEAD `f779c3e94`, rather than the supplied `codex/foundry-integration-20261016` at `cf27ac6`. No checkout/branch/index operations were used, and all explicit writes stayed inside the exact requested package. Parent should reconcile repository placement before committing its aggregate work.

Documentation impact: package README/API/receipt updated together. Root architecture/STATUS/TASKS updates, service documentation, policy migration/recovery guidance and aggregate release evidence remain parent-owned under the explicit package-only write boundary. Existing merge/deployment gates remain intact.
