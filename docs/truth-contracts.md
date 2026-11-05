# Truth contracts (2026-10-06)

Per-claim evidence boundaries. Match every status report to `safe_claim`.

> Status note 2026-10-14: the "Cloud deploy" row below is superseded —
> staging and production are live (namespaces, D1, queues, per-repo
> subscriptions, ticketed merges recorded). The body is preserved as the
> dated record; current proof status lives in IMPLEMENTATION.md §8.

## Local pipeline (decide/merge/record)
- domain: local pipeline
- status: ready
- evidence: 70/70 vitest (9 files) + `tsc --noEmit` + `demo:graphvc` true-history merge
- blockers: none
- safe_claim: "local push→gate→merge→graph works end to end"
- forbidden_claims: ["deployed", "Artifact-backed", "production"]

## K11 shared graph
- domain: live service (tailnet)
- status: ready
- evidence: `/tmp/gk_eval.json` (12 correctness probes + 6 perf benches), 95,980-triple census, oracle live 3-way proof (hit/self/legacy)
- blockers: none for reads/writes/traverse
- safe_claim: "K11 serves query/traverse/add at ~40/~230/~550ms p50; writes are idempotent"
- forbidden_claims: ["durable/HA", "backed up", "auth-protected"]

## PACT intake check
- domain: protocol hook (operator preflight live; staging orchestrator and gate live 2026-11-05)
- status: ready (staging)
- evidence: `check_chains_reports_found_and_missing_in_place` (Rust); pact-server live on Mac5 `100.72.126.88:8731` (launchd `com.pact.server`); `foundry_ops.py land` asks it for a spec's `chains` before the task opens, proved live 2026-11-05 (chain:deep-research 0/4 and chain:generational 4/4 pass, chain:nope refused `plan-refused`, nothing created); plan-check, tickets (real SQLite), gate and orchestrator tests 126/126 and foundry_ops 36/36 on Mac5 at 5539187
- rule change 2026-11-05: usable = found and typechecks. Missing canonical stages no longer refuse (PACT finding 0009: a pipeline rooted at Subject cannot close; the old rule refused 12 of 13 corpus chains)
- deployed 2026-11-05 on Mohamed's yes: `tickets.chains_json` on foundry-decisions-staging (452 tickets intact); Workers VPC service foundry-pact (01a1a95c) to `100.72.126.88:8731` on tunnel foundry-verify (fb73dc27), bound as `PACT_SERVICE` on both staging workers, `PACT_URL` a secret, gate `PACT_ENFORCE = "1"`; orchestrator 9a07752e, gate d9662821 (rollback: orchestrator 59ff3cb9, gate 51e1dd00)
- proved live 2026-11-05: POST /tasks with chain:no-such-chain-probe and planCheckEnforce refused 400 before any fork (an outage answers ok, so the refusal is pact-server's answer through the VPC route); fleet landing with chain:generational merged, decision 917, ticket chains_json `["chain:generational"]`; a ticket opened advisory with a bogus chain was refused by the gate itself, decision 921 `invalid_args` "pact: unusable chains: chain:no-such-chain-probe"
- remaining uncertainty: verdicts are corpus-dependent; the Worker route depends on Mac1's tunnel (com.foundry.verify-tunnel) and Mac5's server, and either down means not checked (fails open); orchestrator enforcement is per request (`planCheckEnforce`), foundry_ops refuses client-side instead; production has no PACT binding
- safe_claim: "landings that declare chains are checked against the live corpus before a task exists, and the staging gate refuses a merge whose declared chains PACT calls unusable"
- forbidden_claims: ["enforced in production", "all chains pass"]

## Gateway K11 flip
- domain: local service config
- status: partial
- evidence: `TestGkK11Compat` 3/3 + :18002 live run returning K11 for_task paths
- blockers: live :18001 still on dead HF Space URL; needs env flip + owner restart
- safe_claim: "K11 config proven on :18002; :18001 untouched and still serving RAG via JSON fallback"
- forbidden_claims: ["gateway uses K11", "HF Space alive"]

## RAG++/pgvector
- domain: Supabase backend
- status: blocked
- evidence: NXDOMAIN on project host + live probe showing all-`json` backends + 10.4s latency
- blockers: project does not resolve; needs new project + migration + ingest
- safe_claim: "vector retrieval is JSON-fallback only; excluded from the gate path by design"
- forbidden_claims: ["RAG++ live", "pgvector serving", "gate uses vectors"]

## Cloud deploy (Workers/Artifacts/D1)
- domain: public deployment
- status: blocked
- evidence: `wrangler deploy --dry-run` passes for gate (1043KB, ARTIFACTS+D1+LKG bindings resolve), orchestrator, api (2026-10-07); worker-safe barrel split enforced by construction
- blockers: Workers Paid plan, artifacts access, `workers.dev` onboarding, iso transport unverified
- safe_claim: "all three workers bundle for deploy; live calls await Paid spike"
- forbidden_claims: ["deployed", "demo URL", "judge-ready"]
