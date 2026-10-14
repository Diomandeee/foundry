# Foundry architecture

```
agents (N concurrent) ──push──▶ Artifacts (repo-per-task forks)
                                          │ repo.pushed (queue)
                                          ▼
                              ┌─ gate Worker ─────────────┐
                              │ 1. admissibility (gate-ts)│
                              │ 2. conflict check + KG    │
                              │    overlap (lkg-client)   │
                              │ 3. PACT chain check       │
                              └───────┬───────────┬───────┘
                                   MERGE         REJECT + reason
                                      │               └─▶ agent retries
                                      ▼
                              main (isomorphic-git merge in-Worker;
                                    conflicts recorded in D1 with both
                                    sides listed; resolver agent is
                                    future work)
                                      │
                                      ▼
                              memory: LKG verdict triples (live when
                                      LKG_URL is set); TML schema-v2 →
                                      R2 scoring is future work
                                      │
                                      ▼
                              experience: board (`GET /`, live) +
                                          Spatial Git 3D (substrate vendored,
                                          renders `GET /history.json`;
                                          hosted view is future work)
```

## Decisions

- Agents use stock git-over-HTTPS with repo-scoped tokens
  (`art_v1_<secret>?expires=`, minted by `packages/artifacts-port` via the
  Artifacts token API).
- Gate is 100% in-Worker (TS port of Rust `check_admissibility`); LKG/TML stay
  hosted off-Workers and are called via fetch.
- Events via account-level `artifacts` event subscription into the gate's `queue()`.
- Recovery, not hidden fallbacks: queue redelivery replays
  decide→merge→record idempotently (UNIQUE event index + first-decision-wins);
  a base that moved between decide and merge re-decides once, then records
  conflict. LKG is optional: overlap verdict notifications run only when
  `LKG_URL` is set — otherwise the gate is local-only.

## Data

- Decisions: D1 `decisions` table (created in spike, Phase 0.5).
- Trajectories: LKG verdict triples (live when `LKG_URL` is set);
  schema-v2 JSONL → R2 scoring is future work.
- Task tickets: D1 `tickets` table, plus LKG intake triples
  (task → fork → agents) when `LKG_URL` is set.
