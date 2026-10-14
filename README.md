# Foundry — an agent-native Git platform on Cloudflare

Every push is a proposal. Merges are earned, not assumed.

Foundry is built for a world where hundreds of agents work on the same codebase:
each agent gets an isolated fork, every push passes through a deterministic
admissibility gate, conflicts are recorded in D1 with both sides listed,
and every merge carries a why-trail (decision + trajectory + provenance).

Built for the [Cloudflare next-Git-platform competition](http://cloudflare.com/git-competition)
on Workers + Artifacts. See [ARCHITECTURE.md](ARCHITECTURE.md) for the
diagram and [IMPLEMENTATION.md](IMPLEMENTATION.md) for the full build account.

## Substrate (existing, integrated)

| Layer | Source |
|---|---|
| Merge gate | `substrate/cc-kernel` (Rust spec, `cargo test` in CI) + `packages/gate-ts` (TS port, 13 tests) |
| Shared knowledge + overlap | `substrate/live-knowledge-graphs` (KG server + eval) + `packages/lkg-client` (triple shapes) |
| Why-trail | `substrate/trajectory-memory-ledger` (schema-v2 + daemon) + `packages/evidence` (TS companion) |
| Orchestration pattern | `substrate/orchestratord` (heartbeat + dispatch daemon) + `workers/orchestrator` (fork-per-task) |
| 3D history view | `substrate/spatial-git` (git → 3D) fed by `GET /history.json` |

Upstream sources are vendored under `substrate/` (not submodules) so a
clean clone is complete — see `substrate/README.md` for provenance.

## Verify locally (no Cloudflare account needed)

```bash
npm ci
npm run typecheck            # 0 errors
npx vitest run               # 135 passed, 19 files
npx tsx tools/graphvc-demo.ts --root /tmp/foundry-demo
# -> fork, ticket, agent push, gate verdict, base log. All local.
```

## Live deployment (this entry, verified 2026-10-13)

| Piece | Where |
|---|---|
| Gate | https://foundry-gate.motionmix-participation.workers.dev |
| Orchestrator | https://foundry-orchestrator.motionmix-participation.workers.dev |
| Artifacts | namespace `foundry-dev`, repos `seed`, `base`, `fork-1` |
| D1 | `foundry-decisions` (`decisions` + `tickets`) |
| Events | `pushed` subscription (scoped per repo) → `foundry-push-events` → gate `queue()` |
| Task auth | `POST /tasks` requires `Authorization: Bearer <TASK_TOKEN>`; without the `TASK_TOKEN` secret the route fails closed (503) |

## Reproduce push → verdict (judge path)

```bash
npx wrangler login           # Workers Paid (Artifacts open beta)
# 1. Mint a token and clone the seed repo
npx wrangler artifacts repos issue-token seed --namespace foundry-dev
git clone 'https://x:<TOKEN>@<host>/git/foundry-dev/seed.git' seed
# 2. Push anything. No ticket exists for seed, so the gate rejects on purpose:
echo hi >> README.md && git -C seed commit -am ping && git -C seed push origin main
# 3. Read the verdict the gate recorded:
npx wrangler d1 execute foundry-decisions --remote \
  --command "SELECT repo, verdict, reason FROM decisions ORDER BY id DESC LIMIT 1;"
# -> seed | reject | no task ticket for fork seed
```

The ticketed merge path (fork + D1 ticket + push → `merge` + `merged_sha`
on base) was exercised live: merge `06841fc` landed on `base` with all
fork files, verdict row in D1. Two wiring notes for your own tasks:

```bash
# Task intake (creates the fork + D1 ticket; needs the secret from Deploy):
curl -X POST https://<orchestrator>/tasks \
  -H "Authorization: Bearer $TASK_TOKEN" -H 'Content-Type: application/json' \
  -d '{"baseRepo":"base","taskId":"t1","agents":["a1"]}'
# The subscription API is per-repo: subscribe each new fork or its
# pushes never reach the gate:
bash tools/subscribe-repo.sh staging 't1--a1'
```

## Deploy your own

```bash
npm ci
npx wrangler login
bash tools/setup-env.sh staging       # namespace, D1, queue, deploys, subscription
bash tools/setup-env.sh production
# Task intake needs a secret per environment (Bearer for POST /tasks):
printf '%s' "$(openssl rand -hex 32)" | npx wrangler secret put TASK_TOKEN -e staging
# Optional integrations (KG overlap, verdict triples, PACT checks):
npx wrangler secret put LKG_URL -e staging
npx wrangler secret put LKG_TOKEN -e staging
npx wrangler secret put PACT_URL -e staging
```
`tools/paid-spike.sh` is the original spike harness (kept for the
step-by-step account); `setup-env.sh` is the idempotent env provisioner.

## Layout

- `workers/orchestrator` — task intake: fork-per-task, token minting, agent dispatch
- `workers/gate` — queue consumer on `cf.artifacts.repo.pushed`: gate + merge
- `workers/api` — board UI (`GET /`) + `GET /decisions` + `GET /why/:sha` + `GET /history.json`, all D1-backed
- `packages/evidence` — standalone why-trail library (tested; not wired into workers yet)
- `packages/gate-ts` — Worker-native admissibility gate (TS port)
- `packages/lkg-client` — Live Knowledge Graph fetch client
- `web/` — board UI (Phase 3)
- `demo/` — seed repo + rehearsal script (Phase 2/3)

## License

MIT — see [LICENSE](LICENSE).
