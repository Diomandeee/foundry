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

## Quickstart (spike)

```bash
npm install
npx wrangler login          # needs Workers Paid plan (Artifacts open beta)
npx wrangler types -c workers/gate/wrangler.toml
npm run deploy:gate && npm run deploy:orchestrator
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
