# Storage broker core — local implementation receipt

Date: 2026-10-17. All authored files are under `/Users/mohameddiomande/Developer/foundry-integration/source/packages/storage-broker`. The directory was created with `mkdir -p` and verified with `ls -la`. No existing package contents were present at initial inspection. Other workers' changes were preserved; no commits, pushes, cloud/network/deploy/install/spend or credential operations were performed. No parent integration files or shared ledgers were changed.

## Delivered API and files

- `src/index.ts`: `createStorageBroker(ports)`, `validateGrant`, `grantRevocationBinding`, `HARD_LIMITS`.
- `src/types.ts`: complete immutable grants, current authorization/provider DI, separate trusted admin and authenticated-principal reader handles, revocation delivery commands/receipts and limits.
- `src/schema.ts`: durable bounded grants, consumed read reservations, sealed bytes, unknown outcomes, exact tombstones, stable-key receipt journal, immutable constructor binding and persistent monotonic clock; SQL identity/replacement/deletion/transition guards.
- `src/index.test.ts`: actual SQLite domain, file/restart and forced child-process crash tests.
- `package.json`, `tsconfig.json`, `vitest.config.ts`: existing repository executables, no additional dependencies or lockfile changes.
- `README.md`: complete API, trusted-host/provider boundaries, parent HTTP revocation contract, hard limits, failure/replay semantics and proof gates.

`createStorageBroker(ports)` returns `{admin:{issue,revokeGrant},reader:{read}}`. `reader.read(authenticatedPrincipalRef,{grantId,requestId})` returns copied verified bytes. `admin.issue(grant)` is synchronous and authority-checked on first issue. `observeCurrent(expectedGrant)` is a synchronous CURRENT host port; `readObject(ref,maxBytes,signal)` is asynchronous. Caller owns the injected `DatabaseSync` lifecycle.

`admin.revokeGrant({key,grantId,expectedBinding,evidenceId,reason})` durably returns `{status:'revoked'|'already-revoked'|'superseded',key,grantId,evidenceId}`. The final `expectedBinding` is `{projectId,authorizationGeneration,compute,policyHash}`; the parent target maps `resourceId -> grantId`, `generation -> authorizationGeneration`, and `computeBinding -> compute`. Exact command retries return the original durable receipt; changed reuse of a key throws. Parent authenticates/routes the trusted admin call and owns HTTP delivery/ack integration. All three returned statuses are durable terminal delivery outcomes; errors are not acknowledgments. The fuller original expected-grant sketch was superseded before final tests and is not the implemented API.

Actual compute workload generation/incarnation permit zero. Epoch and the separate library authorization generation remain positive. Object generations retain the positive decimal, at-most-32-digit immutable format. Content paths and native-byte/inert-JSON validation reuse sibling `library-jobs` contracts/helpers without changing that package.

## Executed checks

Working directory for package checks: this package directory. Node v24.12.0; repository Vitest v5.0.3. Node emitted its expected experimental `node:sqlite` warning.

| RTD gate | Command/evidence | Result |
|---|---|---|
| Structure | `ls -la` package and `src`; bounded package-only file inventory | PASS |
| Compilation, package | `../../node_modules/.bin/tsc --noEmit -p tsconfig.json` | PASS |
| Integration/content/local journey | `../../node_modules/.bin/vitest run --config vitest.config.ts --configLoader runner --cache=false` | **73/73 tests, 1 file PASS**, final run 00:23:28 local, 2.23 seconds |
| Compilation, aggregate source | `node_modules/.bin/tsc --noEmit -p tsconfig.json`, executed from parent `source` | BLOCKED by parent-owned `workers/library/src/archive-body.ts(8,66)`: TS2741 missing `ignoreBOM` in `TextDecoderConstructorOptions`; no broker diagnostics |
| Deployment | Not run | NOT AUTHORIZED |

Earlier broker runs passed 69 tests; those are intermediate results, not additive totals. Initial parent feedback identified a test `URL` Node/Worker ambient-type conflict; the broker fixture now imports `URL as NodeURL` from `node:url`. The final aggregate typecheck no longer reports that conflict. The external `archive-body.ts` failure was reported and left untouched.

Test coverage includes authenticated principal mismatch and separated handles; full project/policy/library and every compute fence before/after reads; compute zero-generation/incarnation; unavailable/stale/expired/revoked authority; actual bytes/hash/size/reference/native-buffer validation; immutable project path abuse and inert-input traps; 20 concurrent same-key callers with one provider read/debit; byte reservation before async; failures without refunds; lost replies and restarted sealed replay; durable revocation receipts and restart; no cached result after revocation; in-flight revocation of 20 callers; independent fencing of every waiter; actual SIGKILL after durable reservation and fail-closed unknown replay; cross-instance duplicate reservation and unresolved-resource capacity; provider timeout/abort/late completion; elapsed-clock deadlines; grant/read/admission/history bounds; eight 1 MiB results filling the 8 MiB cap before a ninth provider allocation is rejected; zero-byte history bounds; normal-full and safety-reserved revocation capacity; immutable SQL guards; constructor binding/schema failure preserving file bytes.

## Risks and remaining proof gates

This is a local core with trusted fixture authority/provider inputs. Parent service/HTTP authentication and role routing, actual compute/catalog current-observation integration, durable revocation delivery, catalog recovery and the GCS provider adapter are separate owned work. No actual cross-authority or live cloud journey is claimed here, and no credentials or URLs are returned to a worker.

Grant/read/tombstone/command histories are lifetime bounded, with no deletion or rollover. Unknown reads remain charged and retain an unresolved resource slot forever in this prototype; eight ambiguous outcomes may stop further reads. This deliberately trades availability for bounded duplicate-execution risk. A reviewed reconciliation/rollover mechanism is required before live use. SQLite payload capacity is 8 MiB plus bounded metadata/page/journal overhead, not an 8 MiB whole-file guarantee. Filesystem-full errors remain possible and must never be acknowledged as successful revocation.

Synchronous trusted callbacks cannot be preempted by an event-loop timer. Provider DI must enforce bounded allocation and transport before returning bytes. Remote/current-observation adapters need a reviewed fresh-authority mechanism; caching old acceptance is not an implementation of the port. Host process/file isolation and permissions are required; SQL triggers are not protection against a privileged database/schema rewrite.

Revocation cannot retract bytes already delivered or stop all provider bytes already in flight. Independent compute, catalog, broker and storage authorities have no shared atomic transaction. A revocation can commit immediately after the final current observation. This core checks before and after provider access, before sealing, and on every reply; it does not claim cross-authority atomicity or physical transfer cancellation proof.
