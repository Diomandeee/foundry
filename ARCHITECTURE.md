# Foundry architecture

How a push becomes a decision. Same vocabulary as the README: a **fork** is
an agent's private copy, **base** is the shared code, a **ticket** links one
task to one fork, a **verdict** is one recorded approve/refuse row.

```
agents push freely          Cloudflare receives         gate decides
                   │                    │                        │
                   ▼                    ▼                        ▼
          ┌─ fork per agent ──┐  ┌─ push event ──┐   ┌─ gate worker ─────────┐
          │ stock git over    │  │ one queue per │   │ 1. ticket exists?     │
          │ HTTPS, per-repo   │─▶│ repo, each    │──▶│ 2. diff non-empty?    │
          │ tokens            │  │ subscribed to │   │ 3. fork point fresh?  │
          └───────────────────┘  │ the gate      │   │ 4. no shared edits?   │
                                 └───────────────┘   │ 5. paths in scope?    │
                                                     └───┬───────────┬───────┘
                                                     APPROVE        REFUSE
                                                         │              │
                                                         ▼              ▼
                                              merge into base,   write refusal
                                              record approval   + reason.
                                              + merge hash.      nothing lands.
                                                         │              │
                                                         └──────┬───────┘
                                                                ▼
                                                     D1 decisions table:
                                                     one row per push,
                                                     newest last.
```

## Path of one push, end to end

1. **Task intake** (`workers/orchestrator`, `POST /tasks` with a secret
   token): creates the fork from base's current head, writes the ticket row
   (task, base repo, fork repo, fork-point commit, allowed paths, agent),
   returns the clone URL plus a short-lived token and the exact subscribe
   command for the new fork.
2. **Agent works**: plain `git clone`, `commit`, `push`. No custom client.
3. **Event delivery**: the push fires a per-repo event subscription into a
   queue the gate reads. A repo nobody subscribed is silently ignored —
   this bit us, so subscribing is part of intake, not a separate chore.
4. **Decide** (`packages/gate-ts`, runs inside the gate worker): load the
   ticket; diff fork against base in memory; run the five checks in order;
   first failure is the verdict. Pushing the same commit twice hits a
   uniqueness rule and is recorded once — redelivery is safe.
5. **Merge or refuse**: a pass is squashed onto base as a single commit
   (`workers/gate/src/merge.ts`, `commitForkFiles`), and that commit's hash is
   stored on the verdict row. The commit message carries `Fork-Head: <proposal
   sha>`, so the landed commit points back at the proposal it came from. A
   refusal stores the reason; the fork is untouched so the agent can fix and
   re-push. (The local demo's `GitMerger` makes a two-parent merge commit
   instead — a divergence, tracked in `docs/INTEGRATION-STATUS.md` §3.)
6. **Read**: `workers/api` serves the board, the JSON list, per-commit
   explanations, and the machine feed — all straight from the same table.

## What's inside the worker, and what stays outside

- The five checks run **inside the gate worker** as a plain library, so a
  verdict never depends on a network call. Two optional integrations live
  outside and are off unless configured: an overlap check against a
  knowledge-graph server, and a plan-file check. Both are advisory unless
  a deployment explicitly enforces them.
- The merge itself runs in-worker with an in-memory filesystem: clone base
  at its head, apply the fork's diff, commit. If base moved between the
  check and the merge, the gate re-checks once against the new head;
  if that fails it records a conflict instead of forcing anything.

## Data, in words

- `decisions`: one row per push — namespace, repo, branch, before/after
  commit, approve/refuse, machine-readable reason, files touched, merge
  commit when approved, task and agent ids, timestamp.
- `tickets`: one row per fork — task, base repo, fork-point commit, fork
  repo, agent, allowed paths plus expiry as JSON.
- Everything the board, the API, and the video show comes from these two
  tables. There is no second source of truth.

## Optional and future, labeled as such

- Overlap verdicts and task-intake records can also be mirrored to a
  knowledge-graph server when configured; the D1 rows stand without it.
- A 3D history view (`substrate/spatial-git`) renders the machine feed;
  hosting it is future work.
- A standalone evidence companion (`packages/evidence`) is tested but not
  wired into the workers yet.
