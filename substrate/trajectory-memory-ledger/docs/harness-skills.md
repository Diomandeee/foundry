# Harness Skills Layer

The harness skills layer turns executable benchmark deltas into evidence-bound skill packages. It is the local implementation of the useful parts of SkillDAG, SkillOpt, and MUSE-style memory packaging without making an unsafe claim that a failed adapter should be routed automatically.

The key binary is `skillgraph-evolve`.

```bash
cargo run --bin skillgraph-evolve -- \
  --public-tasks examples/evaluation/executable-public-tasks-python-stdlib-heldout-v1.jsonl \
  --task-specs examples/evaluation/executable-taskset-python-stdlib-heldout-v1.jsonl \
  --baseline-report benchmarks/executable-task-mlx-gemma4-e2b-qat-base-heldout-v1-mac5-2026-06-10.json \
  --comparison-report benchmarks/executable-task-mlx-gemma4-e2b-reward-selected-512x4096-rawpython-heldout-v1-mac5-2026-06-10.json \
  --output-dir examples/skills/python-stdlib-heldout-v1/e2b-reward-selected-vs-base
```

## What It Builds

`skillgraph-evolve` reads:

- public task prompts
- canonical task specs
- one baseline `executable-task-bench` report
- one comparison `executable-task-bench` report

It emits:

- `trajectory-skills.jsonl`: one structured row per extracted skill family
- `skill-graph.json`: typed graph nodes and edges
- `router-index.json`: regression-gated routing index
- `skillgraph-evolution-report.json`: aggregate comparison report
- `packages/<skill_id>/SKILL.md`: human-readable activation boundary
- `packages/<skill_id>/MEMORY.md`: compact task evidence memory
- `packages/<skill_id>/tests.jsonl`: task-level evidence rows
- `packages/<skill_id>/failure_modes.json`: quarantine and diagnostic metadata
- `packages/<skill_id>/skill.json`: full structured package

## SkillDAG Mapping

The graph encodes four edge types:

| Edge | Meaning |
|---|---|
| `depends_on` | Skill evidence belongs to a specific task set |
| `specializes` | Skill applies to a task family such as `path`, `date`, or `parse` |
| `repairs` | Comparison passed a task that the baseline failed |
| `conflicts_with` | Comparison failed a task that the baseline passed |

This is deliberately a harness-side graph, not a model-side promise. The graph records where a trajectory delta helped, where it hurt, and which families need repair before routing.

## SkillOpt Mapping

The optimizer signal is the pass/fail delta:

- `fixed`: baseline failed, comparison passed
- `regressed`: baseline passed, comparison failed
- `preserved_pass`: both passed
- `shared_fail`: both failed

The global promotion gate defaults to:

- `net_pass_delta >= 1`
- `regressions <= 0`

Families with repairs but no local regressions are `proposed` if the global run failed. Families with any regression are `quarantined`. Families with only shared failures are `diagnostic`.

## MUSE-Style Packages

Each package is a portable skill-memory unit:

- `SKILL.md` says when it can apply and when it must not activate.
- `MEMORY.md` summarizes the evidence in task language.
- `tests.jsonl` preserves exact task-level deltas for replay.
- `failure_modes.json` keeps regression and shared-failure boundaries explicit.

The package is useful even when the adapter fails overall. It tells the next run which subskills deserve targeted repair and which ones must be blocked.

## Current 60-Task Result

The first generated package set compares Gemma 4 E2B QAT base against the reward-selected E2B adapter on `python-stdlib-heldout-v1-60`.

| Metric | Value |
|---|---:|
| Baseline passed | 50/60 |
| Comparison passed | 46/60 |
| Net pass delta | -4 |
| Fixed tasks | 5 |
| Regressed tasks | 9 |
| Shared failures | 5 |
| Promoted skills | 0 |
| Proposed skills | 1 |
| Quarantined skills | 7 |
| Diagnostic skills | 1 |
| Active router skills | 0 |

The positive proposed skill is `python_stdlib_math_trajectory_delta`, because it repaired `py_v1_moving_average` without a math-family regression. It is still not active because the global adapter comparison failed. The router correctly leaves `active_skill_ids` empty.

This means the failed adapter large-suite result does not prove downstream adapter-level TML performance lift. It does prove that the harness can mine a failed run for bounded repair evidence without promoting unsafe behavior.

## Repair Router Test

The next step is to test a proposed skill without adopting the failed adapter globally. `apply_skillgraph_repair_router.py` starts from the base candidate rows and swaps in comparison rows only for repaired task ids from allowed skill statuses.

```bash
python3 scripts/apply_skillgraph_repair_router.py \
  --base-candidates examples/evaluation/executable-candidates-mlx-gemma4-e2b-qat-base-heldout-v1-mac5-2026-06-10.jsonl \
  --comparison-candidates examples/evaluation/executable-candidates-mlx-gemma4-e2b-reward-selected-512x4096-rawpython-heldout-v1-mac5-2026-06-10.jsonl \
  --skills-jsonl examples/skills/python-stdlib-heldout-v1/e2b-reward-selected-vs-base/trajectory-skills.jsonl \
  --allow-status proposed \
  --condition skillgraph_math_repair_router \
  --output examples/evaluation/executable-candidates-skillgraph-math-repair-router-heldout-v1-2026-06-10.jsonl \
  --report benchmarks/executable-candidate-generation-skillgraph-math-repair-router-heldout-v1-2026-06-10.json
```

Then materialize and execute the normal hidden-test gate:

```bash
cargo run --bin materialize-executable-bench -- \
  --tasks examples/evaluation/executable-taskset-python-stdlib-heldout-v1.jsonl \
  --candidates examples/evaluation/executable-candidates-skillgraph-math-repair-router-heldout-v1-2026-06-10.jsonl \
  --output examples/evaluation/executable-task-skillgraph-math-repair-router-heldout-v1-2026-06-10.jsonl

cargo run --bin executable-task-bench -- \
  --input examples/evaluation/executable-task-skillgraph-math-repair-router-heldout-v1-2026-06-10.jsonl \
  --output benchmarks/executable-task-skillgraph-math-repair-router-heldout-v1-2026-06-10.json \
  --require-real
```

Checked result:

| Metric | Value |
|---|---:|
| Preserved base rows | 59 |
| Routed repair rows | 1 |
| Routed task | `py_v1_moving_average` |
| E2B base | 50/60 |
| Math repair router | 51/60 |
| Net pass delta | +1 |
| Regressions vs base | 0 |
| Synthetic rows | 0 |

Running `skillgraph-evolve` on base vs the repair-router report promotes `python_stdlib_math_trajectory_delta` and writes active router artifacts under `examples/skills/python-stdlib-heldout-v1/math-repair-router-vs-base/`.

Boundary: this is a real narrow router lift on the 60-task executable gate. It is not a broad claim that the reward-selected adapter should replace the base model.

## Task-Level Repair Router

The stronger repair-map test routes all fixed task ids from the failed adapter while preserving base outputs for every known adapter regression. This uses quarantined family evidence only as task-level repair candidates; it does not activate the quarantined family wholesale.

```bash
python3 scripts/apply_skillgraph_repair_router.py \
  --base-candidates examples/evaluation/executable-candidates-mlx-gemma4-e2b-qat-base-heldout-v1-mac5-2026-06-10.jsonl \
  --comparison-candidates examples/evaluation/executable-candidates-mlx-gemma4-e2b-reward-selected-512x4096-rawpython-heldout-v1-mac5-2026-06-10.jsonl \
  --skills-jsonl examples/skills/python-stdlib-heldout-v1/e2b-reward-selected-vs-base/trajectory-skills.jsonl \
  --allow-status proposed quarantined \
  --no-require-no-skill-regressions \
  --condition skillgraph_task_repair_router \
  --output examples/evaluation/executable-candidates-skillgraph-task-repair-router-heldout-v1-2026-06-10.jsonl \
  --report benchmarks/executable-candidate-generation-skillgraph-task-repair-router-heldout-v1-2026-06-10.json
```

Checked result:

| Metric | Value |
|---|---:|
| Preserved base rows | 55 |
| Routed repair rows | 5 |
| Known adapter regressions preserved from base | 9 |
| E2B base | 50/60 |
| Task repair router | 55/60 |
| Net pass delta | +5 |
| Regressions vs base | 0 |
| Synthetic rows | 0 |
| Promoted repair families | 4 |

The base-vs-router skillgraph promotes `python_stdlib_date_trajectory_delta`, `python_stdlib_math_trajectory_delta`, `python_stdlib_parse_trajectory_delta`, and `python_stdlib_security_trajectory_delta` under `examples/skills/python-stdlib-heldout-v1/task-repair-router-vs-base/`.

Boundary: this proved that task-level repair routing can improve pass rate when used as a gated router. It still does not prove that the reward-selected adapter should replace the base model globally.

## Focused E4B Chat Overlay Router

The next repair cycle targeted only the five shared failures left by the 55/60 task router:

- `py_v1_parse_size_bytes`
- `py_v1_chunked_list`
- `py_v1_common_prefix_path`
- `py_v1_normalize_segments`
- `py_v1_split_filename_version`

The focused public prompt subset is `examples/evaluation/executable-public-tasks-python-stdlib-heldout-v1-shared-failures.jsonl`. Candidate generation used `scripts/generate_executable_candidates_mlx_lm.py` with the MLX-LM API backend, Gemma chat template, E4B QAT model, 512 generation tokens, and one public-only repair attempt. The focused hidden-test gate passed two candidates:

- `py_v1_common_prefix_path`
- `py_v1_normalize_segments`

`scripts/apply_passed_candidate_overlay_router.py` then overlaid only those passed candidates onto the 55/60 task router. The rejected focused candidates stayed out of the final router.

Checked result:

| Metric | Value |
|---|---:|
| Focused E4B chat repairs passed | 2/5 |
| Overlay rows from E4B chat | 2 |
| Preserved task-router rows | 58 |
| E2B base | 50/60 |
| Task repair router | 55/60 |
| Task plus E4B chat overlay router | 57/60 |
| Net pass delta vs E2B base | +7 |
| Regressions vs E2B base | 0 |
| Synthetic rows | 0 |
| Promoted repair families | 5 |

The base-vs-overlay skillgraph writes artifacts under `examples/skills/python-stdlib-heldout-v1/task-plus-e4b-chat-overlay-router-vs-base/`. It marks the comparison promotable, with seven fixed tasks, three shared failures, and zero regressions.

Boundary: this was the strongest 60-task evidence before the anticipatory planner pass. It proves regression-gated router-level repair lift. It does not prove that the failed adapter or any trained adapter should replace the base model globally.

## Anticipatory Public Repair Planner

`scripts/run_anticipatory_repair_planner.py` adds the pre-generation layer that the repair-router evidence points toward. It classifies public tasks before generation, retrieves only the matching skillgraph package memory, runs bounded public recipe checks, and overlays only admitted candidates.

The script intentionally does not accept a hidden task-spec path. Its report records `read_hidden_task_specs=false` and `hidden_tests_sent_to_model=false`.

```bash
python3 scripts/run_anticipatory_repair_planner.py \
  --public-tasks examples/evaluation/executable-public-tasks-python-stdlib-heldout-v1.jsonl \
  --base-candidates examples/evaluation/executable-candidates-skillgraph-task-plus-e4b-chat-overlay-router-heldout-v1-2026-06-10.jsonl \
  --skill-dir examples/skills/python-stdlib-heldout-v1/task-plus-e4b-chat-overlay-router-vs-base \
  --condition skillgraph_anticipatory_public_repair_planner \
  --output examples/evaluation/executable-candidates-skillgraph-anticipatory-public-repair-planner-heldout-v1-2026-06-10.jsonl \
  --admitted-candidates-output examples/evaluation/executable-candidates-anticipatory-public-repairs-heldout-v1-2026-06-10.jsonl \
  --report benchmarks/executable-candidate-generation-skillgraph-anticipatory-public-repair-planner-heldout-v1-2026-06-10.json
```

Checked planner admission result:

| Metric | Value |
|---|---:|
| Admitted public-checked repairs | 3 |
| Admitted tasks | `py_v1_parse_size_bytes`, `py_v1_chunked_list`, `py_v1_split_filename_version` |
| Preserved previous-overlay rows | 57 |
| Rejected tasks | 0 |
| Synthetic rows | 0 |

After materialization and hidden executable scoring:

| Metric | Value |
|---|---:|
| E2B base | 50/60 |
| Previous E4B overlay | 57/60 |
| Anticipatory public repair planner | 60/60 |
| Net delta vs previous overlay | +3 |
| Net delta vs E2B base | +10 |
| Regressions vs previous overlay | 0 |
| Regressions vs E2B base | 0 |

The base-vs-planner skillgraph writes artifacts under `examples/skills/python-stdlib-heldout-v1/anticipatory-public-repair-planner-vs-base/`. The previous-overlay-vs-planner proof lives under `examples/skills/python-stdlib-heldout-v1/anticipatory-public-repair-planner-vs-e4b-overlay/`.

Boundary: this proves the anticipatory repair planner as a public-check, regression-gated router/planner on this 60-task suite. It still does not prove broad adapter-level model improvement.

## Skill-to-LoRA Preflight

`scripts/prepare_skill_to_lora_experiment.py` adds the adapter-experiment bridge for promoted harness packages. It reads the package-level `SKILL.md`, `MEMORY.md`, `tests.jsonl`, `failure_modes.json`, and `skill.json`, then writes deterministic seed SFT rows, teacher-generation prompts, adapter registry metadata, per-skill MLX training command templates, and eval prompts for `no_skill`, `full_skill_text`, `skill_lora`, `wrong_lora_control`, and `shared_lora_control`.

```bash
python3 scripts/prepare_skill_to_lora_experiment.py \
  --skill-run-dir examples/skills/python-stdlib-heldout-v1/anticipatory-public-repair-planner-vs-base \
  --status promoted \
  --output-dir output/private-skill-to-lora-2026-06-23 \
  --report benchmarks/skill-to-lora-preflight-2026-06-23.json \
  --adapter-root output/private-skill-lora-adapters-2026-06-23
```

Checked preflight result:

| Metric | Value |
|---|---:|
| Promoted skills prepared | 6 |
| Seed examples | 30 |
| Teacher prompt files | 12 |
| Eval prompt rows | 150 |
| Public-safe report | `benchmarks/skill-to-lora-preflight-2026-06-23.json` |

All six skills are currently `needs_teacher_generation`, not `ready_for_adapter_training`, because the package evidence rows are seed examples rather than a complete behavior-training corpus. This preserves the current claim boundary: Skill-to-LoRA is now prepared as an experiment lane, while the proven result remains the public-check repair planner/router.
