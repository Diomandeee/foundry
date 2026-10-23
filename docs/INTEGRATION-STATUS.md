# Foundry — integration status and contract corrections

Reconnaissance pass over the core workflow and the four vendored substrate
systems, with the state classified per capability. First written 2026-10-15
against `main` @ `dc1707a`; the staleness corrections in §6 and §8 and the
usability proof were added later the same day, so where a line disagrees with the
code, believe the code and re-run the commands below.

Every claim here is anchored to a file and line, a test name, or a live read. An
item marked done was done in a commit and is covered by a test; an item marked
open names the exact change it needs.

How this was established (all re-runnable):

```bash
npm run typecheck                        # 0 errors
npx vitest run                           # 23 files, 227 tests, all pass
npm run proof:usability                  # 26 checks, all PASS — the loop, in-process
npm run demo:graphvc                     # the same loop over a real git push + hook
cargo test --manifest-path substrate/cc-kernel/Cargo.toml        # 52 + 11 + 2 parity
cargo test --manifest-path substrate/live-knowledge-graphs/Cargo.toml   # 13 + 2 doctests
cargo test --manifest-path substrate/trajectory-memory-ledger/Cargo.toml # 16
cat fixtures/kernel-parity.json          # the shared Rust<->TS case set (§6)
curl -s <staging board>/decisions?limit=200                      # live ledger
```

`npm run proof:usability` is the single command a reviewer should run first: it
drives intake → an admitted merge → a path refusal → an enforced-verification
block → the same failure as advisory → every API surface → kernel rule 10, on
real git repositories in a temp dir, and prints `PASS`/`FAIL` with the observed
value for each of 26 assertions. `npm run demo:graphvc` runs the same gate over
an actual `git push` through a post-receive hook. Neither needs an account,
network access, or `wrangler`, and both exit non-zero on any failure.

Nothing in this document is inferred from a package existing. Where a status is
not backed by a test or a live read, it says so.

---

## 0. Deployed vs. committed — read this before believing an endpoint is live

There are **no Cloudflare credentials in the environment this work was done in**
(`npx wrangler whoami` reports not authenticated), so nothing here was deployed.
Everything below is committed to `main` and green in CI; the *running* staging
worker is an older revision and does not have the newest surfaces.

Read live, 2026-10-15:

```bash
B=https://foundry-api-staging.motionmix-participation.workers.dev
curl -s -o /dev/null -w '%{http_code}\n' $B                     # 200
curl -s -o /dev/null -w '%{http_code}\n' $B/decisions?limit=1   # 200
curl -s -o /dev/null -w '%{http_code}\n' $B/history.json?limit=1 # 200
curl -s -o /dev/null -w '%{http_code}\n' $B/git-history.json    # 404  <- in the repo, not deployed
curl -s -o /dev/null -w '%{http_code}\n' $B/evidence/task-1     # 404  <- in the repo, not deployed
```

| Surface | In the repo | Live on staging |
|---|---|---|
| `/` board, `/decisions`, `/why/:sha` | yes | **yes** (200, 28 rows) |
| `/history.json` | paged, DB cursor, `proposal_sha` + `merge_sha` | **old shape** — items carry `sha` only, no `proposal_sha`/`merge_sha` |
| `/git-history.json` (spatial viewer feed) | yes (§7) | **404 — not deployed** |
| `/evidence/:taskId` | yes (§8 item 6) | **404 — not deployed** |

The live ledger, read this turn: 28 rows — 17 `reject/invalid_args`, 7 `merge`,
4 `reject/snapshot_too_stale`. Seven of the 17 are the `pipeline error:` rows
described in §4; the correction SQL there has not been run for the same
credential reason.

To close the gap:

```bash
npm run deploy:api          # after `npx wrangler login`
npm run deploy:gate
npm run deploy:orchestrator
```

Do not report a surface as working because the code exists; check the status
code on the deployed origin, which is what the table above does.

---

## 1. Component status

Status vocabulary: Reference · Ported · Locally verified · Integrated ·
Production verified · Advisory · Planned/incomplete.

| Component | Status | Evidence |
|---|---|---|
| `substrate/cc-kernel` (Rust) | Reference + CI-verified | `cargo test` in `.github/workflows/ci.yml`; **65 tests local and green** (52 unit + 11 integration + 2 parity) |
| `packages/gate-ts` (12-rule kernel port) | Ported + locally verified + **Integrated** | `packages/gate-ts/src/gate.ts`; called from the live decision path at `workers/gate/src/decide.ts:230` |
| `packages/gate-ts` path allowlist | Ported + **canonicalising, parity-checked**; a policy boundary, not a filesystem control | `allowsPath` in `packages/gate-ts/src/types.ts`; mirrored in `substrate/cc-kernel/src/types/scope.rs`; 32-case shared fixture in `fixtures/kernel-parity.json` — see §6 |
| `packages/gate-ts` scope token | Ported, **unsigned** | `signature?: number[]` (`types.ts:95`) is declared and never set or verified — see §6 |
| `packages/verify` | Ported + **Integrated, inert until configured** | Runs between admission and the merge in `workers/gate/src/pipeline.ts`; no `VERIFY_URL` means the stub, which cannot block — see §9 |
| `workers/orchestrator` | Integrated | `workers/orchestrator/src/tasks.ts` + `tasks.test.ts`; `wrangler.toml` binds D1 + Artifacts |
| `workers/gate` | Integrated, **production verified** | `src/decide.ts` (verdict), `src/merge.ts` (merge), `src/pipeline.ts` (decide→merge→record); live staging ledger holds its rows |
| `workers/api` | Integrated, production verified | `src/index.ts` board + `/decisions` + `/why/:sha` + `/history.json`; `api.test.ts` |
| `packages/artifacts-port` | Integrated | `cloudflarePort` bound in the gate worker; `GitAdapter`/`GitMerger` used by local demo |
| `packages/stores` (D1) | Integrated, production verified | `tickets.ts`, `decisions.ts`; schema `workers/gate/schema.sql` |
| `packages/lkg-client` | **Integrated but advisory** | `workers/gate/src/index.ts` builds `KgOverlapOracle` when `LKG_URL` is set; verdict triples are written best-effort in a `try/catch` that only warns |
| `substrate/live-knowledge-graphs` | Reference + CI-verified | `cargo test` in CI; **13 tests + 2 doctests local and green**; authority for `triples.ts` shapes |
| `packages/evidence` (trajectory companion) | **Locally verified, unwired** | `packages/evidence/src/index.ts` + `index.test.ts`; no import outside the package |
| `substrate/trajectory-memory-ledger` | Reference + **CI-verified as of 2026-10-15** | schema `examples/trajectory-card.schema-v2.json`; **16 tests local and green**, and now run by CI (they were not, until this pass). No runtime import — Foundry writes no trajectory events (§8 item 6). |
| `substrate/spatial-git` | Reference + **Integrated** (feed adapter) | viewer + CLI vendored; `workers/api` now serves `/git-history.json` in the viewer's shape — see §7 |
| `packages/plan-check` (PACT) | Integrated but **advisory by default** | `decide.ts` step 1b; rejects only when `enforce` is set; outages fail open (`checked=false, ok=true`) |
| `workers/participation-coordinator` | Retired from this repo 2026-10-23 | Own Foundry base `participation-coordinator` (deploys only from a gated MERGE); mirror `Diomandeee/participation-coordinator`; same Cloudflare account, own D1 |

`substrate/README.md` states nothing under `substrate/` is imported by Foundry's
own build. That holds: the Rust trees are the authority for ports, not runtime
dependencies.

## 2. What actually runs (the decision path, in code order)

`workers/gate/src/decide.ts` — first failure wins, and the order is what the code
does, not what the docs say:

| # | Check | Refusal |
|---|---|---|
| 0 | Fork belongs to a known task ticket | `invalid_args` "no task ticket" |
| — | Fork point present in fork and base history | `invalid_args` "fork point … (base moved on; rebase the fork)" |
| — | Proposed commit exists on the fork | `proposal_not_found` |
| 1 | **Kernel admissibility** (`checkAdmissibility`, `decide.ts:230`): scope validity, tool allowlist, layer + transition, time gate, budget, mutation rights, snapshot freshness, proposal reference | the kernel's `RejectReason` values (`scope_expired`, `tool_not_allowed`, `layer_violation`, `snapshot_too_stale`, …) |
| 1b | PACT chain check (only if the ticket declares chains) | `invalid_args` "pact: unusable chains" — **only when `enforce` is set** |
| 2 | Diff materialised; empty diff refused | `invalid_args` "empty diff" |
| 2 | **Path allowlist on the real diff** (`allowsPath`) | `path_not_allowed` |
| 2 | Real content conflicts on paths both sides changed | `conflict` + file list |
| 2b | Cross-task overlap via the LKG oracle (only if `LKG_URL` is configured) | `conflict` + contenders |
| 3 | Clean → collect fork-side contents and deletions | `merge` |
| 4 | **Required verification** (`pipeline.ts`, after admission, before the merge) — only when a `VERIFY_URL` is configured (§9) | `verification_failed`, **only when `VERIFY_ENFORCE` is set** |

**Contract corrections against the docs**

- `README.md:38-44` lists the checks as ticket → non-empty → fresh → no-file-both-sides → allowed-paths. That ordering is *closer* to the code than the others, but it omits the kernel step entirely and places scope after conflicts, which the code does in the same step.
- `IMPLEMENTATION.md:149-165` puts scope (4) before conflicts (5). **The code does conflicts-then-scope inside step 2, with the path check after the empty-diff guard.** `IMPLEMENTATION.md` is wrong on order.
- Neither document mentions kernel admissibility, which the code runs *before* any diff check. Anyone reasoning about refusal reasons from the docs alone will mis-attribute the most common ones.

## 3. Merge strategy — the docs disagree because the implementations do

- `ARCHITECTURE.md:47` says "an ordinary merge commit".
- `TECHNICAL-OVERVIEW.md:9` says "a single squash commit".

Both are true of different code paths:

| Path | Implementation | Result |
|---|---|---|
| **Production** (gate worker) | `IsomorphicMerger` → `commitForkFiles` (`workers/gate/src/merge.ts`) | **Squash**: fork files written as one commit on base, one parent, message `Merge <fork>@<sha8>` with a `Fork-Head: <40-hex>` trailer |
| **Local demo** (`tools/graphvc-demo.ts`) | `GitMerger` (`packages/artifacts-port/src/git.ts:215`) | **True merge commit**, two parents — asserted by `workers/gate/src/pipeline.test.ts` ("True merge: two parents") |

Canonical policy: **production squashes**, and the `Fork-Head:` trailer is the
proposal → landed-commit link. The two-parent local merge is a deliberate
difference of *purpose*, not a second policy, and it is now recorded as such
(2026-10-15):

- Production squashes because a shared base should not carry every agent's
  intermediate history.
- The local runner (`tools/gate-runner.ts`) merges because preserving the fork's
  commits is how you inspect what an agent actually did. It is a debugging
  surface, and it is the code path the recorded demo exercises.
- Both write the same `Fork-Head: <proposal sha>` trailer, which is what makes
  the two interchangeable at the record level. **Depend on the trailer, never on
  the parent count.** The trailer is now asserted for the local merger in
  `workers/gate/src/pipeline.test.ts` and for the production merger in
  `workers/gate/src/merge-iso.test.ts`.

Fixed alongside: `GitAdapter.history()` read the commit *subject* (`%s`), so the
trailer — the canonical link — was not readable through the port at all. It now
reads the full message (`%B`), matching what the Workers binding already
returned. `ARCHITECTURE.md` was corrected to describe the squash in commit
`0d860e3`; `TECHNICAL-OVERVIEW.md` was already right.

## 4. Failure semantics — an outage was recorded as a refusal

`workers/gate/src/pipeline.ts` ended in a catch-all that recorded **any**
uncaught error as `verdict: "reject"`, `reason: invalid_args`,
`message: "pipeline error: …"`. A repo or transport failure therefore landed in
the ledger indistinguishable from a policy refusal, and counted as the agent's
mistake.

That is not hypothetical. Live staging, 2026-10-15, `/decisions?limit=200`:

```
17  reject / invalid_args      (of which 7 are "pipeline error:" rows)
 7  merge
 4  reject / snapshot_too_stale
```

The 7 rows (decision ids 3–9) read:

```
verdict: reject, reason: invalid_args,
message: "pipeline error: merge:push: Could not find main."
message: "pipeline error: Could not find main."
```

So of the 21 staging refusals, **7 are the gate failing, not the gate judging** —
a third of the refusal count. `scripts/capture-record.mjs` labelled them "no main
branch" and the demo cut renders them as a refusal *cause*, which turns an
operational bug into a policy rule. The underlying error is a branch-resolution
problem in the fork/base history read (`decide.ts`, the fork-side
`historyBackTo` call had no tolerant path while the base-side call did).

**Root cause (fixed in `8b38c2b`).** Two independent per-ref differences, both
of the same shape — a ref that does not exist reported as an outage:

- The Artifacts Workers binding's `log()`/`readFile()` **throws** for a ref that
  does not exist, while the local `GitAdapter` returns `[]`/`null`. A fork cut
  from an empty base therefore read as a healthy repo locally and as a broken
  gate in production. `packages/artifacts-port/src/cloudflare.ts` now maps a
  missing ref to `[]`/`null` and re-throws everything else, so a real outage
  still reaches the `error` verdict below.
- `decide.ts` read the fork on the base's `defaultBranch` instead of the branch
  the push actually moved (`push.ref`). The pushed branch now drives the fork
  history read, the fork file reads and the fork side of the conflict comparison
  (the base side still reads `branch`); an unknown branch fails closed as
  `proposal_not_found` rather than throwing.

Re-running those seven pushes should now produce a real verdict or
`proposal_not_found`, never `pipeline error`. Tests:
`packages/artifacts-port/src/cloudflare.test.ts` (missing ref → `[]`, missing
ref file → `null`, network failure still rejects, read failure still rejects)
and the `decidePush branch resolution` cases in `workers/gate/src/decide.test.ts`
(fail if the `pushedBranch` derivation is reverted).

What changed in this pass:

- `DecisionRecord.verdict` gains `"error"`, with its own reason shape
  (`{reason: "infra_failure", message}`, `FoundryReason` in `packages/stores`).
  The kernel's `RejectReason` union is untouched, so the Rust mirror still holds.
- The pipeline catch-all records `error`, never `reject`.
- The D1 store upserts on the event key and **only an `error` row can be
  replaced**; a final verdict is immutable. One row per event, from first failure
  to final verdict.
- `findByEvent` skips `error` rows, so a retry actually re-runs instead of
  short-circuiting on the failed attempt.
- The queue consumer retries the message for an `error` row instead of acking it;
  the row stays as the discoverable explanation if the retries are exhausted.
- Graph triples are written only for real verdicts (`isVerdictRecord`), so the
  graph can never hold a claim about an unfinished attempt.

Tests: `workers/gate/src/pipeline.test.ts` (transport failure → `error`, base
untouched; retry replaces the row with the real verdict; redelivery after an
error still returns the first real decision) and
`packages/stores/src/decisions.d1.test.ts` (the real D1 SQL against real SQLite,
including the `ON CONFLICT … WHERE verdict = 'error'` guard and 250-row paging).

**Not done:** the historical rows were not corrected and nothing was deployed
(this environment has no Cloudflare credentials — `wrangler whoami` reports not
authenticated). The data correction is:

```sql
UPDATE decisions
   SET verdict = 'error',
       reason  = json_object('reason', 'infra_failure',
                             'message', json_extract(reason, '$.message'))
 WHERE verdict = 'reject'
   AND json_extract(reason, '$.message') LIKE 'pipeline error:%';
```

## 5. History feed (`/history.json`) — paging and identity

Two defects, both fixed:

1. **Truncation.** The handler read `store.list(repo, 200)` and paged *inside*
   those 200 rows, so decisions older than row 200 were unreachable and the feed
   reported exhaustion rather than admitting the limit. Paging is now a database
   cursor (`listPage`, `id < beforeId`), and the handler reads one row past the
   page so `nextCursor` is null exactly when the feed is exhausted.
2. **Identity.** The feed emitted `sha: merged_sha ?? after_sha`, conflating the
   proposal with the commit that landed — and inviting a viewer to show a refused
   proposal as if it entered the base. It now emits `sha` (unchanged, for
   existing consumers) plus explicit `proposal_sha` and `merge_sha`, the latter
   `null` for refusals.

A malformed cursor is now `400` instead of being silently ignored.

## 6. Kernel parity — what is verified and what is not

- The port is **in the live path**, not a parallel subsystem (§2, step 1). The
  scope it evaluates is the ticket's, attached at intake.
- **Signature is not implemented — decided, not pending** (2026-10-15).
  `ScopeToken.signature?: number[]` exists as a type; `newScopeToken` never sets
  it, nothing verifies it, and no component issues or revokes signed tokens.
  Today the scope token is *data* the ticket store holds; integrity rests on who
  can write D1, not on cryptography. The Rust field (`Option<Vec<u8>>`) is
  equally unused, so the field is kept for shape-compatibility and is now
  labelled at the type (`types.ts`, on `signature`) as **not** a control. If
  remote-issued scopes are ever needed, this is the hook to implement — until
  then, a present `signature` proves nothing.
- **`allowsPath` now canonicalises, in both implementations** (fixed
  2026-10-15). It previously did prefix matching on the raw string, so
  `allowed_roots: ["src/allowed"]` admitted `src/allowed/../secret.txt` — a path
  that resolves outside the root. The two implementations also disagreed on the
  same input: Rust's `Path::starts_with` collapses repeated separators, so
  `src//allowed/x` was admitted there and refused by the port. Both sides now
  run the same lexical canonicalisation (`canonicalizePath` in
  `packages/gate-ts/src/types.ts`, `canonicalize_path` in
  `substrate/cc-kernel/src/types/scope.rs`), which resolves `.` and `..`,
  collapses repeated separators, keeps `\` a filename character (POSIX), and
  refuses an absolute path under a relative root. Symlinks remain out of scope:
  a string comparison cannot resolve them, so this is a policy boundary, not the
  last line of defence. The Rust edit is a **local patch to vendored code** and
  is recorded in `substrate/README.md`.
- **The path rule is wired, but fail-open when a caller omits the roots.**
  Corrected 2026-10-15: an earlier revision of this document said the
  orchestrator never sets `scope.allowed_roots`. That was true when this section
  was first written and is no longer true — intake now sets it at
  `workers/orchestrator/src/tasks.ts:161`
  (`scope.allowed_roots = [...(input.allowedRoots ?? [])]`), the ticket echoes
  the granted surface back to the caller, and `POST /tasks` validates the roots
  (an array of at most 50 repo-relative paths with no `.`, `..`, leading or
  trailing slash). `workers/orchestrator/src/tasks.test.ts:189` asserts the
  scope carries them and `:204` asserts an omitted list stays empty.
  What remains is a *default*, not a missing wire: `newScopeToken()` starts at
  `[]`, and an empty list permits every path, so a task created without
  `allowedRoots` still has no path control. That is deliberate (fail-open) and
  pinned by tests, but it means the control is only as good as the caller that
  sets it. `tools/usability-proof.ts` §3 exercises the enforced case end to end:
  a task created with `allowedRoots: ["src"]` that pushes `secrets.env` is
  refused with `reason=path_not_allowed` and the base does not move.
- **Fail-open defaults are now asserted.** Empty `allowed_roots` → every path;
  empty `allowed_tools` → every tool. Both were implicit; both are now pinned by
  tests (`test_allows_path_empty_roots_is_fail_open`, "treats empty roots as
  fail-open") so a change to them is a failing test rather than a silent
  widening.
- **Parity is fixture-driven** (added 2026-10-15). `fixtures/kernel-parity.json`
  holds 32 cases covering all twelve rules, and **both** sides execute it:
  `packages/gate-ts/src/parity.test.ts` and
  `substrate/cc-kernel/tests/parity.rs`. Both drive the real
  `check_admissibility` entry point — not a re-implementation of the rules —
  and compare the refusal *reason tag*, which is what the gate
  records. A rule changed on one side now turns the other side red; the case set
  also asserts that every rule 1–12 is represented. Verified non-vacuous:
  neutering the TypeScript canonicalisation fails exactly the two rule-10
  traversal cases.

## 7. Spatial Git — joined 2026-10-15

`workers/api` serves `/history.json` (paged, DB-cursor) and now also
`/git-history.json`, which renders the same decisions in the exact shape the
vendored viewer fetches (`{branches, commits:[{hash, fullHash, author, date,
message, branch, parents, files:[{path,type}], additions, deletions}]}`). The
viewer needed no edit: it already fetches `git-history.json`, so hosting
`substrate/spatial-git/index.html` on the API origin is the whole integration.

What the adapter decides, and why (`spatialFeed` in `workers/api/src/index.ts`):

- **One commit per decision**, oldest first, grouped by repo (the viewer's
  branch axis) — a fork is the meaningful lane in a multi-agent run, where every
  ref is `main` and would collapse into a single row.
- **Proposal and merge identity stay distinct.** `fullHash` is the merge commit
  for a merge and the proposal sha otherwise; `merge_sha` is `null` for a
  refusal. A refused proposal therefore cannot appear to have entered the base.
- **The verdict rides along** as `verdict`, `proposal_sha`, `merge_sha`,
  `decision_id` and `task_id`. The viewer ignores unknown fields; anything
  Foundry-aware reads the authoritative outcome instead of re-deriving it from
  git history. The commit message carries the verdict and refusal reason so the
  verdict is visible in the stock viewer without a viewer change.
- **Truncation is declared.** The feed reads one page (max 500) and sets
  `truncated` rather than letting a full page look like the whole history.

Tests: `workers/api/src/api.test.ts` — the viewer-facing field set is asserted
field by field, and a merge/refusal pair is checked for identity separation.

**Still not done:** navigation from the viewer into the evidence trail. The
viewer's click handler fetches `/api/diff/:hash`, which this worker does not
serve, so the inspector pane is inert on a Foundry-hosted viewer. Either serve
that path or accept the viewer as a read-only overview.

## 8. Open items, in the order they should be taken

1. ~~Root-cause the 7 branch-resolution failures~~ — **done** in `8b38c2b`
   (§4). What remains is the **data**: decision ids 3–9 on staging still read
   `reject/invalid_args`, and the correction SQL in §4 has not been run because
   this environment has no Cloudflare credentials. The demo cut also still
   renders "no main branch" as a refusal cause; both clear after the SQL runs and
   `scripts/capture-record.mjs` is re-run.
2. ~~Adversarial path tests against `allowsPath`~~ — **done, and the wiring
   landed too** (§6). The rule canonicalises in both implementations, the
   adversarial cases are tested on both sides, the fail-open defaults are pinned
   by tests, and intake sets `scope.allowed_roots` from the task
   (`workers/orchestrator/src/tasks.ts:161`), proven end to end by
   `tools/usability-proof.ts` §3. What remains is not code: tasks created
   *without* `allowedRoots` are still fail-open by design, so any caller that
   wants path scope must pass it.
3. ~~Decide on signature~~ — **done** (§6): kept for shape-compatibility with the
   Rust type, labelled at the field as explicitly not a control. No
   implementation of signing is pending; if remote-issued scopes are ever
   required, that is new work against this hook.
4. ~~Rust/TS parity fixtures~~ — **done** for the kernel (§6):
   `fixtures/kernel-parity.json`, run by both suites, reasons compared. Not yet
   covered: parity for the graph-kernel ↔ `lkg-client` triple shapes and for the
   trajectory schema ↔ `packages/evidence`, which are still prose claims.
5. ~~Connect the spatial view through an adapter~~ — **done** (§7): `/git-history.json`
   serves the viewer's own schema from the decision ledger, with verdict and
   proposal/merge identity carried through. What remains is the viewer's
   `/api/diff/:hash` inspector, which this worker does not serve.
6. **Evidence read path is now reachable** (2026-10-15): `GET
   /evidence/:taskId` on the API worker calls `recoverTask` from
   `packages/evidence` with the D1 ticket store and the decision store, and
   returns the chain plus the claim gate. Unconfigured is `503` naming the
   missing leg; nothing recovered is `404` with `gaps`; a partial chain is `200`
   with `gaps` — never an empty success. Tests cover all four.

   Still open: the **trajectory** half. `packages/evidence` reads ticket →
   decision → triples → memory; the
   `trajectory-memory-ledger` schema (`tool sequence, event counts, timing,
   successes, failures, outcome annotations`) is still only a reference, so
   "what sequence of operations produced this" is not recoverable from Foundry
   records. The join key would be the decision id; the gate still writes no
   trajectory events. Graph writes also remain best-effort with no per-decision
   record of whether the write succeeded.
7. ~~Verification interface~~ (typecheck/build/tests before finalising a merge)
   — **implemented**, see §9. What remains is persistence of a *passing*
   verdict, which needs a D1 column and therefore credentials (§9).
8. ~~Reconcile the local demo merger with production~~ — **resolved** (§3):
   documented as an intentional difference of purpose, with the shared
   `Fork-Head:` trailer as the contract both satisfy and an assertion for each.
   The port also stopped truncating commit messages to the subject, which had
   made that trailer unreadable.
9. ~~Pin an upstream revision per vendored system~~ — **done** (§`substrate/README.md`
   → Provenance). All four revisions resolved from the source checkouts on
   2026-10-15 and `diff -r` re-run: `live-knowledge-graphs` is byte-identical,
   and the other three differ by exactly the documented local modifications.
   Three of the four are reproducible from their revision; the fourth
   (`trajectory-memory-ledger`) was copied from a working tree with uncommitted
   edits, so its revision alone does not reproduce the vendored bytes. All four
   live outside this repository, so none is verifiable from a clean clone.

## 9. Required verification — implemented 2026-10-15

Admission and correctness are different questions, and the gate previously
answered only the first: it decided whether a proposal *may* land, never whether
the result *works*. `packages/verify` adds the second without merging it into
the first.

**Where it runs.** In `workers/gate/src/pipeline.ts`, after `decidePush` returns
`verdict: "merge"` and before `merger.merge(...)` is called. That position is
the whole point: every deterministic rule has passed and `decision.files` is
exactly what would land, so a failed check prevents the merge rather than
reporting on one that already entered the base. The base is asserted untouched
in the refusal test.

**What it is not.** It does not make an inadmissible proposal admissible, and a
passing check does not override a deterministic refusal. Enforced failure is
recorded as its own reason — `verification_failed` on `FoundryReason`, beside
`infra_failure` — so a refusal for correctness can never be read as a refusal
for scope or staleness. The kernel's `RejectReason` union is untouched, so the
Rust mirror still holds.

**Posture** (deliberately identical to `@foundry/plan-check`):

| Situation | Verdict | Blocks? |
|---|---|---|
| No verifier configured | `checked: false, ok: true` | never |
| Verifier unreachable / non-2xx / throws | `checked: false, ok: true`, with `error` | never — recorded as `error` by the catch-all, retryable |
| Server returned no checks | `checked: false`, `error: "no checks ran"` | never, and never recorded as a pass |
| A check ran and failed, `verifyEnforce` off (default) | `checked: true, ok: false` | no — advisory |
| A check ran and failed, `verifyEnforce` on | `checked: true, ok: false` | **yes** |

An outage is not a failed test, and no runner is not a passing one. Every
request carries `headSha`, so a result can never be attached to a different
revision than the one tested; check output is truncated to 400 chars so one run
cannot fill the ledger.

**Wiring.** `VERIFY_URL` (optional secret) selects `HttpVerifier`;
`VERIFY_ENFORCE=1` makes failures blocking. Unset means `StubVerifier` and the
pipeline behaves exactly as it did before — the capability is connected but
inert until a deployment opts in, which is why this changes no deployed
behaviour.

**Server contract** (`POST <VERIFY_URL>/api/verify`):

```
{ repo, baseBranch, files: string[], headSha }
  -> { runs: [{ name, ok, output? }] }
```

**The gap.** A *passing* verification is not persisted. `decisions` has no
column for it, and adding one is a live migration this environment cannot run
(no Cloudflare credentials), so the store writes nothing and a merge record
cannot show which checks ran. The migration is:

```sql
ALTER TABLE decisions ADD COLUMN verification TEXT;  -- JSON VerifyVerdict
```

plus the matching write in `D1DecisionStore.record` and a field on
`DecisionRecord`. `workers/gate/schema.sql` already carries the column (asserted
by the schema test in `decisions.d1.test.ts`), so a fresh database is ready and
only an existing one needs the `ALTER`. Until that runs, a failed enforced check *is* recorded (as a
rejection with `verification_failed`) — only the passing case is invisible, and
that is the honest half to be missing.

Tests: `packages/verify/src/index.test.ts` (13 — every posture row above,
including the outage-not-a-failure and no-runs-not-a-pass cases) and
`workers/gate/src/pipeline.test.ts` ("required verification", 6 — including that
a refusal leaves the base untouched, that an advisory failure still merges, and
that a throwing verifier records `error` rather than a rejection).
