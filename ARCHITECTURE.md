# Foundry architecture

```
agents (N concurrent) ──push──▶ Artifacts (repo-per-task forks)
                                          │ repo.pushed (queue)
                                          ▼
                              ┌─ gate Worker ─────────────┐
                              │ 1. admissibility (gate-ts)│
                              │ 2. KG overlap (lkg-client)│
                              │ 3. review workflow        │
                              └───────┬───────────┬───────┘
                                   MERGE         REJECT + reason
                                      │               └─▶ agent retries
                                      ▼
                              main (isomorphic-git merge in-Worker;
                                    conflicts → merge-resolver agent)
                                      │
                                      ▼
                              memory: TML schema-v2 → R2 (offline score)
                                      + LKG triples (who knew what when)
                                      │
                                      ▼
                              experience: board (Working/Needs-you/
                                          In-review/Ready) + Spatial Git 3D
```

## Decisions

- Agents use stock git-over-HTTPS with repo-scoped tokens (`art_v1_<secret>?expires=`).
- Gate is 100% in-Worker (TS port of Rust `check_admissibility`); LKG/TML stay
  hosted off-Workers and are called via fetch.
- Events via account-level `artifacts` event subscription into the gate's `queue()`.
- Fallbacks: REST API + polling if subscriptions misbehave; Fly backup if the
  Mac-hosted LKG is unreachable at demo time.

## Data

- Decisions: D1 `decisions` table (created in spike, Phase 0.5).
- Trajectories: schema-v2 JSONL → R2, scored offline by `trajectory-ledgerd`.
- Task tickets: LKG triples linking task → fork → agents → merges.
