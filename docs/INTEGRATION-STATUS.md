# Foundry — integration status and contract corrections

Reconnaissance pass over the core workflow and the four vendored substrate
systems, with the state classified per capability. Written 2026-10-15 against
`main` @ `8b38c2b`, 2026-10-15. The fixes in §4 and §5 are committed and green.

How this was established (all re-runnable):

```bash
npm run typecheck                        # 0 errors
npx vitest run                           # 21 files, 155 tests, all pass
cargo test --manifest-path substrate/cc-kernel/Cargo.toml        # runs in CI
curl -s <staging board>/decisions?limit=200                      # live ledger
```

Nothing in this document is inferred from a package existing. Where a status is
not backed by a test or a live read, it says so.

---

## 1. Component status

Status vocabulary: Reference · Ported · Locally verified · Integrated ·
Production verified · Advisory · Planned/incomplete.

| Component | Status | Evidence |
|---|---|---|
| `substrate/cc-kernel` (Rust) | Reference + CI-verified | `cargo test` in `.github/workflows/ci.yml:45`; `substrate/cc-kernel/tests/integration_test.rs` |
| `packages/gate-ts` (12-rule kernel port) | Ported + locally verified + **Integrated** | `packages/gate-ts/src/gate.ts`; called from the live decision path at `workers/gate/src/decide.ts:230` |
| `packages/gate-ts` path allowlist | Ported, **not a security boundary** | `allowsPath` in `packages/gate-ts/src/types.ts`; see §6 |
| `packages/gate-ts` scope token | Ported, **unsigned** | `signature?: number[]` (`types.ts:95`) is declared and never set or verified — see §6 |
| `workers/orchestrator` | Integrated | `workers/orchestrator/src/tasks.ts` + `tasks.test.ts`; `wrangler.toml` binds D1 + Artifacts |
| `workers/gate` | Integrated, **production verified** | `src/decide.ts` (verdict), `src/merge.ts` (merge), `src/pipeline.ts` (decide→merge→record); live staging ledger holds its rows |
| `workers/api` | Integrated, production verified | `src/index.ts` board + `/decisions` + `/why/:sha` + `/history.json`; `api.test.ts` |
| `packages/artifacts-port` | Integrated | `cloudflarePort` bound in the gate worker; `GitAdapter`/`GitMerger` used by local demo |
| `packages/stores` (D1) | Integrated, production verified | `tickets.ts`, `decisions.ts`; schema `workers/gate/schema.sql` |
| `packages/lkg-client` | **Integrated but advisory** | `workers/gate/src/index.ts` builds `KgOverlapOracle` when `LKG_URL` is set; verdict triples are written best-effort in a `try/catch` that only warns |
| `substrate/live-knowledge-graphs` | Reference | `cargo test` in CI (its own crate); authority for `triples.ts` shapes |
| `packages/evidence` (trajectory companion) | **Locally verified, unwired** | `packages/evidence/src/index.ts` + `index.test.ts`; no import outside the package |
| `substrate/trajectory-memory-ledger` | Reference | schema `examples/trajectory-card.schema-v2.json`; no runtime import |
| `substrate/spatial-git` | Reference | viewer + CLI vendored; consumes its own `git-history.json`, **not** Foundry's `/history.json` — see §7 |
| `packages/plan-check` (PACT) | Integrated but **advisory by default** | `decide.ts` step 1b; rejects only when `enforce` is set; outages fail open (`checked=false, ok=true`) |
| `workers/participation-coordinator` | Integrated (separate product line) | `@foundry/participation-coordinator`, own D1, same Cloudflare account/subdomain |

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
proposal → landed-commit link. The local demo's two-parent merge is a divergence,
not a second policy. Either the demo should squash too, or the divergence must be
documented as intentional — it is currently neither, and the two docs each
describe one of them as if it were the only one.

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
- **Signature is not implemented.** `ScopeToken.signature?: number[]` exists as a
  type; `newScopeToken` never sets it, nothing verifies it, and no component
  issues or revokes signed tokens. Today the scope token is *data* the ticket
  store holds; integrity rests on who can write D1, not on cryptography. Treat
  the field as vestigial or implement the Rust scheme — do not treat it as a
  control.
- **`allowsPath` is not a security boundary.** It strips trailing slashes and
  does prefix matching with a directory boundary; `..`, backslashes, dot-segments
  and absolute paths are not normalised. `allowed_roots: ["src"]` accepts
  `src/../secret.txt`, which resolves outside the root. In the gate the paths come
  from git tree entries (git itself rejects `..` segments), which is what keeps
  this from being exploitable today — but the function must not be reused for
  non-git input, and the adversarial cases in the brief are not yet tested.
- **Fail-open defaults.** Empty `allowed_roots` → every path allowed; empty
  `allowed_tools` → every tool allowed. Both are noted on the type fields
  (`types.ts:86,91`) but appear in no gate rule, README or test, and
  `newScopeToken()` defaults both to empty — so a ticket saved without explicit
  roots is unrestricted, silently. That default should be an explicit decision in
  the contract, not a side effect.
- Parity test coverage between Rust and TypeScript is **not** fixture-driven:
  `packages/gate-ts/src/gate.test.ts` is a standalone TS suite, and the Rust
  tests live in `substrate/cc-kernel/tests/`. There is no shared fixture set and
  no comparison of refusal reasons across the two implementations.

## 7. Spatial Git — the consumer is not connected

`workers/api` serves `/history.json`. The vendored viewer does **not** read it:
`substrate/spatial-git/index.html` fetches `git-history.json`, produced by
`cli.js`/`git-to-json.sh` from a local repo checkout, in the shape
`{commits: [{hash, fullHash, author, date, message, branch, parents, files,
additions, deletions}]}`. The viewer renders `c.author`, `c.date`, `c.files`,
`c.message` and has **no concept of a verdict**.

So the endpoint exists and the viewer exists, and nothing joins them. Connecting
them needs a thin adapter on Foundry's side (decisions → the viewer's commit
shape, carrying verdict/proposal/merge identity) rather than an edit to the
vendored viewer. Until then, "the visualization shows the authoritative record"
is false: there is no visualization reading that record.

## 8. Open items, in the order they should be taken

1. ~~Root-cause the 7 branch-resolution failures~~ — **done** in `8b38c2b`
   (§4). What remains is the **data**: decision ids 3–9 on staging still read
   `reject/invalid_args`, and the correction SQL in §4 has not been run because
   this environment has no Cloudflare credentials. The demo cut also still
   renders "no main branch" as a refusal cause; both clear after the SQL runs and
   `scripts/capture-record.mjs` is re-run.
2. **Adversarial path tests** against `allowsPath`, and a decision on whether the
   fail-open defaults are intended (they should be explicit in the contract).
3. **Decide on signature**: implement, or delete `signature` and document that
   scope integrity is stored, not cryptographic.
4. **Rust/TS parity fixtures**: one shared case set, outcomes and reasons compared.
5. **Connect the spatial view** through an adapter, and show missing graph or
   evidence records as missing rather than omitted.
6. **Trajectory/evidence**: `packages/evidence` is unwired; decide the minimum
   event set the gate needs, then wire it with the decision id as the join key.
   Graph updates are best-effort today, which is a defensible choice — but it is
   not yet recorded *whether* a given decision's graph write succeeded.
7. **Verification interface** (typecheck/build/tests before finalising a merge):
   does not exist. Today the gate admits a change; it does not establish that the
   result compiles or passes.
8. **Reconcile the local demo merger with production** (§3) or document the
   divergence as intentional.
