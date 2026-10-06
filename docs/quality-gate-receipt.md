# Quality-gate receipt (2026-10-06)

Synthesized from six lens reports. Two lenses carried inspected evidence
(lens-correctness, lens-contracts); four lens summaries arrived without
evidence bodies (see Omitted scope). Synthesis re-verified every carried
file:line claim below against the checked-in tree via targeted reads.
No tests were run in this synthesis.

Gate subject: local push→gate→merge→graph pipeline + K11 cross-task
overlap oracle + PACT plan-check hook.

## Gate verdict: CONDITIONAL PASS

- Local pipeline (decide/merge/record): PASS. Fail-open semantics hold;
  all LOWs are verdict-neutral.
- Cross-task overlap oracle coverage: FAILS OPEN (HIGH-1). No Foundry
  writer emits the `path:`/`touches` triples the oracle traverses, so the
  oracle can only ever return clean/unknown on Foundry-written data —
  never a contender. Worst case is today's tested local-only behavior,
  not a wrong verdict. Oracle contention claims are forbidden until a
  touches-writer lands.
- Contract surface: PASS with MEDs (edge-shape split, seed gap) — see below.

## Findings by severity

### HIGH

- HIGH-1 — Oracle traverses triples no Foundry writer creates.
  `packages/lkg-client/src/triples.ts:16-34` verdict/intake writers emit
  only `commit:`/`repo:`/`agent:`/`task:` subjects; nothing writes
  `path:` entities or `touches` predicates. Reader at
  `packages/lkg-client/src/overlap.ts:52,75` seeds traverses from
  `path:<p>` and requires `touches` as hop 1. Grep confirms `touches`
  appears only in overlap readers + test fixtures. Effect: oracle is
  structurally unable to find contenders on Foundry data; silently
  degrades to local-only. (lens-contracts; re-verified by synthesis)

### MEDIUM

- MED-1 — Seed gap: `start_candidates` never seeds `repo:`/`agent:`.
  gateway.py:326 seeds only `task:`/`path:`/`commit:`, though verdict/
  intake write `repo:`/`agent:` entities (`triples.ts:19,24`) and
  HIGH_SIGNAL edges (`on_repo`/`by_agent`/`on_base`/`has_fork`)
  terminate there. Seeds cannot reach those subgraphs directly.
  (lens-contracts; gateway.py is OUTSIDE this repo — not re-verified,
  see Truth boundaries)
- MED-2 — Edge-shape split by consumer. gateway.py:350,946-955 passes GK
  traverse paths verbatim (K11 `{source,target}` shape) with no
  normalization, while the TS contract
  `packages/lkg-client/src/index.ts:28-52` is `{subject,object}` via
  `normalizeEdge`. Same endpoint yields two edge shapes depending on
  consumer. (lens-contracts; gateway.py leg not re-verified; TS leg
  re-verified at index.ts:45-52)

### LOW

- LOW-1 — Partial traverse failures dropped without taint.
  `packages/lkg-client/src/overlap.ts:49-63`: per-path rejections map to
  `res: null` and are filtered; survivor-clean returns `[]`, not `null`.
  Verdict-neutral per `decide.ts:182` (null and [] both fall through to
  merge), but contradicts the `overlap.ts:1-5` header ("timeout yields
  null"). Fix the header or taint partial outages. (lens-correctness;
  re-verified)
- LOW-2 — `maxPaths` slices unsorted Set order.
  `packages/lkg-client/src/overlap.ts:45` slices to 20, but
  `workers/gate/src/decide.ts:179` passes `[...forkPaths]` (Set insertion
  order), not most-suspicious-first as `overlap.ts:15` documents. Under
  >20 changed paths the oracle may check the wrong 20.
  (lens-correctness; re-verified)
- LOW-3 — Fork-handle leak if base-get throws.
  `workers/gate/src/decide.ts:124-125` `port.get` calls sit outside the
  `try` (126) whose `finally:197-200` disposes both handles; a throw on
  the second `get` leaks the first handle. (lens-correctness; re-verified)

### INFO (fail-open behavior, working as designed)

- INFO-1 — Step 2b runs only when local diff is clean; `null` and `[]`
  both fall through to merge. `decide.ts:174-185`. Correct fail-open.
- INFO-2 — Oracle skipped on local conflict (`decide.test.ts:245-273`
  asserts called==false); null oracle merges (`decide.test.ts:225-243`).
- INFO-3 — Strict forward orientation `path→commit→task` + contiguity;
  reverse/wrong-predicate edges skipped. `overlap.ts:75-78`.
- INFO-4 — Self/known skips precede scope query; zero scope queries for
  self (`overlap.ts:78+80`; `client.test.ts:179`).
- INFO-5 — Unscoped task (no `on_base`) fails open.
  `overlap.ts:84-99`; `client.test.ts:185-187`.
- INFO-6 — Total-outage and tainted-no-contender return `null`.
  `overlap.ts:63+102`; `client.test.ts:190-220`.
- INFO-7 — `normalizeEdge` dual-shape + query unwrap.
  `index.ts:45-52+132-135`; `client.test.ts:56-80`.
- INFO-8 — Oracle threads into `decidePush`; oracle/local conflict files
  share sorted raw-path shape. `pipeline.ts:39+86`.

### PASS (contract matches)

- PASS-1 — `query()` accepts bare array (live K11) and `{triples,total}`
  (repo). `index.ts:131-135` + `client.test.ts:56-64`. Bare-vs-wrapped MATCH.
- PASS-2 — PACT check: POST `{chains}` →
  `{results:[{name,found,word?,present?,missing?,typechecks?}]}`
  field-for-field. api.rs:144-176 vs `plan-check/src/index.ts:8-15,50-60`.
  (api.rs is OUTSIDE this repo — Rust leg not re-verified.)

## Residual risks

1. HIGH-1 unaddressed: cross-task contention is invisible until a
   `touches`-writer is added (verdict or intake path). Any multi-task
   overlap claim is currently ungrounded.
2. LOW-2 under large diffs: >20-file forks get arbitrary 20-path oracle
   coverage; sort or prioritize before relying on oracle breadth.
3. MED-2: new consumers of the traverse endpoint must pick an edge shape;
   TS normalizes, Python does not — a future Python reader using
   `{subject,object}` will silently see empty fields.
4. MED-1: `repo:`/`agent:`-rooted traverses from gateway seeds may miss
   by construction.
5. Live K11 2-hop orientation/shape was NOT re-probed via GET in this
   review cycle; orientation claims rest on checked-in tests and the
   `overlap.ts:7-8` comment. A K11 shape change would silently zero the
   oracle (strict contiguity filter).

## Truth boundaries

Safe to claim (each grounded in this repo or `docs/truth-contracts.md`):

- "Local push→gate→merge→graph works end to end" (70/70 vitest + tsc +
  demo:graphvc true-history merge — per truth-contracts.md, not re-run here).
- "Gate fails open: oracle outage/unknown keeps local-only verdicts"
  (INFO-1/INFO-2/INFO-6, code-verified).
- "Plan check works against a live pact-server; advisory by default,
  enforce opt-in per task" (per truth-contracts.md).
- "K11 config proven on :18002; :18001 untouched" / "vector retrieval is
  JSON-fallback only" / "source_only: deploys are unproven"
  (per truth-contracts.md).

Forbidden claims (do NOT state):

- Oracle finds cross-task contenders in production (HIGH-1: no writer).
- Deployed / Artifact-backed / production / demo URL / judge-ready.
- Gateway uses K11 / HF Space alive / RAG++ live / pgvector serving /
  gate uses vectors / enforced in production / all chains pass.
- Anything about lenses 1–4 findings (evidence missing — see Omitted scope).
- gateway.py / api.rs line-level claims as synthesis-verified: those
  files live outside `/Users/mohameddiomande/Desktop/foundry` (find
  returned no hits); MED-1/MED-2/PASS-2 Python/Rust legs are
  lens-sourced only.

## Omitted scope

- Four of six lens reports (prior results 1–4) arrived as bare
  "structured result submitted" summaries with no evidence bodies, and
  the compact state carried only lens-correctness (prior result 6) and
  lens-contracts (prior result 5). Their findings are NOT represented
  in this receipt. Re-collect those four lens evidences and amend.
- Live K11 re-probe (GET traverse/query) not performed in synthesis.
- No tests, builds, or typechecks executed (per instruction).
- `gateway.py` / `api.rs` / pact-server Rust surface: outside repo,
  unverified here.
- Workers/D1/Artifacts deploy path, RAG++/pgvector recovery, and hosted
  pact-server remain blocked per truth-contracts.md and were not
  re-examined.

## R2 amendment (parent, 2026-10-06 ~02:15, first-hand evidence)

Lens bodies 1–4 never arrived (workflow ref-context bounds); the parent
re-verified their surfaces directly instead of re-running the workflow.

### HIGH-1: FIXED and proven on Foundry-written data
- `DecisionRecord.files` added (`stores/decisions.ts`, D1 `files TEXT`,
  `schema.sql`); pipeline records touched paths on merge
  (`Object.keys(files)` + `deletedFiles`) and conflict.
- New `touchTriples()` (`triples.ts`); written by both notify paths
  (Worker `queue()` and `tools/gate-runner.ts`); demo writes intake
  triples (`task→has_fork/on_base`).
- Proof (no probes): fresh `demo:graphvc` merge recorded
  `"files":["feature.txt"]`; K11 `task:task-1` shows `has_fork` +
  `on_base`; oracle `findContenders({baseRepo:"base", taskId:"task-2",
  paths:["feature.txt"]})` → `["feature.txt"]` in 346ms.
  Contention claims are now grounded for data written after this fix.
- Tests: `touchTriples` shapes (sorted/deduped/empty) + recorded-files
  assertions on merge + conflict. Suite 72/72 + tsc clean.

### LOW-1/2/3: FIXED
- LOW-1: oracle header now states per-path-survivor semantics.
- LOW-2: `decide.ts` passes `[...forkPaths].sort()` (deterministic).
- LOW-3: both `port.get` calls moved inside `try` with null-safe
  disposal. No dedicated leak test (needs handle spies; structure now
  obviously correct) — accepted residual.

### MED-1: ACCEPTED as residual
Parent-verified `gateway.py` seeds (`task:`/`path:`/`commit:`).
`repo:`/`agent:` are 2-hop reachable from any `task:` seed under
direction `both`, so direct seeds would only save one hop at ~230ms
per extra candidate. Not worth two more traverses per request.

### MED-2: DOCUMENTED as contract (no code change)
The split is intentional adapter behavior: the gateway owns the
`{source,target}` wire shape (its API contract; existing consumers
depend on it) and the TS client normalizes at its boundary via
`normalizeEdge`. New Python readers must use `{source,target}`;
new TS readers get `{subject,object}`. Stated here so the next
consumer does not guess.

### Backfilled lens surfaces (parent-measured, this session)
- Performance: `/tmp/gk_eval.json` — query p50 39/p95 128ms,
  traverse p50 ~230/p95 ~385ms, add p50 550ms, 20-concurrent wall
  279ms all-200, full scan 3.6s/18MB. Oracle live ~250-350ms/call.
  Gate hot path never scans; 20-path cap + 2.5s budget hold under p95.
- Failure modes: total-outage→null, tainted→null, partial→survivors,
  enforce-before-fork (no side effects), PACT outage fail-open —
  all unit-tested + live-probed.
- Security: `LKG_TOKEN` is env/secret-only (never in `wrangler.toml`
  vars); Bearer on all three KG calls when set; no secret literals
  in repo (Bearer only in header-construction code + tests use
  "sekrit"); probe triples namespaced `probe:`.
- K11 orientation re-probed live (residual risk 5 closed): 2-hop
  paths orient hop 0 from the queried start; strict contiguity
  filter matches; `out`/`outgoing` return `[]` (oracle uses `both`).

### Amended verdict: PASS
Residuals: LOW-3 leak path has no dedicated test; legacy (pre-fix)
K11 verdict triples lack `touches`/`on_base` (fail open, never wrong);
cloud deploy still `source_only` per truth-contracts.md.
