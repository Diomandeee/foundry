# Foundry — Implementation

What the system is, what it is built from, and what is proven. Status as of
2026-10-14: **136/136 tests green, `tsc` clean**, live on staging and
production, plus a real three-agent project built through the gate tonight
(see below). There is no fake backend: the storage seam has two real
implementations — local git on disk and Cloudflare Artifacts over the
network, both exercised for real.

Companion docs: [README](README.md) (pitch + quickstart),
[ARCHITECTURE](ARCHITECTURE.md) (diagram + decisions).

## 1. What Foundry is

A merge gate for teams of AI agents sharing one codebase. Instead of pushing
to a shared branch, each agent gets its own copy (a fork), and every push is
treated as a proposal that must earn its merge. A deterministic checker
approves, refuses (with a machine-readable reason), or escalates on conflict.
Every outcome is recorded, and each merge carries its reason with it.

Two flows carry the whole system:

**Task intake** (`POST /tasks` → dispatches):

```
client → orchestrator → resolve base (create it if missing)
  → one fork per agent → mint access token → write ticket
  → return { clone URL, token, instructions, subscribe commands } × N
```

**Push pipeline** (queue event → recorded outcome):

```
agent git push → push event → gate queue
  → read event → look up ticket → run the checks
  → find conflicts (paths changed on both sides)
  → merge (apply files) | conflict (list files) | refuse (give reason)
  → record the decision → agent reads it, fixes and re-pushes if refused
```

## 2. Workers

Three Workers, one responsibility each. All are thin shells over tested core
functions; handlers only build production dependencies from `env`.

### orchestrator (`workers/orchestrator`)

- `GET /health` — liveness.
- `POST /tasks` — validates `{ baseRepo, taskId, agents[1..20],
  instructions? }`, returns per-agent dispatches plus the subscribe commands
  each new fork needs (unsubscribed forks are silently ignored by the gate,
  so the response tells you exactly what to run).
- Needs a secret token to accept tasks; without it the route refuses
  everything (fail-closed).
- Core: `src/tasks.ts` (`createTask`, covered by `tasks.test.ts`).

### gate (`workers/gate`)

- `queue()` — eats repo push events; non-push events are acknowledged and
  ignored, push events run the full pipeline, unexpected errors retry the
  message. `GET /` answers a stub line (this worker has no UI).
- Core files:
  - `src/decide.ts` — `decidePush`: ticket lookup → checks → conflict
    detection → `merge | reject | conflict`. Merges return the exact file
    set to apply.
  - `src/merge.ts` — `IsomorphicMerger` (real git over HTTPS inside the
    worker, in-memory filesystem) plus `commitForkFiles` and token handling.
  - `src/pipeline.ts` — `handlePush`: normalize → decide → merge → record,
    with a catch-all that records infrastructure failures as refusals so no
    push ever vanishes silently.
- Storage: D1 tables `decisions` + `tickets` (schema in `schema.sql`).
  One row per push; pushing the same commit twice records once.

### api (`workers/api`, live)

- `GET /` serves the decision board; `GET /decisions`, `GET /why/:sha`,
  `GET /history.json` serve the decision list, per-commit explanations, and
  the machine history feed — all straight from D1. Covered by `api.test.ts`.

## 3. Packages

### gate-ts (`packages/gate-ts`)

The checks as a plain TypeScript library, so they run identically in workers
and in unit tests. `src/types.ts` (scopes, layers, budgets, proposals),
`src/gate.ts` (the ordered rule check), `src/reject.ts` (the reason
vocabulary shared by gate, pipeline, and UI).

### artifacts-port (`packages/artifacts-port`)

The seam between decision logic and repo storage. Workers depend only on the
interfaces here — never on a backend.

- `src/port.ts` — repo operations (`create/get/list/delete`,
  `readFile/history/createToken/fork`) plus event normalization.
- `src/git.ts` — local git over the git CLI (bare repos on disk), plus a
  true-history merger. Node-only: tests, demo runner, local harnesses.
- `src/testing.ts` — shared seed/clone/commit/push harness: tests push
  through real git exactly as agents will.
- `src/cloudflare.ts` — thin wrapper over the real Artifacts binding.

### stores (`packages/stores`)

- `src/tickets.ts` — task tickets (task, base/fork repos, fork-point commit,
  agent, scope), in-memory and D1 stores.
- `src/decisions.ts` — decision rows, in-memory and D1 stores.

### lkg-client (`packages/lkg-client`)

Fetch client for an optional knowledge-graph server (triple shapes in
`src/triples.ts`, overlap query in `src/overlap.ts`). Used best-effort by the
orchestrator and gate; everything works with it unset.

### plan-check (`packages/plan-check`)

Optional plan-file validation at intake: a stub pass when unconfigured, a
server check otherwise (outages fail open). Per-task opt-in enforcement.

### evidence (`packages/evidence`)

Standalone decision-history companion library (tested; not wired into the
workers yet).

### tools/ (local loop)

- `graphvc-demo.ts` — builds base + fork, seeds a ticket, pushes as an
  agent, prints the decision and base log. Self-builds its runner bundle.
  Run: `npx tsx tools/graphvc-demo.ts --root /tmp/foundry-demo`.
- `gate-runner.ts` — same pipeline over local git (bundled for git hooks).
- `setup-env.sh` — idempotent environment provisioner (namespace, D1,
  queue, deploys, subscriptions). `staging` or `production`.
- `subscribe-repo.sh` — subscribes one repo's pushes to the gate queue.
- `paid-spike.sh` — the original spike harness, kept for the record.

## 4. The seams (how local-first works)

Every external dependency sits behind an interface with two implementations.
Nothing in the decision path knows which one it is talking to.

| Concern | Interface | Local (tests, demo) | Cloudflare (live) |
|---|---|---|---|
| Repo storage | `ArtifactsPort` | git on disk | Artifacts binding |
| Merge execution | `Merger` | true-history git merge | in-worker merge + push |
| Tickets | `TicketStore` | in-memory | D1 |
| Decisions | `DecisionStore` | in-memory | D1 |
| Knowledge | `KGClient` HTTP | skipped | optional graph server |
| Events | push event | local hook event | queue message |

## 5. The checks, in order

A push must survive all of these to merge. First failure is the verdict.

1. **Ticket check.** The fork must belong to a known task. Otherwise
   `invalid_args` ("no task ticket") — the most common verdict, and
   deliberate: anonymous work never merges.
2. **Non-empty diff.** Nothing changed, nothing to merge.
3. **Freshness.** The fork point must be under 5 minutes old, so agents
   merge against current code, not yesterday's.
4. **Scope.** Every touched path must be inside the task's allowed roots.
5. **Conflicts.** Paths changed on both sides since the fork point are
   compared by content — identical content is not a conflict. Real
   conflicts route to a resolver with both sides attached, never merged
   silently, never dropped quietly.

Verdicts: `merge` (with file set + merge hash), `reject` (with reason),
`conflict` (with the file list).

## 6. Data model

**Tickets** (one per agent fork): task, base repo, fork-point commit, fork
repo, agent, scope as JSON. D1 table `tickets`, keyed by fork.

**Decisions** (one per handled push): namespace, repo, branch, before/after
commit, verdict, reason, files touched, merge commit when approved, task and
agent ids, timestamp. D1 table `decisions`, indexed by repo and verdict.
The board UI and every explanation read exclusively from this table.

## 7. What we reuse

**Vendored upstreams** (`substrate/`, not submodules, so a clean clone is
complete — provenance in `substrate/README.md`):

- `cc-kernel` (Rust) — the rule-check spec `gate-ts` ports; tests mirrored.
- `live-knowledge-graphs` — the optional graph server behind `lkg-client`.
- `trajectory-memory-ledger` — the history format the decision rows follow.
- `orchestratord` — the dispatch pattern `workers/orchestrator` follows.
  Not vendored: upstream declares no license, so its code is not
  redistributed here (the pattern is described in prose).
- `spatial-git` — history-view tooling behind the machine feed.

**Open source** (pinned in `package-lock.json`): `hono@4` (HTTP routing),
`isomorphic-git@1` (git inside Workers), `memfs` (in-worker filesystem),
`wrangler@4` (CLI), `vitest` + `typescript` (strict).

## 8. Cloudflare surface and proof status

| Surface | Status |
|---|---|
| Workers (orchestrator / gate / api) | Deployed staging + production 2026-10-14 |
| Artifacts namespaces | `foundry-staging`, `foundry-prod` live with repos |
| Event subscriptions | Per-repo subs → queue → gate, live both envs |
| D1 | `foundry-decisions-staging` / `-prod`, schema applied |
| Staging proof | Ticketed fork merged (`ba3fe21`, files recorded); unticketed pushes refused with reasons; same-commit redelivery recorded once |
| Production proof | Unticketed push refused with reason on current build |
| Real build | Three agents built three slices of https://github.com/Diomandeee/fleet-dispatch in three ticketed forks; all three merged (verdicts recorded, base verified, 13/13 tests green on the merged tree) |

## 9. Verification

```bash
npm test            # vitest: 136/136 across all packages + workers
npm run typecheck   # tsc --noEmit, strict, zero errors
npx tsx tools/graphvc-demo.ts --root /tmp/foundry-demo  # local end-to-end
```

Test seams use real bare git repos in temp dirs; no test touches the
network. The network paths (Artifacts binding, HTTPS push) are proven by
the live staging/production verdicts above, not by mocks.

## 10. What is left

1. **Submission** — the demo is rendered and narrated
   (`../foundry-video/out/foundry-demo-narrated.mp4`, 5:13). The entry form at
   cloudflare.com/git-competition/submit needs the video hosted somewhere the
   form accepts, plus team details and the terms checkboxes. Deadline:
   Oct 14, 11:59 PM PDT.
2. **After the contest** — hosted history view, evidence wiring, resolver
   agent for conflicts.

`orchestratord` used to be listed here: it is no longer vendored, because
upstream declares no license and this repository is MIT. See
`substrate/README.md`.

## 11. Repo map

```
foundry/
  README.md  ARCHITECTURE.md  IMPLEMENTATION.md (this file)
  TECHNICAL-OVERVIEW.md  VIDEO-SCRIPT.md  LICENSE
  package.json (workspaces)  tsconfig.json (strict)
  workers/
    orchestrator/  tasks.ts (+test)  index.ts  wrangler.toml
    gate/          decide.ts (+test)  merge.ts (+test)  pipeline.ts (+test)
                   index.ts (queue)  schema.sql  wrangler.toml
    api/           index.ts (+test)  wrangler.toml
    participation-coordinator/  (separate MotionMix system; own README)
  packages/
    gate-ts/         reject.ts  types.ts  gate.ts (+test)
    artifacts-port/  port.ts  git.ts (+test)  testing.ts  cloudflare.ts
    stores/          tickets.ts (+test)  decisions.ts (+test)
    lkg-client/      triples.ts  overlap.ts  index.ts (+test)
    plan-check/      index.ts (+test)
    evidence/        (standalone companion)
  tools/  graphvc-demo.ts (+test)  gate-runner.ts  setup-env.sh
          subscribe-repo.sh  paid-spike.sh  post-receive  lkg-smoke.ts
          lkg-path-proof.ts  ppact-loop.ts  dist/ (built runner bundle)
  substrate/  (vendored upstreams; see substrate/README.md)
  docs/  (dated working papers: intake policy, review receipts)
  demo/ web/  (notes; board is served by workers/api)
```
