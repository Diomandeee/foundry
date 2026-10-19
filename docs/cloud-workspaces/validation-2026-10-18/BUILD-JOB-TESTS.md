# BuildAuthority local SQLite validation — 2026-10-18

Result: **26 tests passed in one test file; focused strict TypeScript compilation passed.** No production bug was reproduced by these cases. No production edits were made.

## Scope and ownership

- Repository: `/Users/mohameddiomande/Developer/foundry-integration/source`
- Branch: `codex/foundry-integration-20261016`
- Base HEAD: `cf27ac662730bb98a509af8d1d1ebea4342eef7a`; this is a shared dirty checkout, so HEAD alone does not identify the tested source.
- Owned changes: `packages/build-jobs/src/authority.test.ts` (new) and this report only.
- Read the requested home AGENTS/SOUL/PROTOCOLS and `docs/cloud-workspaces/validation-2026-10-18/AUTHORIZATION.md`. Latest task restrictions governed this work: no cron/background agents, production edits, installation, provisioning, cloud access, spend, secrets access, service activation, deploy, publish, commit, merge, or cleanup.
- Existing dependencies only: Node v24.12.0, local Vitest v5.0.3, local TypeScript executable. No real Docker, helper, VM, or account was used.

## Fixture and assertions

The test file adapts the existing `packages/library-checkpoint/src/test-support.ts` and worker-enrollment test fixture pattern into its owned file. Every SQL statement executes against an actual `node:sqlite` `DatabaseSync(':memory:')` database, with foreign keys enabled and real `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`. There is no fake SQL implementation or replacement production module.

Production `DurableAuthority` and `WorkerEnrollment` initialize the inherited schemas in that same database before `BuildAuthority` initializes its additive schema. Workers are registered through the legacy API, enrolled with fixture digests, authenticated, and heartbeated through the real enrollment API. Build policy approval, census, submission, and lifecycle operations use the public BuildAuthority methods. Fresh databases are closed after each test. Reconstruction tests create a new authority object over the same live SQLite database; they do not claim disk persistence or process-restart coverage.

Coverage (26 cases, counting parameterized rows):

- Real inherited schema integration, enrollment audit/liveness rows, foreign-key checks, and additive initialization.
- Lost-claim replay after authority reconstruction: identical capability, one attempt, no duplicate event; no plaintext attempt capability in persisted commands/events/attempts or the feed.
- Submit replay and changed-body conflict; rejected project binding leaves lifecycle tables unchanged, and the rejected command key can subsequently be used for a valid request.
- Sequential renewal replay/conflict/history rejection, bounded renewal head, absolute timeout cap, exact expiry boundary, durable high-water clock maintenance despite a rejected command, and no resurrection after clock rollback/reconstruction.
- Effective expiry in read views before maintenance; expired claim replay cannot revive the attempt. Expiry retains occupancy and emits one stop-required event.
- Cancellation replay, clock rollback, terminal job/attempt state, rejected renew/stage/claim, retained occupancy until confirmed stop, and rejection of cancelled-job requeue.
- Stage rejection before confirmed stop; stop releases occupancy without fabricating success; repeated staging remains unverified until the real verifier reads and hashes actual fixture bytes. Accepted receipt lineage and verifier replay are checked.
- Uncertain stop: idempotent exact replay, rejection of a second distinct negative report, retained occupancy, no reassignment of the failed job to another worker, no requeue until owner reconciliation, executor reconciliation rejection, one incremented generation after reconciliation, and stale-attempt rejection. Independent jobs remain schedulable on other hosts.
- Three stopped failures exhaust the declared attempt budget.
- Verification has its own deadline; its exact expiry boundary remains revoked after time rollback and creates no receipt.
- Cancellation during asynchronous artifact reads prevents winner/receipt creation; artifact I/O is asserted to occur outside SQLite transactions.
- Nine parameterized admission/preview checks: disk reserve, available RAM, opt-in, active jobs, OS, architecture, incomplete inventory, unknown cache size, and cache limit. Ineligible workers receive no `next` job and no attempt is allocated.
- Exact disk/RAM/cache boundaries are accepted. Highest eligible owner preference wins, with lexical worker-ID tie-breaking; persisted placement evidence includes pre-allocation candidate facts.
- Owner-approved CPU and RAM limits cannot be overridden by favorable census observations (two cases).
- Edge workers are excluded; census freshness is accepted immediately before, and rejected exactly at, the 30-second boundary; a new census restores eligibility.
- Fresh census cannot compensate for stale or revoked enrollment.
- Actual legacy reservations block build claims. Actual build occupancy triggers the SQL backstop against legacy reservations, rolling back legacy leases/reservations while retaining the build attempt.

## Commands and observed results

Executed from the repository root; only the owned test suite was run:

```sh
node_modules/.bin/vitest run packages/build-jobs/src/authority.test.ts --maxWorkers 1 --no-cache --configLoader runner
```

Exit 0. **1 test file passed; 26 tests passed.** Vitest reported 284 ms total duration. Node emitted its expected experimental SQLite warning. Cache was disabled and the runner config loader avoided a bundled config artifact.

Focused compilation of the new test and its imported dependency graph:

```sh
node_modules/.bin/tsc --ignoreConfig --noEmit --target ESNext --module ESNext --moduleResolution Bundler --strict --skipLibCheck --types node,@cloudflare/workers-types packages/build-jobs/src/authority.test.ts
```

Exit 0, no diagnostics. The initial invocation omitted `--ignoreConfig` and exited with TS5112 because this TypeScript version requires an explicit configuration choice when specifying input files beside a tsconfig. The corrected invocation above passed. This is not a claim that the entire shared repository typechecks; the parent owns that check.

## RTD verification

| Level | Evidence / disposition |
| --- | --- |
| Structure | One owned test file under the requested package, plus this report; real local modules imported by relative source paths. |
| Compilation | Focused strict no-emit TypeScript check passed. |
| Integration | Actual SQLite, production legacy/enrollment/build schemas and public APIs; no fake SQL. |
| Content | 26 meaningful cases inspect state, audit counts, constraints, replay responses, admission reasons, lineage, and real byte integrity. |
| User Journey | Local approval → enroll/heartbeat/census → submit → select/claim → stop → stage → verify/accept, plus cancel/expiry/uncertainty/reconciliation paths. No HTTP/browser or physical runtime journey asserted. |
| Deployment | Gated and not attempted. Fixture success does not authorize or establish physical acceptance. |

## Production findings and limits

No production bug was reproduced in the tested scope, and production fixes were unnecessary. These passing tests are not an exhaustive correctness claim.

Stop proof hashes, artifact claims, and artifact-reader authorization are local fixtures. The reader supplies actual bytes and asserts transaction/scope conditions, but it does not exercise a real broker or authenticate a real provider grant. No physical process containment, stop measurement, Docker/VM/helper runtime, account isolation, cloud storage, remote Durable Object, deployment, or real build output was validated. The suite does not exercise Xcode VM activation/capability matching. Any physical acceptance or progressive activation remains with the parent and the explicit external-action gates.

## Source fingerprints after validation

SHA-256 fingerprints identify the dirty-tree source used by this report:

| File | SHA-256 |
| --- | --- |
| `packages/build-jobs/src/authority.test.ts` | `15b5fc55f833ca5b1627679fcd0c1705518e7aa3661b43fa9a9f8639208fdb19` |
| `packages/build-jobs/src/authority.ts` | `4653017cef8ecb1ff8231774c61a45f9562f905a1056a110891f6754a93d46f5` |
| `packages/build-jobs/src/schema.ts` | `88b40047a40eea81fdf55b169abfbb60823a240480fad08e3322ecd573bd06ae` |
| `packages/compute-authority/src/durable/authority.ts` | `f54cb892d367566c09716a65f31b106da007bfb88273dd16848d75c00fdcfbc2` |
| `packages/compute-authority/src/durable/schema.ts` | `f59e1fcb3dfe70965a8c7b598358e56abb55b85c503a4ffaed163218af8380a2` |
| `packages/worker-enrollment/src/index.ts` | `e06297775ee23849a7dc4a66a5e4b36185eca95c21af72f950caeccdbae5d8cd` |
| `packages/worker-enrollment/src/schema.ts` | `a839c84d12c1cc98df0026a7b5657c03864d20eafa1146e8968f527a75ec6f45` |
