# Foundry — demo video shot script (6–8 min)

Target: a judge who has never seen the repo. Every claim on screen.

## 0:00–0:45 — The problem (talking head + 1 diagram)
- Hundreds of agents, one codebase. `git push` today is a trust fall.
- Foundry: every push is a proposal; merges are earned through a
  deterministic gate; every merge carries a why-trail.
- Show ARCHITECTURE.md diagram (push → queue → gate → D1 verdict → merge).

## 0:45–2:00 — Local proof (terminal)
- `npm ci && npm run typecheck` → 0 errors.
- `npx vitest run` → 135 passed, 19 files. Linger 3s on the summary.
- `npx tsx tools/graphvc-demo.ts --root /tmp/foundry-demo` → narrate:
  fork, ticket, agent push, verdict printed, base log advanced. All local.

## 2:00–4:30 — Live Cloudflare loop (terminal + dashboard/API output)
- Show the deployed workers (URLs on screen).
- Clone `seed` from Artifacts over https (token). Push a change.
- Query D1 `decisions`: **reject**, reason `no task ticket for fork seed`.
  Narrate: the gate refuses unticketed work — this rejection IS the feature.
- Show the ticketed setup (base + fork-1 + D1 ticket row, briefly).
- Push the agent feature to `fork-1`. Query D1: **merge**,
  `merged_sha 06841fc0`, files listed.
- Clone `base`, show the merge commit + files present. Verdict and reality match.

## 4:30–6:00 — The gate, in 3 rules (code + diagram)
- Rule 0: no ticket, no merge (show the reject row again).
- Rule 1: scope/layer/budget/freshness admissibility (kernel, deterministic).
- Rule 2: path conflicts route to a resolver with both sides — never silent.
- Every decision lands in D1 with reason + files + merged sha: the why-trail.

## 6:00–7:00 — Why it matters + close (talking head)
- Deterministic core, receipts everywhere, no vibes-based merging.
- Repo link, MIT, run instructions in README. "Every push a proposal."

## B-roll / cutaways
- `wrangler deployments` list, D1 row JSON, queue + subscription list output.
- Keep each terminal command full-screen, 24pt+, 3s holds on results.
