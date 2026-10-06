# Truth contracts (2026-10-06)

Per-claim evidence boundaries. Match every status report to `safe_claim`.

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
- domain: protocol hook (hosted fetch)
- status: ready_provisional
- evidence: `check_chains_reports_found_and_missing_in_place` (Rust) + live both-directions proof (generational ok:true, adversarial-forge ok:false, missing ok:false) + 6 plan-check unit tests
- remaining uncertainty: verdicts are corpus-dependent; no production pact-server host exists yet (localhost:8731 probes only)
- blockers: hosted pact-server for Worker path
- safe_claim: "plan check works against a live pact-server; advisory by default, enforce is opt-in per task"
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
- evidence: none (Paid spike pending; pre-existing)
- blockers: Workers Paid plan, artifacts access, `workers.dev` onboarding, iso transport unverified
- safe_claim: "source_only: deploys are unproven"
- forbidden_claims: ["deployed", "demo URL", "judge-ready"]
