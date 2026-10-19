# Worker enrollment domain report

Scope: `/Users/mohameddiomande/Developer/foundry-integration/source/packages/worker-enrollment/**` only. No compute, transport, runtime, root configuration or lockfile edits. No external dependencies/install, deployment, spend, real secrets, commit, push, merge or remote mutation.

## Delivered contract

`WorkerEnrollment` exports stable synchronous `enroll`, `revoke`, `authenticateDigest`, `heartbeat`, `requireFresh`, and owner `status` methods. Exact types are in `src/contracts.ts`; parent composition and method semantics are in `README.md`.

- Namespace-bound schema **2**, immutable worker/principal/class/geometry across versions; exact schemas and bounded general/device geometry, edge zero CPU/RAM/devices.
- Only supplied SHA-256 digests are accepted/persisted. No credentials generated or returned. Unique digests remain reserved across expiry/revocation/supersession. Lookup only returns the active current executor worker/principal/revision/incarnation binding.
- Owner version CAS, strictly increasing incarnation, irreversible per-credential revocation. Explicit new version requires a new digest. Old enrollment/revoke/heartbeat delivery cannot reactivate or fence a successor.
- `MutationResult` includes status/revision/incarnation plus applied/replayed/isCurrent. Replay must never re-register/reset core; old revoke replay recomputes currentness and never applies quarantine again. A new key for an already revoked credential rejects `already-revoked`.
- Immutable enrollment/revocation journal, replacement/delete guards, bounded count/payload, reserved revocation capacity. Parent owns the outer transaction and all compute registration/quarantine callbacks; tests prove composed rollback.
- Owner paginated status exposes lastSeen, expiry/revocation and explicit freshness; no connection claim. Freshness default 60000 ms, boundary stale, persisted policy/high-water clock. Only committed clock observations survive rollback/restart.

## Heartbeat capacity blocker resolved

The initial candidate permanently journaled heartbeat requests. That design was rejected before completion because executor traffic could exhaust shared lifecycle admission. Schema 2 removes heartbeat events entirely from the permanent journal; no permanent enrollment/revocation evidence is pruned.

Each credential has at most one bounded `enrollment_liveness` row storing latest sequence/key/hash/result. It updates atomically with lastSeen and credential sequence. Exact latest replay survives file close/reopen without refreshing freshness. Older sequences reject, changed latest-key payload conflicts, and no mutable liveness record can edit owner-approved geometry. Revoked/expired/superseded bindings reject before replay lookup.

Per-worker/version admission is independent: optional persisted `heartbeatMinIntervalMs` defaults to min(1000, freshness window), range 1..freshness window. New sequences arriving sooner reject `heartbeat-rate-limited`; latest exact replay is harmless. Parent should honor retry timing and use monotonically increasing sequences/new keys. Latest-heartbeat replay does not retain arbitrary historic request keys.

Regression: after **1000** admitted heartbeats, the busy worker still owns exactly one liveness row and one permanent enrollment event. Other workers subsequently enroll and heartbeat. Heartbeats continue after the lifecycle non-revocation budget fills. Every retained credential can still be revoked within the reserved journal capacity. Schema 1 candidates reject with `namespace-or-policy-mismatch`; no silent migration, pruning or reactivation occurs.

## Validation

Actual Node v24.12.0 SQLite, existing local dependencies, no service/account calls:

```
./node_modules/.bin/vitest run packages/worker-enrollment/src/enrollment.test.ts --no-cache
18 tests passed, 1 test file passed.

./node_modules/.bin/tsc --project packages/worker-enrollment/tsconfig.json --pretty false
Exit 0, no diagnostics.
```

Coverage: file database close/reopen and duplicate replay; authentication and freshness; expiry, revocation and supersession; digest non-rebinding; geometry/class/principal immutability; exact schemas, bounds and zero edge resources; cross-principal/current-incarnation fences; heartbeat sequence CAS and lost-response replay; 20 serialized enrollment contenders and 20 serialized heartbeat contenders across separate instances; lifecycle audit and latest-liveness fault rollback; outer parent registration/quarantine rejection rollback; independent busy-worker admission; bounded logical liveness storage; revocation safety reserve; immutable audit/identity/digest and replacement/delete guards with recursive triggers disabled; stale/expired SQL reassertion rejection; explicit schema 1 rejection.

The earlier repository-wide typecheck encountered a concurrent runtime-owned Node URL type mismatch. This lane did not modify that file. The final package-specific typecheck is clean. Repository-wide and actual workerd checks are parent-owned and not claimed by this report.

## RTD verification

1. **Structure — PASS:** package entry, exact contracts, schema, SQLite tests, package-local typecheck, README and this report, entirely within the owned path.
2. **Compilation — PASS:** package TypeScript check exits 0.
3. **Integration — PASS locally:** structurally compatible SQL/transaction port; nested synchronous outer-transaction rollback demonstrated. Actual workerd/parent-core route integration remains parent-owned, not independently proven here.
4. **Content — PASS:** fixed executor role; no token generation/raw-token fixture/output; namespace/version/CAS/digest/expiry/revocation safeguards, immutable lifecycle journal and independent bounded heartbeat state reviewed and tested.
5. **User journey — PASS locally:** owner enroll → digest authentication → heartbeat → fresh status → revoke → restart → rejected replay → explicit successor version; historical revoke cannot apply to successor. Not a real-device or process-isolation proof.
6. **Deployment — NOT ATTEMPTED / GATED:** no install, deploy, remote pilot, publication, spend or protected-secret operation authorized or performed.

## Changed paths

- `packages/worker-enrollment/package.json`
- `packages/worker-enrollment/tsconfig.json`
- `packages/worker-enrollment/README.md`
- `packages/worker-enrollment/REPORT.md`
- `packages/worker-enrollment/src/contracts.ts`
- `packages/worker-enrollment/src/schema.ts`
- `packages/worker-enrollment/src/index.ts`
- `packages/worker-enrollment/src/enrollment.test.ts`

## Limits and remaining parent gates

Parent must reauthenticate after awaits; deny static executor bypass in managed mode; enforce worker/principal/current revision and actual core incarnation, freshness on claim/renew/upload, epoch fencing, and atomic registration/quarantine with rejection-to-throw conversion. Core alone owns lease/reservation quarantine and owner stop-proof reconciliation. Enrollment does not clear quarantine or release resources.

Tests establish serialized synchronous CAS, not multi-process contention or physical process containment. Heartbeat admission bounds each worker's accepted state writes, not total malicious request traffic/SQL work; parent ingress/rate controls remain necessary. Logical row/payload bounds are not a physical SQLite/WAL/disk quota. Approved CPU/RAM budgets must already exclude host operating reserve. No receipt implies installed, connected, sandboxed or stopped devices. Schema/policy migration, journal retention and database destruction/restore require separate review. Parent actual workerd cross-principal/revocation-route tests remain required before rollout.
