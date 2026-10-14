# Foundry — Implementation

Full account of what Foundry is, what it is built from, and what is proven.
Status as of 2026-10-14: **127/127 tests green, `tsc` clean**, all logic running
against **real git** (bare repos + clones on disk). There is no fake backend:
the port has two real implementations — `GitAdapter` (local git, now) and
`cloudflarePort` (Artifacts, spike-verified live 2026-10-13: push → gate →
verdict in D1 on dev, staging, and prod). The local `push → hook → gate →
merge → graph` loop is verified end-to-end (`npm run demo:graphvc`),
including live triple writes to K11.
Companion docs: [README](README.md) (pitch + quickstart),
[ARCHITECTURE](ARCHITECTURE.md) (diagram + decisions).

## 1. What Foundry is

An agent-native Git platform: instead of humans pushing to shared branches,
N agents each get an **isolated fork**, and every push is treated as a
**proposal** that must earn its merge. A deterministic gate admits, rejects
(with a typed reason), or escalates (on conflict) every push. All decisions are
recorded, and each merge carries a why-trail.

Two flows carry the whole system:

**Task intake** (`POST /tasks` → dispatches):

```
client → orchestrator → base resolve (auto-create if missing)
  → fork per agent → mint token → write ticket + scope
  → best-effort KG triples → return { remote, token, instructions } × N
```

**Push pipeline** (queue event → recorded outcome):

```
agent git push → cf.artifacts.repo.pushed → gate queue()
  → toPushEvent → ticket lookup → checkAdmissibility (12 rules)
  → conflict detect (fork-only vs base-only paths)
  → merge (apply files) | conflict (route to resolver) | reject (reason)
  → record decision (D1) → agent reads outcome, retries if rejected
```

## 2. Workers

Three Workers, one responsibility each. All are thin shells over tested core
functions; handlers only build production dependencies from `env`.

### orchestrator (`workers/orchestrator`)

- `GET /health` — liveness.
- `POST /tasks` — validates `{ baseRepo, taskId, agents[1..20], instructions? }`,
  returns 201 with per-agent dispatches, 400 on invalid input. On success it
  also writes `taskId —has_fork→ forkRepo` triples to the knowledge graph on a
  best-effort basis (a down KG never fails the task).
- Core: `src/tasks.ts` (`createTask`, deps-injected over `ArtifactsPort` +
  `TicketStore`, covered by `tasks.test.ts`).
- Bindings: `ARTIFACTS` (namespace `foundry-dev`), `DB` (D1
  `foundry-decisions`), var `LKG_URL`.

### gate (`workers/gate`)

- `queue()` — consumes Artifacts repo events; non-push events are acked and
  ignored, push events run the full pipeline, unexpected errors retry the
  message. `GET /` is a stub health line.
- Core files:
  - `src/decide.ts` — `decidePush`: ticket lookup → gate check → conflict
    detection → `merge | reject | conflict` verdict. Merges return the exact
    file set for the merger to apply.
  - `src/merge.ts` — `Merger` interface, `LocalMerger` (fake-backed),
    `IsomorphicMerger` (real git over http, memfs in Workers), plus
    `commitForkFiles` (squash-commit of fork files onto base) and
    `tokenSecret` (`art_v1_<secret>?expires=` → password).
  - `src/pipeline.ts` — `handlePush`: normalize → decide → merge → record,
    with a catch-all that records infrastructure failures as rejects so no
    push ever vanishes silently.
- Bindings: `ARTIFACTS`, `DB`. Schema in `schema.sql` (`decisions`,
  `tickets`).

### api (`workers/api`, stubs)

- `GET /health` live; `GET /decisions`, `GET /why/:merge`,
  `GET /history.json` return 501 until the next build chunk. These will serve
  the board UI, the why-trail, and the Spatial Git history feed from D1 +
  Artifacts history.

## 3. Packages

### gate-ts (`packages/gate-ts`)

Worker-native port of the Rust `cc-kernel` admissibility gate — the exact same
12 rules in the exact same order, with the `RejectReason` union as the shared
vocabulary between gate, pipeline, and UI.

- `src/types.ts` — `Layer` (L0 Observe … L4 Transform, plus-one transitions,
  time gates 0/2/5/15/30s), `LayerRange`, `ScopeToken` (tool/layer/path
  allowlists, mutation flag, 1h default expiry), `KernelState` (frontier,
  time gates, budget, monotone steps, snapshot), `Budget`, `CostModel`,
  `Mutability`, `SnapshotId` (32-byte hex; `fromShortHex` binds 40-char git
  shas by zero-padding), `ProposedCall`, `ProposalRef`, `Syscall`, `Ledger`.
- `src/gate.ts` — `checkAdmissibility(syscall, call, state, ledger, now)`.
- `src/reject.ts` — `RejectReason` + `describe()`.
- `src/gate.test.ts` — 13 tests: 4 mirrored from the Rust suite plus
  per-rule coverage (budget, steps, staleness, paths, args, proposals).

### artifacts-port (`packages/artifacts-port`)

The seam between decision logic and repo storage. Workers depend only on the
interfaces here — never on a backend.

- `src/port.ts` — `ArtifactsPort` (`create/get/list/delete`),
  `RepoHandle` (`info/readFile/history/createToken/fork/dispose`),
  `CommitInfo`, `PushEvent`, `toPushEvent` (normalizes both
  `cf.artifacts.repo.pushed` and local `foundry.local.pushed` demo events).
- `src/git.ts` — `GitAdapter`: real git over the git CLI (bare `<name>.git`
  repos; fork = `clone --bare`; history with per-commit paths). Plus
  `GitMerger`, a true-history merge (clone base, fetch fork, merge, push).
  Node-only: tests, agent runner, and local harnesses.
- `src/testing.ts` — `GitTestKit`: seed/clone/commit/push harness shared by
  every suite. Tests push through real git exactly as agents will.
- `src/cloudflare.ts` — `cloudflarePort(env)`: thin wrapper over the real
  Artifacts binding. Spike-verified live 2026-10-13 (push → verdict in D1,
  ticketed merge `06841fc`).

### stores (`packages/stores`)

- `src/tickets.ts` — `TaskTicket` (task, base/fork repos, fork-point sha,
  agent, scope), `TicketStore`, `InMemoryTicketStore`, `D1TicketStore`, plus
  `serializeScope`/`reviveScope` (Layers survive the D1 JSON round-trip).
- `src/decisions.ts` — `DecisionRecord`, `DecisionStore`,
  `MemoryDecisionStore`, `D1DecisionStore`.

### lkg-client (`packages/lkg-client`)

Fetch client for the Live Knowledge Graphs REST API
(`addTriple/query/traverse`), pointed at the K11 graph via `LKG_URL`
(the author's local default, not a Workers-reachable address).
Shapes are grounded in both the repo source
(`knowledge_handlers.rs`) and live probes, and the client tolerates both:
query accepts a bare array or `{triples,total}`; traverse posts
`{start,max_hops,direction,max_results}` and normalizes `{predicate,source,
target}` or full-triple edges. Known live quirk: K11 returns `[]` for
`direction:"outgoing"`, so the default is `"both"`. Used by the orchestrator
today; the gate's KG overlap check plugs in next.

### tools/ (local loop)

- `post-receive` — git hook template (`__ROOT__/__NS__/__LKG__/__REPO__/
  __RUNNER__` filled by the demo); unsets `GIT_DIR`/`GIT_WORK_TREE` and pipes
  a `foundry.local.pushed` event per ref-update into the runner.
- `gate-runner.ts` — hook target: `handlePush` with `GitAdapter` +
  JSON-file ticket/decision stores + `GitMerger`, then appends verdict
  triples to K11. Scopes survive the JSON round-trip via
  `serializeScope`/`reviveScope` (tolerant of raw `{value}` layers).
  Bundled with esbuild (`npm run bundle:runner`) since hooks invoke `node`.
- `graphvc-demo.ts` — builds base + fork, seeds a ticket, installs the hook,
  pushes as an agent, prints the decision and base log.
  Run: `npm run demo:graphvc`.
- `lkg-smoke.ts` — live write/read/traverse check.
  Run: `npm run smoke:lkg` (needs K11 reachable).

## 4. The seams (how mock-first works)

Every external dependency sits behind an interface with two implementations.
Nothing in the decision path knows which one it is talking to.

| Concern | Interface | Local git (verified now) | Cloudflare (spike verifies) |
|---|---|---|---|
| Repo storage | `ArtifactsPort` | `GitAdapter` (bare repos on disk) | `cloudflarePort` (binding) |
| Merge execution | `Merger` | `GitMerger` (true-history merge) | `IsomorphicMerger` + memfs |
| Tickets | `TicketStore` | `InMemoryTicketStore` | `D1TicketStore` |
| Decisions | `DecisionStore` | `MemoryDecisionStore` | `D1DecisionStore` |
| Knowledge | `KGClient` HTTP | (skipped in tests) | hosted LKG `:8001` |
| Events | `toPushEvent` | `foundry.local.pushed` | `cf.artifacts.repo.pushed` queue |

## 5. The gate and conflict rules

`decidePush` runs three stages. A push must survive all three to merge.

1. **Ticket check.** The fork must belong to a known task, and the pushed sha
   must exist in the fork's history. Otherwise `invalid_args` /
   `proposal_not_found`.
2. **Admissibility (12 rules).** The push becomes a `foundry.merge` call at
   layer APPLY with reversible mutability: scope validity → tool allowlist →
   layer-in-scope → frontier/+1 → time gate → budget → monotone steps →
   mutation permission → 5-minute proposal freshness → path allowlist → arg
   validation (40-char hex sha) → proposal ref exists in ledger with a
   snapshot matching base head (zero-tolerant). Admission state starts at
   frontier L2 so APPLY is exactly one step up.
3. **Conflict detection.** Walk fork history and base history back to the
   ticket's fork-point sha; union the changed paths on each side. Overlapping
   paths are compared by content — same content is not a conflict. If either
   backend cannot report per-commit paths, the push routes to `conflict` with
   `["unknown"]` (fail safe, never fail silent).

Verdicts: `merge` (with the file set to apply), `reject` (with a
machine-readable `RejectReason`), `conflict` (with the sorted file list —
a resolver agent consuming this is future work).

## 6. Data model

**Tickets** (one per agent fork) carry the fork point that makes conflict
detection possible: `{ taskId, baseRepo, baseSha, forkRepo, agentId, scope }`.
D1 table `tickets`, keyed by `fork_repo`, scope stored as JSON.

**Decisions** (one per handled push) are the audit trail: `{ namespace, repo,
ref, before_sha, after_sha, verdict, reason?, conflict_files?, merged_sha?,
task_id?, agent_id?, decided_at }`. D1 table `decisions`, indexed by repo and
verdict. The board UI and the why-trail read exclusively from this table.

**Trajectories** (next): gate/orchestrator emit TML schema-v2 JSONL
(canonical tool events + outcome) for offline scoring by
`trajectory-ledgerd` — this is the "why" behind each change, distinct from
the "what" in the decision row.

**KG triples** (live): `taskId —has_fork→ forkRepo` per dispatch; the gate's
planned overlap check will query these plus agent-claim triples.

## 7. What we reuse

**Your substrate** (the reason this entry is an integration play, not a
from-scratch build):

- `cc-kernel` admissibility gate (Rust) — the port spec for `gate-ts`;
  its test cases are mirrored 1:1 in `gate.test.ts`.
- `live-knowledge-graphs` — shared agent memory + admissibility tokens;
  `lkg-client` speaks its `:8001` REST API.
- `trajectory-memory-ledger` — schema-v2 trajectory format for the why-trail.
- Agent Orchestrator pattern — fork-per-task workers + Kanban supervision,
  re-implemented as Workers + D1.
- `spatial-git` — the 3D history view; `GET /history.json` will feed it from
  Artifacts commit history (planned).

**Open source** (pinned in `package-lock.json`):

- `hono@4` — HTTP routing in orchestrator/api workers.
- `isomorphic-git@1` — git clone/commit/push inside Workers (no git binary).
- `memfs` — in-Worker filesystem for isomorphic-git.
- `wrangler@4.147.0` — CLI + types (Artifacts needs ≥4.145.0).
- `vitest@5` + `typescript` (strict) + `@cloudflare/workers-types`,
  `@types/node` — test and check toolchain. Node v22 locally.

## 8. Cloudflare surface and proof status

| Surface | Use | Status |
|---|---|---|
| Workers | orchestrator / gate / api runtimes | Code complete; `wrangler types` clean for all three |
| Artifacts binding | `create/get/fork/readFile/history/createToken` | `cloudflarePort` written; live calls await Paid |
| Event subscriptions | Artifacts `pushed` → queue → gate `queue()` | LIVE 2026-10-13: scoped sub (foundry-dev/seed) + consumer; push→verdict in D1 |
| D1 | `decisions` + `tickets` tables | LIVE 2026-10-13: `foundry-decisions` + schema (+merged_sha); reject verdict recorded |
| Queues | event delivery into `queue()` | Same as subscriptions |
| Workers Static | board UI hosting | Phase 3 |
| Free-tier deploy | pipeline proof | Blocked once: needs workers.dev subdomain registration (dashboard onboarding) |

Paid-gated spike checklist — **done 2026-10-13** on dev, staging, and
production (`tools/setup-env.sh`, idempotent provisioner): namespace →
seed repo → D1 + queue → deploys → subscription → push → decision in D1 →
`IsomorphicMerger` clone/push over https → ticketed merge `06841fc`
landed on `base`.

## 9. Verification

```bash
npm test            # vitest: 127/127 across gate-ts, artifacts-port, stores, gate, orchestrator
npm run typecheck   # tsc --noEmit, strict, zero errors
npm run demo:graphvc  # push → hook → gate → 2-parent merge + K11 triples
npm run smoke:lkg     # live write/read/traverse against K11
```

Test seams: `GitAdapter` (real bare repos in tmp dirs) driven through
`GitTestKit`, `InMemoryTicketStore` / `MemoryDecisionStore`, and
isomorphic-git `init` in tmp dirs for `commitForkFiles`. No test touches the
network. The Artifacts binding calls and the clone/push http transport —
unprovable without Cloudflare — were proven live at the 2026-10-13 spike
(push → reject in D1, ticketed merge `06841fc`).

## 10. What is left

1. **API endpoints** — `GET /decisions`, `GET /why/:sha`, `GET /history.json`
   over D1 + Artifacts history.
2. **Agent runner** — Node script spawning N agents per dispatch behind an
   `AgentBackend` seam (mock now, Claude/Codex next).
3. **TML emitters** — schema-v2 JSONL per push/decision for offline scoring.
4. **Board UI + Spatial view** — Workers Static app on the API.
5. **Demo + video** — seed repo with conflicting tasks, rehearsal, 5–10 min
   recording, public repo + submission by Oct 14.
6. **Paid spike** — done 2026-10-13 (section 8); re-run via
   `tools/setup-env.sh` for any fresh environment.

## 11. Repo map

```
foundry/
  IMPLEMENTATION.md  (this file)   ARCHITECTURE.md  README.md  LICENSE
  package.json (workspaces)  tsconfig.json (strict)
  workers/
    orchestrator/  tasks.ts (+test)  index.ts (routes)  wrangler.toml
    gate/          decide.ts (+test)  merge.ts (+iso test)  pipeline.ts (+test)
                   index.ts (queue)  schema.sql  wrangler.toml
    api/           index.ts (stubs)  wrangler.toml
  packages/
    gate-ts/         reject.ts  types.ts  gate.ts (+test)
    artifacts-port/  port.ts  git.ts (+test)  testing.ts  cloudflare.ts
    stores/          tickets.ts (+test)  decisions.ts
    lkg-client/      index.ts (KG fetch client, K11-tolerant)
  tools/  gate-runner.ts  graphvc-demo.ts  post-receive  lkg-smoke.ts
  web/ demo/ (READMEs; built in later chunks)
```


## Integration (2026-10-06): K11 shared graph + PACT intake + gateway shim

All three systems share one knowledge graph (K11, via `LKG_URL`; the graph
is an optional integration — the gate is local-only without it).
Suite: 127/127 vitest + `tsc` clean; `demo:graphvc` merges end to end.

### Triple shapes (single authority: `packages/lkg-client/src/triples.ts`)
- Intake: `task:<id> —has_fork→ repo:<fork>`, `task:<id> —on_base→ repo:<base>`
- Verdict: `commit:<after> —gate_verdict→ merge|reject|conflict`,
  `—on_repo→ repo:<fork>`, `—by_agent→ agent:<id>`, `—for_task→ task:<id>`,
  `commit:<merged> —merged_from→ commit:<after>` (merge only)
- K11 census: ~96k triples, 54k nodes; `touches` edges are file-level and
  unscoped by repo — every Foundry read joins through `for_task` + `on_base`.

### Gate overlap oracle (`packages/lkg-client/src/overlap.ts`, decide step 2b)
- Local path-diff stays authoritative; the oracle adds cross-task signal only
  when local is clean. Fail-open: unknown (null) keeps local-only.
- Live K11 orients 2-hop paths from the queried path:
  `{touches, path:P -> commit:C}, {for_task, commit:C -> task:T}`.
  Contender = foreign task + same `on_base`; unscoped legacy tasks skipped.
- Parallel fan-out (20 paths cap, 2.5s budget): ~250ms live per call.
- Worker wiring: `LKG_URL` var + `LKG_TOKEN` secret; queue() also writes
  verdict triples best-effort (same helper as `tools/gate-runner.ts`).

### PACT plan check (`packages/plan-check`, `POST /tasks` `chains?: string[]`)
- `StubPlanCheck` (advisory pass) when `PACT_URL` unset; `PactServerPlanCheck`
  otherwise (2s timeout, fail-open on outage). `planCheckEnforce: true`
  rejects unusable chains BEFORE any fork exists (`invalid plan`, 400).
- New endpoint in pact-server: `POST /api/check-chains` (batch, in-place
  `found` flags, 100-name cap). Added under PACT governance: multi-sided
  gate test green, canaries 9/10 (lint fail is pre-existing pact-analysis
  warnings, zero hits in pact-server), lock check clean.
- Live: `chain:generational` 4/4 typechecks (ok:true);
  `chain:adversarial-forge` 2/4 non-typechecking (ok:false, by design).

### Gateway K11 shim (context-gateway, dual namespace)
- `_query_gk_traverse` tries bare names first (HF compat), then
  `task:`/`path:`/`commit:` variants (K11); qualified hints pass through.
- `HIGH_SIGNAL_PREDICATES` extended with the K11 VC set; authoring
  metadata (`authored_by`, `on_date`, `parent`) stays out.
- Proven on :18002 against K11 (for_task paths flow). Live :18001 still
  points at the dead HF Space URL — flip = set `GRAPH_KERNEL_URL` to K11
  in `~/.uctm-gateway.env` and restart the gateway (owner's call; the
  long-lived :18001 proc was deliberately not touched).
- Note: the route derives the GK project from `cwd`, not `project_hint`.

### RAG++ verdict: excluded from the gate by design
- Supabase host `nbiennrwugrojqsblpou.supabase.co` does not resolve
  (NXDOMAIN): pgvector is down, live retrieval is JSON-corpus fallback at
  ~10s per request. A probabilistic multi-second retriever cannot sit in
  a deterministic millisecond gate (same boundary as PACT P6). RAG++ fits
  async enrichment (merge-resolver context, board search) after a new
  project + migration + ingest — not the synchronous path. GK is
  sufficient for everything the gate decides.

### K11 eval (2026-10-06, `/tmp/gk_eval.json`)
| op | p50 | p95 | notes |
|---|---|---|---|
| query | 39ms | 128ms | bare-array; unknown -> `[]` 200 |
| traverse 1-hop | 199ms | 363ms | `both` works; `out`/`outgoing` -> `[]` |
| traverse 2-hop/50 | 228ms | 385ms | flat vs 1-hop; self-loop paths present |
| addTriple | 550ms | 606ms | idempotent (`added:false` on dup) |
| full scan | 3.6s | — | 18MB / ~96k triples |
| 20 concurrent q | 279ms wall | — | all 200 |
| invalid add | 422 | — | validated; missing traverse `start` -> 200 lenient |

### Vocabulary (PACT P2, doc-only — kernel parity untouched)
`conflict` = BLOCKED (boundary missing; resolver builds it with both sides),
`reject` = FAILED (typed reason; agent retries differently). No type changes:
`gate-ts` still mirrors the Rust kernel exactly.

### Post-gate fixes (R2, same night)
- HIGH-1 (oracle had no touches-writer): `DecisionRecord.files` recorded
  on merge/conflict; `touchTriples()` written by queue() + gate-runner;
  demo writes intake triples. Proven: fresh demo merge → oracle fires
  `["feature.txt"]` for a foreign same-base task in 346ms.
- LOW-1 header semantics corrected; LOW-2 deterministic sorted paths;
  LOW-3 handle-open moved inside try/finally.
- MED-1 accepted (repo:/agent: 2-hop reachable, not worth extra
  traverses); MED-2 documented as adapter contract (gateway owns
  {source,target}, TS normalizes at its boundary).
- Suite 72/72 + tsc clean. Receipt: `docs/quality-gate-receipt.md`.
