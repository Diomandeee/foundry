# Epoch jobs local handoff

Owned changes are confined to `packages/epoch-jobs/**`. Existing dirty files in
other packages were preserved. No commit, deployment, paid execution, secrets,
network calls, history inspection, host scripts or dispatcher changes were made.

Public API is in `API.md`; exports are in `src/index.ts`:
`prepareEventSummary`, `planEventJob`, `executeEventSummary`, template/profile
constants and typed scope/policy/compute-body/result interfaces. The package
manifest exports the source entry point without changing workspace lockfiles.

Parent integration: prepare immutable output before `chain.observeEvent`, bind
template manifest/output hashes, and later pass exact chain intent workload ID
and positive eligibility generation into the planner. Submit `plan.submitBody`
unchanged using parent-owned epoch/generation command fences. No ID derivation
exists in this package. Output is generation/ID independent. Policy is trusted
host configuration, not payload configuration. Hashes are mutation checks,
not authorization. The handler recomputes output from validated frozen facts.

Provider update regression: decoder output excludes all provider canonical flags;
the job validator requires that immutable shape. Flag flips preserve exact event
and plan. Genuine immutable content changes produce different event/output hashes.
Inbox/chain quarantine decisions remain outside this package.

RTD evidence:

1. Structure: package manifest, typed public entry point, bounded canonical helper,
   API, tests and this report; exact files verified by directory listing.
2. Compilation: repository strict `tsc --noEmit` passed after flag-free update.
3. Integration: 65 focused tests passed, including current decoder input and
   actual durable compute submit/claim/stage/verify against in-memory Node SQLite.
   Real output succeeds; corrupt bytes and wrong expected policy hash receive no
   successful receipt.
4. Content: fixed template only, hash/count output, strict profiles and allowlist,
   no raw repr/hex retained, 16KiB spec / 4KiB output bounds, invalid numbers,
   unknown fields, accessors and schema/commitment mutations fail closed.
5. User journey: pre-eligibility preparation -> exact trusted workload ID plan ->
   fresh handler bytes -> independent compute verification; deterministic replay
   and new generation preserve expected byte hash. Caller mutation/cache mutation
   cannot alter already planned handler results.
6. Deployment: gated; no physical executor, sandbox, runtime pilot or deployment
   claim. Parent owns real dispatch and all external effects.

Final shared-checkout regression run: 46 files / 681 tests passed after the
flag-free decoder update. This includes concurrent cross-lane tests, not only
this package's 65 tests; the original 505 baseline was not treated as a current
count. No production-runtime claim follows from these local results.

Cross-lane issue observed during review: chain generated `epoch:` + 64 hex
(70 characters, including a colon), while compute accepts <=64 with grammar
`[A-Za-z0-9._-]` (no colon). Planner rejects invalid IDs rather than rewriting.
Parent/chain lane owns fixing that generation scheme; verify before integration.
