# Epoch inbox review receipt

Scope: only `source/packages/epoch-inbox/**`. No wrappers/runtime, network, credentials, deployment, spending, commits, contract recovery, phase reconciliation or protected history operations. Other contributors' files were preserved. Public contract: API.md; entry point: src/inbox.ts (`EpochInbox`).

## Verification (RTD six levels)

1. Structure: package manifest, index export, typed synchronous domain, namespaced schema, focused tests and API/review docs present. Host port structurally matches compute durable `sql.exec` / `transactionSync`. No production BEGIN/SAVEPOINT.
2. Compilation: strict package-only TypeScript check passed, including tests. Used installed local compiler with `--ignoreConfig --noEmit --strict --skipLibCheck --target esnext --module esnext --moduleResolution bundler --types node` against src/inbox.ts, src/schema.ts, src/inbox.test.ts. No parent file changes required.
3. Integration: 29 focused Vitest tests passed against real Node DatabaseSync SQLite, including file-backed reopen and two instances sharing a port. Parent reported separate real-workerd verification; this receipt does not substitute for the parent's final rerun.
4. Content: canonical bounded JSON; UTF-8 limits; unknown/accessor/hidden/symbol fields rejected; full height/parent/payload comparison; deterministic tuple identity; environment/authority/schema/role/source fences; immutable SQL update/delete and REPLACE guards (recursive_triggers OFF); namespace isolation; global evidence sequence across stores; typed expected errors and unwrapped storage faults.
5. User journey: enroll → accept → stale-cursor duplicate → conflict → quarantine → bounded enriched projection → delivered-prefix ack → restart. Fault after outbox insertion rolls observation/cursor/audit/outbox/key response back together, including reserved quarantine. Capacity tests saturate source/event/variant/command/outbox budgets; first quarantine has independent reserved evidence/command/notification slots and read/ack can drain at command capacity after restart. Historical payload, enrollment binding, first conflict evidence and audit actor/time remain projectable beyond snapshot pages.
6. Deployment: GATED. No deployment or migration attempted. Schema v2 rejects v1 and unknown versions before DDL. Parent owns runtime authentication, serialized transaction adapter, HTTP mapping, full-suite validation and any future migration/release authority.

## Review synthesis

Initial findings fixed: SQL REPLACE bypass; oversized cached outbox response; normal-command saturation blocking drain; normal-variant/command/audit/outbox capacity blocking first quarantine; projector lacking historical content; independent evidence rowids hiding newer quarantines; v1 trigger retention during candidate schema changes. Regression tests cover each applicable domain behavior.

Contrarian check: no claim of concurrent/race proof follows from the sequential two-instance cursor test. Domain correctness requires the host's serialized atomic synchronous transaction contract. Privileged raw database writes and dropping triggers are outside the trusted-domain threat model; focused fixtures use direct inserts to reach capacity efficiently, never production paths. Reserved first quarantine still rolls back on a genuine storage fault rather than falsely claiming durable quarantine. Normal writes may fail at a shared budget before an individual entity cap.

Stable semantics: one quarantine notification per source, with additional distinct variants bounded separately. Cursor protocol read/ack intentionally does not persist key responses; current ack retry succeeds, older ack rejects. Snapshot exposes bounded latest pages with totals/hasMore, not historical pagination. Projection uses the prefix outbox, whose item-array UTF-8 budget is 128KiB. No finality/canonicality or jobs are inferred from observations.

Final local result: 29/29 focused tests passed; strict package typecheck passed. No outstanding package test failures. Parent full-suite/release checks remain external gates.
