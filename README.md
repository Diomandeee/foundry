# Foundry — every push is reviewed before it lands

Foundry is a merge gate for teams of AI agents sharing one codebase. Agents
work in their own copies (forks) and push freely. Nothing reaches the shared
code (base) unless a deterministic checker approves it — and every approval
or refusal is written down with the reason, so you can always ask why.

Built for the [Cloudflare next-Git-platform competition](http://cloudflare.com/git-competition).
It runs on Workers (the checkers), Artifacts (git hosting), Queues (event
delivery), and D1 (the decision database).

## What happens when an agent pushes

```
agent ──git push──▶ fork repo ──push event──▶ queue ──▶ gate worker
                                                              │
                              ┌───────────────────────────────┘
                              ▼
                     1. find the ticket (which task owns this fork?)
                     2. compare fork against base (what changed?)
                     3. run the checks (empty? stale? conflicts? in scope?)
                              │
                 ┌─────────────┴──────────────┐
                 ▼                            ▼
              APPROVE                      REFUSE
                 │                            │
                 ▼                            ▼
      merge into base,              write the refusal + reason
      write the approval            into the database.
      + what landed                 nothing lands.
      into the database.
```

Concretely, the gate worker wakes up on each push event, loads the task
ticket for that fork from D1, diffs the fork against base in memory, and
applies the checks in a fixed order: ticket must exist, diff must be
non-empty, fork point must be fresh (under 5 minutes old), no file both
sides changed, every file inside the task's allowed paths. First failure
wins and is recorded. A pass is merged into base and the merge commit hash
is recorded next to the decision.

## The pieces and how they connect

| Piece | What it does, plainly |
|---|---|
| `workers/orchestrator` | Takes a task ("agent A, do X on base"), creates a fork, writes a ticket into D1, hands the agent a clone URL + token. Needs a secret token to accept tasks. |
| `workers/gate` | Wakes on every push, runs the checks above, merges or refuses, records the decision in D1. Has no web page — it only eats queue events. |
| `workers/api` | Read-only web front: the decision board (`/`), JSON list (`/decisions`), per-commit explanation (`/why/:sha`), machine feed (`/history.json`). |
| Cloudflare Queue | Carries each push event from its repo to the gate. Every repo is subscribed individually — an unsubscribed repo's pushes are silently ignored. |
| D1 `decisions` table | One row per push: who, what commit, approve or refuse, reason, files, merge hash. Push the same commit twice and the second is a recorded no-op. |
| D1 `tickets` table | Which task owns which fork, forked from what commit, what paths the agent may touch. |
| `packages/gate-ts` | The checks themselves, as a plain library with unit tests. |
| `substrate/` | Vendored upstream sources this project builds on (merge-spec, graph, ledger, history-view). Provenance in `substrate/README.md`. |

Words used above, defined once: a **fork** is an agent's private copy; **base**
is the shared code; a **ticket** is the task record linking the two; a
**verdict** is one recorded approve/refuse row; the **why-trail** is just the
verdict row plus the merge hash — enough to replay why any commit exists.

## Verify locally (no Cloudflare account needed)

```bash
npm ci
npm run typecheck            # 0 errors
npx vitest run               # 227 passed, 23 files  (+ Rust: 52 + 11 + 2 parity)
npm run proof:usability      # 26 checks, all PASS — the whole loop, in-process
npm run demo:graphvc         # the same loop through a real git push + hook
# proof:usability covers intake -> merge -> path refusal -> enforced
# verification block -> advisory merge -> every API surface -> kernel rule 10.
# demo:graphvc does it over real bare repos with a post-receive hook.
# Both run entirely in /tmp. Nothing leaves your machine, no account needed.
```

## Watch it live (staging)

Deployed and working now:

| Piece | Where |
|---|---|
| Board | https://foundry-api-staging.motionmix-participation.workers.dev |
| Gate | `foundry-gate-staging` (queue consumer, no web page) |
| Repos | Artifacts namespace `foundry-staging` (`dispatch`, `seed`, `base`, …) |
| Database | D1 `foundry-decisions-staging` |

Try the refusal path yourself — push anything to `seed` (no ticket exists for
it, so the gate refuses on purpose, and that refusal is the feature):

```bash
npx wrangler login           # Workers Paid (Artifacts is in open beta)
npx wrangler artifacts repos issue-token seed --namespace foundry-staging
git clone 'https://x:<TOKEN>@c1c0329d34dfd27ac727c8a4ff18611f.artifacts.cloudflare.net/git/foundry-staging/seed.git' seed
git -C seed commit --allow-empty -m ping && git -C seed push origin main
npx wrangler d1 execute foundry-decisions-staging --remote \
  --command "SELECT repo, verdict, reason FROM decisions ORDER BY id DESC LIMIT 1;"
# -> seed | reject | no task ticket for fork seed
```

The approval path ran live three times tonight: three agents built three
slices of a real project in three forks, and all three merged into `base`
with files and merge hashes recorded (see
https://github.com/Diomandeee/fleet-dispatch for what they built).

Task intake (creates a fork + ticket; needs the secret):

```bash
curl -X POST https://foundry-orchestrator-staging.motionmix-participation.workers.dev/tasks \
  -H "Authorization: Bearer $TASK_TOKEN" -H 'Content-Type: application/json' \
  -d '{"baseRepo":"base","taskId":"t1","agents":["a1"]}'
# Then subscribe the new fork, or its pushes never reach the gate:
bash tools/subscribe-repo.sh staging 't1--a1'
```

## Deploy your own

```bash
npm ci
npx wrangler login
bash tools/setup-env.sh staging       # namespace, D1, queue, deploys, subscriptions
bash tools/setup-env.sh production
printf '%s' "$(openssl rand -hex 32)" | npx wrangler secret put TASK_TOKEN -e staging
```

`tools/paid-spike.sh` is the original spike harness; `setup-env.sh` is the
idempotent provisioner. `ARCHITECTURE.md` and `IMPLEMENTATION.md` hold the
deeper design account and build log.

## License

MIT — see [LICENSE](LICENSE).
