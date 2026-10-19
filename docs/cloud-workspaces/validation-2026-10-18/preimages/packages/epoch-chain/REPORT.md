# Epoch-chain concrete audit closure — schema v3 candidate

Scope: only `/Users/mohameddiomande/Developer/foundry-integration/source/packages/epoch-chain/**`, on existing uncommitted `codex/foundry-integration-20261016`. No edits to dispatch/pipeline, root docs or compute. No commit, push, merge, deploy, spend, secret access, network calls or live runtime operations. Existing dependencies only.

## Implemented

Immutable atomic decision evidence closes the lost authorization-history finding: authenticated actor, canonical authority/environment/source/network/policy binding, before/after revision, root, reason, exact reconciliation checkpoint and full normalized Bitcoin path. Immutable selected Stacks header IDs reconstruct ancestry from retained header bodies. Each affected generation has its own immutable transition containing complete event/template/generation reference and cancellation intent IDs. Later checkpoint changes cannot overwrite prior eligibility evidence. First root selection has its own authenticated BOOTSTRAP decision. First quarantine/conflict preserves both normalized original and conflicting objects.

Simple capacity proof: at most 1024 granted generations; each can withdraw once. Separate per-kind SQL caps reserve 1024 withdrawal records, one first quarantine, one bootstrap independently of grants: 2050 rows total. Rows have a 196608-byte content cap; worst-case aggregate content <=403046400 bytes, excluding database/index overhead. Immutable SQL UPDATE/DELETE/REPLACE guards and unique kind/key prevent rewriting or duplicate decisions. New grants stop at generation/evidence admission capacity while stale work can withdraw. Existing three-intents-per-generation reserve supports withdrawal and independent late-response cancellation. Delivery does not consume decision capacity.

No-op reconciliation, repeated same-root bootstrap and repeated quarantine do not append decision records. Reconciliation metadata can advance without a decision if eligibility/control state does not change. This deliberately excludes full request/observation/delivery history. Only the first quarantining conflict is retained; subsequent new structural variants are rejected SOURCE_QUARANTINED rather than accepted without evidence. Exact original duplicates/provider advisory flips retain prior duplicate behavior.

## Parent / Hypatia integration contract

`readDecisions(context, {after:number, limit:number})` returns `{revision:number, items:Decision[], hasMore:boolean, nextAfter:number}`. Owner only; authenticated host supplies context. Exclusive ordinal after 0..2050; limit 1..100. Complete serialized JSON response envelope <=524288 UTF8 bytes. Resume after nextAfter (last returned ordinal, or input cursor on empty page). A legal row always fits alone. `Decision` is exported from package via existing index export; full fields documented in API.md. This package performs no HTTP side effects; parent/Hypatia own authenticated HTTP exposure.

Schema v3 rejects v1/v2 before repairing DDL, with BINDING_MISMATCH. No fabricated history or migration. Parent fixtures expecting v2 require explicit updates. Existing method signatures, workload ID/binding derivation and delivery APIs remain unchanged. Snapshot does not embed journal bodies; use readDecisions recovery pages.

## Validation / RTD

Executed from the owned package directory:

1. Structure: src/chain.ts, src/chain.test.ts, API.md and this REPORT.md only changed by this task; existing src/index.ts already exports the new type/method. Shared package is untracked in base checkout; no unrelated edits reverted.
2. Strict compile: `../../node_modules/.bin/tsc --ignoreConfig --noEmit --strict --skipLibCheck --target esnext --module esnext --moduleResolution bundler --types node src/chain.ts src/chain.test.ts` — PASS, exit 0. Initial attempt without --ignoreConfig was refused by installed TypeScript TS5112; corrected command above checks actual source/tests under strict settings.
3. Real SQLite integration: `../../node_modules/.bin/vitest run src/chain.test.ts --root . --cache=false` — PASS, 53/53 tests, 1/1 file (final run 3.66s). Includes all existing core 44 tests plus nine new audit regressions. Commands executed through installed rtk proxy; no dependencies installed.
4. Evidence content: asserts actor/revisions/policy/root, exact checkpoint and Bitcoin path, immutable Stacks ancestry refs, grant/withdraw histories, original/conflicting event and header objects, bootstrap identity; SQL UPDATE/DELETE/REPLACE blocked.
5. User journey: actual disk close/reopen history and owner-only ordinal recovery; complete serialized page byte bound with 512 Bitcoin headers and multiple pages; 1024 grants +1024 withdrawals +first quarantine +bootstrap reaches exactly 2050 rows, followed by repeated no-ops, reopen, late success and CANCEL delivery without more evidence; outbox and raw SQLite decision faults roll back evidence, eligibility, checkpoint and cancellation together. V2 rejected before repair.
6. Deployment: explicitly user-gated; not attempted. Parent independently reviews changes and runs full cross-package suite; that suite was not claimed here.

## Limits

Reserve is logical, not a physical storage guarantee. Raw SQLite failures propagate and atomically roll back; host must fail closed on adapter failures. No automatic database migration/pruning. Evidence is local and host-attested, not externally signed or protected against privileged administrators dropping triggers. Authenticated host still owns actor provenance and source/template association. No PoW/SPV/Stacks/Bitcoin consensus validation, mathematical finality, exactly-once execution, or physical stop proof. Node reports its standard experimental SQLite warning in tests.
