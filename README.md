> **Current cloud-workspace source stop:** `R6-independent-source-review-complete-validation-HOLD`. [Independent review and local repairs](docs/cloud-workspaces/independent-review-2026-10-18/README.md) cover Linux user-namespace/filesystem isolation, input/capacity/liveness, actual Mac CAS accounting and durable operator recovery. No unresolved actionable finding remains in that bounded review scope. Compilation, tests and operational acceptance are pending; deployment/installation/provisioning/spending/credentials/merge/cleanup remain gated. Linux is still one owner-mediated retained attempt, not an unattended repeat-job service.

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

**Prerequisites.** The locked test runner declares Node `^22.12.0 || ^24.0.0 ||
>=26.0.0`; Node 23 and Node 22 releases before 22.12 are outside that declared
range. CI requests Node 22 but does not pin the exact patch release. The
proposed Node 24 handler image target is a separate runtime choice and is not a
tested claim. `npm` and `git` must be on `PATH`. Nothing else is required for the
TypeScript suites, the gate demo, or the usability proof — they shell out to
`git` and write only inside a temp directory. Rust is needed only for the
vendored substrate tests, which CI runs separately:

```bash
# optional, only for substrate/cc-kernel and substrate/live-knowledge-graphs
rustup toolchain install 1.98.1     # or any stable
rustup default 1.98.1
```

**Setup and the command that starts it:**

```bash
npm ci
npm run typecheck            # 0 errors
npx vitest run               # 227 passed, 23 files
npm run proof:usability      # 26 checks, all PASS — the whole loop, in-process
npm run demo:graphvc         # the same loop through a real git push + hook
# proof:usability covers intake -> merge -> path refusal -> enforced
# verification block -> advisory merge -> every API surface -> kernel rule 10.
# demo:graphvc does it over real bare repos with a post-receive hook.
# Both run entirely in /tmp. Nothing leaves your machine, no account needed.

# Optional: the three vendored substrate suites (needs the Rust toolchain).
#   cargo test --manifest-path substrate/cc-kernel/Cargo.toml                  # 65
#   cargo test --manifest-path substrate/live-knowledge-graphs/Cargo.toml      # 13 + 2 doctests
#   cargo test --manifest-path substrate/trajectory-memory-ledger/Cargo.toml   # 16
# All three run in CI; all three are green locally.
```

## Watch it live (staging)

The board below answers over HTTP right now. Its revision predates the newest
endpoints: `/`, `/decisions` and `/why/:sha` are live, while `/history.json`
still returns the old shape and `/git-history.json` and `/evidence/:taskId` are
not deployed yet. `docs/INTEGRATION-STATUS.md` §0 has the status codes and why.

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
