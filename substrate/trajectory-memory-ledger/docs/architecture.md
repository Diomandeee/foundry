# Architecture

Trajectory Memory Ledger separates durable ingestion from research and training.

## Rust Runtime

`trajectory-ledgerd` owns the live path:

1. Read `events-YYYY-MM-DD.jsonl`
2. Skip envelopes already covered by the date-scoped cursor
3. Group gateway envelopes by `flow_id`
4. Build one trajectory card per completed flow
5. Normalize the card to schema v2
6. Score it with the six-signal reward model
7. Append to the JSONL ledger under an exclusive file lock
8. Write cursor and Prometheus metrics atomically

The cursor is intentionally scoped by date:

```json
{"date": "2026-06-03", "seq": 42}
```

Daily event files may restart `seq` at 1. A global monotonic cursor would silently drop events after a date rollover.

## Research Layer

Python and notebooks should consume the normalized ledger for:

- batch extraction
- SFT export
- train/validation splits
- reward ablations
- selection experiments
- model training and evaluation
- paper metrics

This split keeps the operational collector reliable while leaving research tooling flexible.

## Evaluation Tools

The repository includes these Rust evaluation binaries:

- `daemon-bench`: generates synthetic gateway events and measures ingestion throughput, append latency, duplicate skipping, cursor rollover, and concurrent append safety.
- `agent-eval`: aggregates held-out tool-plan generations by condition. It is intended for downstream experiments comparing random trajectory selection, reward-selected trajectory selection, and the full normalized ledger export.
- `materialize-executable-bench`: joins canonical executable task specs with condition-specific candidate rows.
- `executable-task-bench`: runs each materialized candidate in an isolated workspace and aggregates hidden-test pass/fail results.
- `skillgraph-evolve`: converts executable benchmark deltas into regression-gated SkillDAG nodes, router indexes, and MUSE-style skill packages.

The synthetic `agent-eval` example in `examples/evaluation/` verifies the protocol shape. It is not downstream model-performance evidence.

## Harness Skills Layer

`skillgraph-evolve` sits after `executable-task-bench`. It compares a baseline report against a comparison report, groups task deltas by inferred task family, and emits:

- `trajectory-skills.jsonl`
- `skill-graph.json`
- `router-index.json`
- `skillgraph-evolution-report.json`
- `packages/<skill_id>/{SKILL.md,MEMORY.md,tests.jsonl,failure_modes.json,skill.json}`

The routing rule is conservative: only `promoted` skills can be auto-injected. `proposed` skills need a clean follow-up regression gate, `quarantined` skills are repair evidence, and `diagnostic` packages record persistent failures. This lets a failed adapter run improve the next harness iteration without poisoning automatic routing.

`scripts/apply_skillgraph_repair_router.py` is the first repair executor. It creates a candidate set by preserving baseline rows and swapping in comparison rows only for repaired task ids from explicitly allowed skill statuses. The resulting candidates still go through `materialize-executable-bench` and `executable-task-bench`; a repair becomes active only after a base-vs-router `skillgraph-evolve` run passes the same no-regression gate.

`scripts/run_anticipatory_repair_planner.py` is the pre-generation repair planner. It reads public task prompts, a trusted candidate set, and skillgraph package memory. It classifies incoming tasks by family and failure mode, retrieves only matching shared-failure memory, generates bounded public-recipe repairs, and admits a repair only after syntax, import, public starter-signature, and public probe checks pass. The script intentionally does not accept a hidden task-spec input; hidden verifier tests remain reserved for the final `materialize-executable-bench` plus `executable-task-bench` gate.
