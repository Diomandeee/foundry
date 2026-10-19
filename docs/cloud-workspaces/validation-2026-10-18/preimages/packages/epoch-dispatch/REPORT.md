# Disjoint integration report — 2026-10-16

Ownership respected: writes only under source/packages/epoch-dispatch/** and
source/workers/epoch-pipeline/**. Root package/lock, decoder, chain, jobs, compute,
shared dirty files and evidence outside these directories were not edited.
No commits, push, merge, deployment, accounts, live chain, spend, installation,
real credentials or protected history operations.

## Implementation

- Same SQL port with synchronous depth-aware transaction composes actual inbox
  acceptance, decoded header/ref and frozen event/job-policy metadata. Committed
  inbox conflicts quarantine via host-internal coordinator and preserve originals.
- Immutable schema/environment/source/policy binding; <=256 plan rows and 32KiB
  frozen JSON per row; generated fixed-template specification <=16KiB. SQL
  immutability/replacement guards. No Map authority or arbitrary templates/URLs.
- Actual EpochChain explicit owner bootstrap/reconcile/checkpoint, readIntents,
  lease CAS, submission response fence, retries and definitive cancel ack.
- Asynchronous host-fixed authenticated compute HTTP binding outside application
  SQL. Owner status discovers epoch; bounded targeted workload lookup supplies generation.
  Submits never read the full compute snapshot.
  Exact chain workload ID/generation reconstructs epoch-jobs plan, with template,
  policy, content and expected output hashes checked. Intent+epoch command keys;
  cancel additionally generation-bound. No quota grants.
- Unknown/missing cancellation stays pending, including cancellation before a
  delayed submit creates a workload. Late submit response records stale admission
  and compensation. Actual terminal outcomes preserve receipts and append app
  supersession. Compute resource quarantine is not physical-stop evidence.
- Capped persisted exponential transient backoff (1s..60s), permanent blocks
  skipped until explicit owner recovery, bounded HTTP streams/deadlines, durable
  credential-free result codes and scan cursor. Unexpected claim storage errors
  surface; typed lease/CAS contention is skipped.
- Default-disabled old-style SQLite DO worker, fixed namespace, host auth digest
  role mapping and host-secret references. No production fixture routes.

## Verification

Strict compiler: `source/node_modules/.bin/tsc --noEmit -p source/tsconfig.json`
passed after final source edits.

Focused verification: **27 tests passed across 2 files** (24 actual workerd
journeys + 3 real SQLite invariant tests). Strict compiler passed.

Command:
`source/node_modules/.bin/vitest run --root source packages/epoch-dispatch/src/sql.test.ts workers/epoch-pipeline/src/runtime.test.ts`

Local fixture uses Miniflare 5 top-level resourcePersistencePath, disabled dev
registry and SQLite DO bindings. FOUNDRY Fetcher calls actual compute entry.fetch
and actual compute DO stub; pipeline uses actual entry/DO HTTP and digest auth.
Credentials are invented fixtures. Fixture-only failures/pauses never enter prod.

Covered journeys: decoder→inbox→eligible checkpoint→actual queued job; no admission
before eligibility; duplicate/restart/lost response one job; mutable provider flags
remain duplicate without eligibility/quarantine; whole projection rollback; wrong
observer/network/contract/roles; same-height indexed fork orphan suppression;
recanonicalization new generation/ID; queued cancellation; source conflict;
paused-before-create submit/cancel NOT_FOUND/late response compensation; running
lease cancellation/fencing/resource quarantine; actual claim→pure epoch-jobs
handler(specification)→sealed upload→restart→independent compute byte verification;
completed receipt retained on app supersession; preinstalled quota; authority epoch
recovery and bump between status/submit; unexpected claim storage fault rollback;
durable bounded scan avoids starving later intents; genuine header conflict.

This is a disposable local pure-function demonstration, not a real worker pilot,
consensus validation or physical execution proof. Full suite and independent six
lens review are parent-owned; unchanged historical 505 baseline is not a new total.

RTD: structure present; strict compilation checked; actual HTTP+crossDO integration
and content/finality bounds checked; complete local user journey exercised;
deployment remains gated and was not attempted. Parent reviews migration/config,
root workspace lock and any final integration fixes.

## Parent review closures

Replaced whole-compute snapshot with status + bounded workload lookup; actual
>1MiB unrelated history regression. Permanent HTTP/domain denial blocks persist,
future dispatch skips claims; explicit owner-only recovery changes command recovery
generation without changing workload ID. Transient backoff persists across restart;
HTTP status retained; only whitelisted codes enter journal (no arbitrary upstream
strings). Retry SQL exceptions propagate. No lifetime cancel cutoff; actual lost
late-submit test seeds 100 prior cancellations, observes NOT_FOUND at 101, reopens,
advances test-only backoff clock and cancels actual late-created work at 102.

Binding replacement guard already existed; added direct SQL replacement regression,
partial-namespace fail-closed check and journal intent-reference/capacity/identity
SQL guards. Recover rejects unknown intent. All fixture SQL mutation/clock advance
remains test-only.

Retry lease release and durable block/backoff journal commit in the same
application transaction. Unexpected retry SQL fault propagates and leaves the
issued lease intact until normal expiry/reclaim; a fixture verifies this path.

## Carson final S2 persistence closure

Unexpected exceptions from frozen-plan SQL reads, markSubmissionResponse and
acknowledgeDelivery now propagate out of dispatch. Generic fetch/response-stream
failure conversion is confined to call(); dispatch catches only explicit delivery
outcomes, typed pipeline validation and the enumerated expected chain fences.
Local SQL faults are never rewritten into RETRY_UNKNOWN or HTTP 200 success.

Three additional actual workerd regressions inject one-shot plan-read,
submit-response persistence and cancellation-ack storage faults. Each asserts exact
redacted HTTP 503, stops the batch before the second intent is claimed, and writes
no false retry/success journal. External admission/cancellation may already have
committed; local issued lease remains pending normal expiry/reclaim. Persisted
restart and stable-key replay recover without duplicate workloads; terminal
cancelled work is acknowledged from the targeted authoritative read.

Focused final command (2026-10-16):
`source/node_modules/.bin/vitest run --root source packages/epoch-dispatch/src/sql.test.ts workers/epoch-pipeline/src/runtime.test.ts`
Result: **26 passed, 2 files passed**, 20.07 seconds.
`source/node_modules/.bin/tsc --noEmit -p source/tsconfig.json`: exit 0.

RTD closure: owned structure/API/report present; strict compile clean; actual
cross-DO HTTP integration and redacted error content verified; full local recovery
journeys pass. Parent owns full-suite/six-lens review and concurrent chain changes.
Deployment remains gated. This continuation edited only the two owned directories;
no commits or external actions were performed.

## Historical decisions integration — 2026-10-16

Added owned EpochPipeline.readDecisions wrapper and owner-only POST
/v1/pipeline/decisions. Exact {after,limit} passes to actual chain readDecisions
using the authenticated owner context; chain enforces safe integers after 0..2050
and limit 1..100. No chain-owned source, schemas or receipt format was edited.

Actual cross-workerd receipt/auth/restart regression covers historical GRANT
actor/checkpoint/path/policy/generation, later WITHDRAW with different selected
path and cancel reference, and source QUARANTINE attributed to the host internal
coordinator. Old receipts remain byte-structurally equal after later decisions and
persisted restart. Tests page by immutable sequence, reject forged identity
headers/non-owner roles/missing auth, reject unknown body fields/out-of-range and
non-integer bounds, and prove an empty page beyond the last receipt. Journey also
admits and cancels actual compute work before rereading historical receipts.

Final focused checks:
- Strict compilation command above: exit 0.
- Same focused two-file test command: **27 tests passed, 2 files passed**, 27.89s
  (24 actual workerd journeys plus 3 SQLite invariant tests).
- Exact output paths verified with ls; changes remain exclusively epoch-dispatch
  and epoch-pipeline. Parent owns full suite/review and concurrent chain audit.

RTD: structure/compilation/integration/content/historical user journey checked;
deployment remains gated. No commits or external actions.

## Singer stable schema3 alignment

Decision wrapper still delegates the actual chain page unchanged. API/README and
this report now specify after 0..2050 (limit 1..100). Current receipt test expects
BOOTSTRAP → GRANT → WITHDRAW → QUARANTINE, follows nextAfter, checks hasMore and
the 512KiB envelope bound, verifies bootstrap owner/root evidence, accepts after
2050 as an empty page, rejects 2051, and preserves all four receipts on restart.
No chain-owned files changed. Final focused rerun result follows below.

Final aligned checks: strict typecheck exit 0; focused two-file run **27 tests
passed, 2 files passed**, 22.42s (2026-10-16 22:05 local). Both Kant assertions
pass: BOOTSTRAP seq 1 and after 2050 valid empty page. Owned implementation,
wrapper tests and docs are complete; no further edits pending in this lane.
