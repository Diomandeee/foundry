# Foundry — an agent-native Git platform on Cloudflare

Every push is a proposal. Merges are earned, not assumed.

Foundry is built for a world where hundreds of agents work on the same codebase:
each agent gets an isolated fork, every push passes through a deterministic
admissibility gate, conflicts route to a merge agent with both sides as context,
and every merge carries a why-trail (decision + trajectory + provenance).

Built for the [Cloudflare next-Git-platform competition](http://cloudflare.com/git-competition)
on Workers + Artifacts. See [ARCHITECTURE.md](ARCHITECTURE.md) for the
diagram and [IMPLEMENTATION.md](IMPLEMENTATION.md) for the full build account.

## Substrate (existing, integrated)

| Layer | Source |
|---|---|
| Merge gate | `admissibility-kernel` (TS port in `packages/gate-ts`, spec: Rust `cc-kernel`) |
| Shared knowledge + overlap | `live-knowledge-graphs` (client: `packages/lkg-client`) |
| Why-trail | `trajectory-memory-ledger` (schema-v2 emitters) |
| Orchestration pattern | Agent Orchestrator (workers, worktrees, Kanban) |
| 3D history view | `spatial-git` |

## Verify locally (no Cloudflare account needed)

```bash
npm ci
npm run typecheck            # 0 errors
npx vitest run               # 119 passed, 16 files
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
on base) is scripted in `tools/paid-spike.sh` and was exercised live:
merge `06841fc` landed on `base` with all fork files, verdict row in D1.

## Deploy your own

```bash
npm ci
npx wrangler login
bash tools/paid-spike.sh     # namespace, D1, queue, deploys, subscription
```

## Layout

- `workers/orchestrator` — task intake: fork-per-task, token minting, agent dispatch
- `workers/gate` — queue consumer on `cf.artifacts.repo.pushed`: gate + merge
- `workers/api` — board + why-trail HTTP API
- `packages/gate-ts` — Worker-native admissibility gate (TS port)
- `packages/lkg-client` — Live Knowledge Graph fetch client
- `web/` — board UI (Phase 3)
- `demo/` — seed repo + rehearsal script (Phase 2/3)

## License

MIT — see [LICENSE](LICENSE).
