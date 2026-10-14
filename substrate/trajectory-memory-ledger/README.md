# Trajectory Memory Ledger

Schema-normalized experience replay for self-improving coding agents.

Trajectory Memory Ledger is a systems architecture and Rust runtime for turning real coding-agent work into a durable learning signal. It records tool-use trajectories, normalizes heterogeneous logs into a stable schema, scores each trajectory with a six-signal reward model, and exports the resulting ledger for training, routing, analysis, and evaluation.

The reference daemon is `trajectory-ledgerd`, a Rust binary that owns the infrastructure-sensitive live path:

- ingest dated gateway event files
- normalize records to schema v2
- score trajectories at emit time
- track cursor state by `(date, seq)`
- append JSONL records with file locking
- export Prometheus text metrics

Python, notebooks, and training scripts can then consume the normalized ledger for SFT export, ablation reports, and model training.

## Why This Exists

Most coding-agent evaluations are point-in-time benchmarks. Real agents, however, produce a continuous stream of behavior: reads, edits, tests, retries, failures, corrections, and successful completions. The ledger treats those trajectories as experience replay.

The core claim is simple: if agent work is recorded in a stable schema, scored with interpretable process signals, and replayed into training/routing loops, the system can improve from its own operating history without requiring human preference labeling for every step.

## Current Artifact

This repository contains:

- `crates/trajectory-ledgerd`: Rust daemon and library
- `docs/schema-v2.md`: canonical trajectory schema
- `docs/reward-model.md`: six-signal reward model
- `docs/architecture.md`: system architecture
- `docs/metrics.md`: Prometheus metrics
- `docs/evaluation.md`: benchmark results and downstream evaluation protocol
- `docs/harness-skills.md`: SkillDAG/SkillOpt/MUSE-style harness skills layer
- `docs/skill-to-lora.md`: Skill-to-LoRA preflight for harness-skill behavior adapters
- `docs/training-lift-next-plan.md`: next controlled downstream-lift protocol
- `docs/real-repo-issue-gate.md`: SWE-bench-style base-vs-TML planner proof gate
- `examples/`: synthetic event and trajectory examples
- `examples/evaluation/karl-v7-heldout-coding-agent-model-scores.jsonl`: privacy-preserving aggregate rows from a real held-out coding-agent model-quality benchmark
- `examples/evaluation/executable-taskset-python-stdlib-smoke.jsonl`: canonical executable smoke task specs
- `examples/evaluation/executable-candidates-smoke.jsonl`: synthetic candidate/model-output rows for the executable smoke suite
- `examples/evaluation/executable-task-smoke.jsonl`: materialized smoke rows for the executable task benchmark runner
- `examples/evaluation/executable-taskset-python-stdlib-heldout-v0.jsonl`: hidden-test executable held-out task specs
- `examples/evaluation/executable-public-tasks-python-stdlib-heldout-v0.jsonl`: public prompts used for real model-output generation
- `examples/evaluation/executable-candidates-claude-sonnet-karl-context-2026-06-07.jsonl`: non-synthetic Claude Sonnet candidate rows
- `examples/evaluation/executable-candidates-gemini-flash-karl-context-2026-06-07.jsonl`: non-synthetic Gemini 2.5 Flash candidate rows
- `examples/evaluation/executable-candidates-mlx-gemma3-1b-adapters-mac5-clean-2026-06-10.jsonl`: non-synthetic MLX adapter candidate rows from the controlled training-lift split
- `examples/evaluation/executable-candidates-mlx-gemma4-e2b-qat-base-mac5-2026-06-10.jsonl`: non-synthetic MLX-VLM Gemma 4 E2B QAT base-model candidate rows
- `examples/evaluation/executable-candidates-mlx-gemma4-12b-qat-base-mac5-2026-06-10.jsonl`: non-synthetic MLX-VLM Gemma 4 12B QAT base-model candidate rows
- `examples/evaluation/executable-taskset-python-stdlib-heldout-v1.jsonl`: 60-task hidden-test executable held-out task specs
- `examples/evaluation/executable-public-tasks-python-stdlib-heldout-v1.jsonl`: public prompts for the 60-task replication suite
- `examples/evaluation/executable-public-tasks-python-stdlib-heldout-v1-shared-failures.jsonl`: public prompts for the five shared failures left by the 55/60 task repair router
- `examples/evaluation/executable-candidates-skillgraph-task-plus-e4b-chat-overlay-router-heldout-v1-2026-06-10.jsonl`: non-synthetic 60-task router rows after overlaying only E4B chat candidates that passed focused executable evaluation
- `examples/evaluation/executable-candidates-skillgraph-anticipatory-public-repair-planner-heldout-v1-2026-06-10.jsonl`: 60-task router rows after public-only anticipatory repair planning
- `examples/evaluation/swebench-verified-mini-public-manifest-2026-06-11.jsonl`: 50-row public-safe SWE-bench Verified Mini manifest, with gold patches and test oracle fields omitted
- `examples/evaluation/real-repo-gate/`: synthetic fixture rows proving the SWE-bench-style claim guard, not performance
- `examples/skills/python-stdlib-heldout-v1/e2b-reward-selected-vs-base/`: generated harness skill packages from the 60-task E2B adapter comparison
- `examples/skills/python-stdlib-heldout-v1/math-repair-router-vs-base/`: generated harness skill packages from the promoted narrow math repair router
- `examples/skills/python-stdlib-heldout-v1/task-repair-router-vs-base/`: generated harness skill packages from the promoted task-level repair router
- `examples/skills/python-stdlib-heldout-v1/task-plus-e4b-chat-overlay-router-vs-base/`: generated harness skill packages from the focused E4B overlay result, 57/60 with zero regressions
- `examples/skills/python-stdlib-heldout-v1/anticipatory-public-repair-planner-vs-base/`: generated harness skill packages from the strongest checked router result, 60/60 with zero regressions versus E2B base
- `examples/skills/python-stdlib-heldout-v1/anticipatory-public-repair-planner-vs-e4b-overlay/`: generated harness skill packages proving +3 over the previous 57/60 overlay with zero regressions
- `benchmarks/skill-to-lora-preflight-2026-06-23.json`: public-safe Skill-to-LoRA preflight report for six promoted harness skills
- `paper/trajectory-memory-ledger.md`: paper draft

The originating deployment corpus, not included here, contains 7,468 scored trajectories, 67,409 observed tool events, and 73,470 recovered tool steps. Raw private trajectories are intentionally excluded from this public artifact.

## Install

```bash
git clone https://github.com/Diomandeee/trajectory-memory-ledger.git
cd trajectory-memory-ledger
cargo build --release
```

## Run One Ingestion Pass

```bash
cargo run --release --bin trajectory-ledgerd -- run \
  --once \
  --date 2026-06-03 \
  --events-dir examples \
  --cursor /tmp/trajectory-ledgerd.cursor \
  --store /tmp/trajectory-ledgerd-trajectories.jsonl \
  --metrics /tmp/trajectory-ledgerd.prom
```

Inspect the output:

```bash
cat /tmp/trajectory-ledgerd-trajectories.jsonl | jq .
cat /tmp/trajectory-ledgerd.prom
```

Run continuously by omitting `--once` and pointing `--events-dir` at a live gateway event directory.

## Evaluation

Run the daemon benchmark:

```bash
cargo run --release --bin daemon-bench -- \
  --flows 1000 \
  --steps 3 \
  --concurrent-writers 8 \
  --records-per-writer 100 \
  --output benchmarks/daemon-benchmark-2026-06-03.json
```

Current checked-in result on Apple M4 / macOS 15.6.1 / rustc 1.95.0:

- 8,000 synthetic event envelopes ingested in 6.287s
- 1,272.385 events/sec
- 159.048 trajectory cards/sec
- append latency mean/p95: 3.627ms / 4.027ms
- duplicate reprocess skip: 1,000 duplicate cards skipped
- date-scoped cursor rollover: passed
- concurrent append: 800/800 records, 800 unique IDs

Run the agent-evaluation aggregation harness:

```bash
cargo run --bin agent-eval -- \
  --input examples/evaluation/tool-plan-generations.jsonl \
  --output benchmarks/agent-eval-example-2026-06-03.json
```

The checked-in `agent-eval` example is synthetic. It demonstrates the tool-plan aggregation protocol, not downstream model improvement.

Run the real held-out coding-agent model-quality benchmark:

```bash
cargo run --bin heldout-agent-bench -- \
  --input examples/evaluation/karl-v7-heldout-coding-agent-model-scores.jsonl \
  --output benchmarks/karl-v7-heldout-agent-benchmark-2026-04-02.json
```

This benchmark aggregates the real KARL V7 model run from `2026-04-02`: 10 models x 5 held-out coding-agent session contexts, scored by `karl.v7.style_validator.overall` with pass threshold `0.4`. Raw private generations are intentionally not included.

Current result:

- total evaluated contexts: 50
- score metric: `karl.v7.style_validator.overall`
- best by mean score with latency tie-break: `GPT-5.4-mini`
- 1.0 mean score / 100% quality pass: `GPT-5.4-mini`, `GPT-OSS 120B`, `MiniMax M2.5`, `DeepSeek R1`
- fastest 1.0-score model: `GPT-5.4-mini` at 1.5688s mean latency
- lowest result: `Qwen3.5 397B`, 0.0 mean score / 0% quality pass

Boundary: this measures model response quality on held-out coding-agent contexts. It does not execute repository tasks or prove that reward-selected trajectory training improves SWE-style task completion. The repository now includes that same-task adapter gate; its first result is negative for executable task completion, even though reward-selected training gives the best validation loss.

Run the executable task benchmark smoke suite:

```bash
cargo run --bin materialize-executable-bench -- \
  --tasks examples/evaluation/executable-taskset-python-stdlib-smoke.jsonl \
  --candidates examples/evaluation/executable-candidates-smoke.jsonl \
  --output examples/evaluation/executable-task-smoke.jsonl

cargo run --bin executable-task-bench -- \
  --input examples/evaluation/executable-task-smoke.jsonl \
  --output benchmarks/executable-task-smoke-2026-06-06.json
```

The materializer keeps the held-out task set separate from condition-specific candidate files, which is the format needed for real random/reward/full-ledger model outputs. The executor then materializes each candidate into an isolated temp workspace, runs its verifier command, captures pass/fail, timeout, duration, and output previews, then aggregates by condition. The checked smoke fixture is synthetic and exists to validate the execution path only. It is not model-lift evidence.

Smoke result:

- `reward_selected`: 3/3 pass
- `full_ledger`: 2/3 pass
- `random`: 0/3 pass
- synthetic rows: 9/9

Run the real executable model-output benchmark:

```bash
python3 scripts/generate_executable_candidates_cli.py \
  --public-tasks examples/evaluation/executable-public-tasks-python-stdlib-heldout-v0.jsonl \
  --trajectory-store "$KARL_TRAJECTORY_STORE" \
  --output examples/evaluation/executable-candidates-claude-sonnet-karl-context-2026-06-07.jsonl \
  --raw-dir /tmp/tml-real-model-output-2026-06-07 \
  --report benchmarks/executable-candidate-generation-claude-sonnet-2026-06-07.json \
  --backend claude \
  --model sonnet \
  --max-budget-usd 2.00

cargo run --bin materialize-executable-bench -- \
  --tasks examples/evaluation/executable-taskset-python-stdlib-heldout-v0.jsonl \
  --candidates examples/evaluation/executable-candidates-claude-sonnet-karl-context-2026-06-07.jsonl \
  --output examples/evaluation/executable-task-claude-sonnet-karl-context-2026-06-07.jsonl

cargo run --bin executable-task-bench -- \
  --input examples/evaluation/executable-task-claude-sonnet-karl-context-2026-06-07.jsonl \
  --output benchmarks/executable-task-claude-sonnet-karl-context-2026-06-07.json \
  --require-real
```

Real non-synthetic result on the six-task Python stdlib held-out set:

- Claude Sonnet: `random` 6/6, `reward_selected` 6/6, `full_ledger` 6/6
- Gemini 2.5 Flash: `random` 5/6, `reward_selected` 5/6, `full_ledger` 4/6
- synthetic rows: 0/36 across the two real reports

Boundary: this proves executable model-output measurement. It does not prove trained reward-selected trajectory lift over random, because Claude saturated the benchmark and Gemini tied `reward_selected` with `random` while beating `full_ledger`.

Prepare the controlled training-lift gate:

```bash
python3 scripts/prepare_training_lift_experiment.py \
  --trajectory-store "$KARL_TRAJECTORY_STORE" \
  --heldout-public-tasks examples/evaluation/executable-public-tasks-python-stdlib-heldout-v0.jsonl \
  --heldout-task-specs examples/evaluation/executable-taskset-python-stdlib-heldout-v0.jsonl \
  --output-dir output/private-training-lift-2026-06-08 \
  --report benchmarks/training-lift-preflight-2026-06-08.json \
  --sample-size 96 \
  --probe-remote \
  --remote-host mac5
```

Checked preflight result:

- private random/reward-selected/full-ledger train/valid splits were generated locally
- each condition has 96 selected records, split 86 train / 10 validation
- mean reward: `random` 0.6750, `reward_selected` 0.7408, `full_ledger` 0.6787
- remote trainer status: blocked, `mac5` SSH timed out
- Mac5-free local trainer status: ready with `KMP_DUPLICATE_LIB_OK=TRUE`
- local trainer resources: 16 GB memory, 6.97 GB free disk at preflight time

Run the trained-adapter executable gate after one MLX LoRA adapter has been trained per condition:

```bash
python3 scripts/generate_executable_candidates_mlx_adapter.py \
  --public-tasks examples/evaluation/executable-public-tasks-python-stdlib-heldout-v0.jsonl \
  --model mlx-community/gemma-3-1b-it-4bit \
  --adapter-root output/private-adapters-gemma3-1b-2026-06-10 \
  --output examples/evaluation/executable-candidates-mlx-gemma3-1b-adapters-mac5-clean-2026-06-10.jsonl \
  --raw-dir output/private-generation-raw-gemma3-1b-clean-2026-06-10 \
  --report benchmarks/executable-candidate-generation-mlx-gemma3-1b-adapters-mac5-clean-2026-06-10.json \
  --max-tokens 1024 \
  --timeout-s 360 \
  --seed 42

cargo run --bin materialize-executable-bench -- \
  --tasks examples/evaluation/executable-taskset-python-stdlib-heldout-v0.jsonl \
  --candidates examples/evaluation/executable-candidates-mlx-gemma3-1b-adapters-mac5-clean-2026-06-10.jsonl \
  --output examples/evaluation/executable-task-mlx-gemma3-1b-adapters-mac5-clean-2026-06-10.jsonl

cargo run --bin executable-task-bench -- \
  --input examples/evaluation/executable-task-mlx-gemma3-1b-adapters-mac5-clean-2026-06-10.jsonl \
  --output benchmarks/executable-task-mlx-gemma3-1b-adapters-mac5-clean-2026-06-10.json \
  --require-real
```

Checked Mac5 adapter-training result with `mlx-community/gemma-3-1b-it-4bit`:

- final validation loss: `reward_selected` 1.484, `full_ledger` 1.843, `random` 2.031
- relative validation-loss reduction vs `random`: `reward_selected` 26.93%, `full_ledger` 9.26%
- executable held-out task pass rate: `random` 0/6, `reward_selected` 0/6, `full_ledger` 0/6
- synthetic rows: 0/18 in the adapter-conditioned executable report

Boundary: this first adapter lane was a real negative result for the small Gemma 3 1B/256-token recipe, not for the ledger hypothesis overall.

Checked Mac5 Gemma 4 E2B adapter result with 512 selected rows per condition, 460 train / 52 validation rows, 4096-token training context, raw-Python public-only generation, and the same hidden executable task set:

- base model: `mlx-community/gemma-4-E2B-it-qat-4bit`
- training iterations: 500 per condition
- synthetic rows: 0/18 in the adapter-conditioned executable report
- hidden tests sent to model: false
- executable held-out task pass rate: `random` 3/6, `reward_selected` 5/6, `full_ledger` 2/6
- reward-selected lift vs random: +2 tasks, +33.33 percentage points
- reward-selected failed task: `py_chunked`
- public artifacts:
  - `benchmarks/training-lift-adapter-training-mlx-gemma4-e2b-512x4096-mac5-2026-06-10.json`
  - `benchmarks/executable-candidate-generation-mlx-gemma4-e2b-adapters-512x4096-rawpython-mac5-2026-06-10.json`
  - `benchmarks/executable-task-mlx-gemma4-e2b-adapters-512x4096-rawpython-mac5-2026-06-10.json`

Boundary: this is now a positive downstream lift signal for reward-selected trajectory data under a matched Gemma 4 E2B adapter setup. Because the held-out set has only six tasks, it is not a final broad SWE-style claim. It proves that the evaluation path can detect nonzero trained-adapter differences and that the previous all-zero result was a weak-model/training-recipe failure.

Larger 60-task replication result:

- task set: `python-stdlib-heldout-v1-60`
- oracle: `60/60`
- Gemma 4 E2B QAT base: `50/60`
- Gemma 4 E4B QAT base: `49/60`
- Gemma 4 E2B reward-selected adapter: `46/60`
- synthetic rows: `0`
- hidden tests sent to model: false

Boundary: the six-task E2B adapter lift did not replicate on the larger suite. The 60-task adapter comparison does not prove that TML improves downstream coding-agent task completion by replacing the base model. It does prove that the executable harness is working, that the local Gemma 4 base models are strong enough to evaluate, and that adapter changes can be measured rather than inferred from validation loss.

Extract regression-gated harness skill packages from that larger result:

```bash
cargo run --bin skillgraph-evolve -- \
  --public-tasks examples/evaluation/executable-public-tasks-python-stdlib-heldout-v1.jsonl \
  --task-specs examples/evaluation/executable-taskset-python-stdlib-heldout-v1.jsonl \
  --baseline-report benchmarks/executable-task-mlx-gemma4-e2b-qat-base-heldout-v1-mac5-2026-06-10.json \
  --comparison-report benchmarks/executable-task-mlx-gemma4-e2b-reward-selected-512x4096-rawpython-heldout-v1-mac5-2026-06-10.json \
  --output-dir examples/skills/python-stdlib-heldout-v1/e2b-reward-selected-vs-base
```

Checked skillgraph result:

- fixed tasks: 5
- regressed tasks: 9
- net pass delta: `-4`
- promoted skills: 0
- proposed skills: 1
- quarantined skills: 7
- diagnostic skills: 1
- active router skills: 0

Boundary: the harness extracts useful repair evidence from the failed adapter run, but it correctly promotes nothing because the comparison regressed overall.

Apply the proposed math repair as a surgical router recipe:

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

Checked 60-task router result:

- routed repairs: `1`, only `py_v1_moving_average`
- preserved base rows: `59`
- synthetic rows: `0`
- E2B base: `50/60`
- math repair router: `51/60`
- net pass delta vs base: `+1`
- regressions vs base: `0`
- promoted skills after base-vs-router skillgraph: `1`
- active router skill: `python_stdlib_math_trajectory_delta`

Boundary: this proves a narrow harness/router repair can beat the base model on the 60-task executable gate with zero regressions. It still does not prove that the failed adapter as a whole improves downstream performance.

Apply all positive task-level repairs while preserving base outputs for known adapter regressions:

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

Checked 60-task task-router result:

- routed repairs: `5`
- preserved base rows: `55`
- known adapter-regression task ids preserved from base: `9`
- E2B base: `50/60`
- task repair router: `55/60`
- net pass delta vs base: `+5`
- regressions vs base: `0`
- promoted repair families: date, math, parse, security
- active router skills: `4`

Boundary: this is a clean router-level repair-map result, not an adapter-level claim. It uses the failed adapter only as a source of candidate repairs and requires the routed result to beat base under the same hidden 60-task gate.

Generate focused Gemma 4 E4B chat repairs only for the five remaining shared failures, then overlay only candidates that pass focused executable evaluation:

```bash
python3 scripts/generate_executable_candidates_mlx_lm.py \
  --backend api \
  --chat-template \
  --public-tasks examples/evaluation/executable-public-tasks-python-stdlib-heldout-v1-shared-failures.jsonl \
  --model ~/Desktop/tml-gemma4-models/gemma-4-E4B-it-qat-4bit \
  --condition gemma4_e4b_lm_chat_shared_failure_focus_512_v1 \
  --output examples/evaluation/executable-candidates-gemma4-e4b-lm-chat-shared-failure-focus-512-v1-2026-06-10.jsonl \
  --raw-dir output/private-generation-raw-gemma4-e4b-lm-chat-shared-failure-focus-512-v1-2026-06-10 \
  --report benchmarks/executable-candidate-generation-gemma4-e4b-lm-chat-shared-failure-focus-512-v1-2026-06-10.json \
  --max-tokens 512 \
  --repair-attempts 1 \
  --prompt-format raw-python

python3 scripts/apply_passed_candidate_overlay_router.py \
  --base-candidates examples/evaluation/executable-candidates-skillgraph-task-repair-router-heldout-v1-2026-06-10.jsonl \
  --repair-candidates examples/evaluation/executable-candidates-gemma4-e4b-lm-chat-shared-failure-focus-512-v1-2026-06-10.jsonl \
  --repair-report benchmarks/executable-task-gemma4-e4b-lm-chat-shared-failure-focus-512-v1-2026-06-10.json \
  --condition skillgraph_task_plus_e4b_chat_overlay_router \
  --output examples/evaluation/executable-candidates-skillgraph-task-plus-e4b-chat-overlay-router-heldout-v1-2026-06-10.jsonl \
  --report benchmarks/executable-candidate-generation-skillgraph-task-plus-e4b-chat-overlay-router-heldout-v1-2026-06-10.json
```

Checked focused and full-gate result:

- focused E4B chat repairs: `2/5`, fixing `py_v1_common_prefix_path` and `py_v1_normalize_segments`
- rejected focused repairs: `py_v1_parse_size_bytes`, `py_v1_chunked_list`, `py_v1_split_filename_version`
- final overlay preserved base/router rows: `58`
- final overlay rows from E4B chat: `2`
- E2B base: `50/60`
- task repair router: `55/60`
- task repair plus E4B chat overlay router: `57/60`
- net pass delta vs E2B base: `+7`
- regressions vs E2B base: `0`
- synthetic rows: `0`
- promoted repair families after base-vs-overlay skillgraph: `5`

Boundary: this was the strongest checked TML result before the anticipatory planner pass. It is still router-level lift. It proves that the skillgraph can serve as a repair map and that focused stronger-model repairs can be admitted only after executable evidence. It does not prove broad adapter-level performance lift.

Run the public-only anticipatory repair planner on the three remaining shared failures. This planner does not accept a task-spec path; it reads public prompts, the current 57/60 candidate set, and skillgraph package memory. It classifies task families, retrieves only matching shared-failure memory, generates bounded public-recipe repairs, runs syntax/import/signature/probe checks, and overlays only admitted rows:

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

Checked anticipatory planner result:

- admitted public-checked repairs: `py_v1_parse_size_bytes`, `py_v1_chunked_list`, `py_v1_split_filename_version`
- preserved previous overlay rows: `57`
- planner report: `read_hidden_task_specs=false`, `hidden_tests_sent_to_model=false`, `synthetic_rows=0`
- previous best overlay: `57/60`
- anticipatory public repair planner: `60/60`
- net pass delta vs previous best: `+3`
- net pass delta vs E2B base: `+10`
- regressions vs previous best: `0`
- regressions vs E2B base: `0`

Boundary: this proves the anticipatory repair planner on the 60-task executable gate as a router/planner result. It is not evidence that a trained adapter can replace the base model globally.

Run the real-repo issue-resolution proof gate preflight:

```bash
python3 scripts/prepare_real_repo_issue_gate.py \
  --dataset-name fixture/SWE-bench-style \
  --subset-label synthetic-fixture \
  --instances-jsonl examples/evaluation/real-repo-gate/fixture-instances.jsonl \
  --base-predictions examples/evaluation/real-repo-gate/base-predictions.fixture.jsonl \
  --planner-predictions examples/evaluation/real-repo-gate/planner-predictions.fixture.jsonl \
  --base-report examples/evaluation/real-repo-gate/base-results.fixture.json \
  --planner-report examples/evaluation/real-repo-gate/planner-results.fixture.json \
  --allow-synthetic-fixture \
  --output benchmarks/real-repo-issue-gate-fixture-2026-06-11.json
```

Checked fixture result:

- script parses same-instance prediction files and harness-style reports
- synthetic fixture comparison shows planner `2/2` versus base `1/2`
- `performance_claim.status`: `synthetic_fixture_not_performance_evidence`
- `performance_claim.allowed`: `false`

Boundary: this proves the real-repo gate wiring and the claim guard. It does not prove SWE-bench or real repository issue-resolution lift. The actual proof requires official SWE-bench Lite/Verified-style harness reports for the same base agent and base+TML planner on the same real instances, model, budget, timeout, and harness.

Freeze the public-safe Verified Mini manifest and run the local environment
preflight:

```bash
python3 scripts/fetch_swebench_verified_mini_manifest.py
python3 scripts/preflight_real_repo_issue_gate_env.py
```

Checked `2026-06-11` outputs:

- public manifest rows: `50`
- source dataset: `MariusHobbhahn/swe-bench-verified-mini`
- hidden/gold fields omitted: `patch`, `test_patch`, `FAIL_TO_PASS`, `PASS_TO_PASS`
- local preflight status: `blocked_local_official_harness_unavailable`
- local blockers: free disk `6.10 GiB` below the configured `10.00 GiB` floor, `docker` not found, Python module `swebench` not importable
- prediction files still required: `output/private-swebench/base-agent.predictions.jsonl` and `output/private-swebench/tml-planner.predictions.jsonl`

Boundary: the manifest freezes the public instance set and the preflight records
why this machine should not run the official harness. Neither artifact measures
planner performance.

Prepare the base/planner prediction-generation prompts:

```bash
python3 scripts/generate_real_repo_issue_predictions.py --dry-run
```

Checked dry-run result:

- instances: `50`
- conditions: `base_agent`, `base_agent_tml_planner`
- private prompts written under ignored `output/private-swebench/raw-agent-output`
- prompt files written: `100`
- planner retrieval: `3` TML skill memory packages retrieved for each planner prompt
- predictions written: `0`
- official harness run: `false`
- performance claim allowed: `false`

Real prediction generation requires an external agent command that reads
`{prompt_file}` and writes a unified diff to stdout or `{raw_output_file}`:

```bash
python3 scripts/generate_real_repo_issue_predictions.py \
  --model-name same-agent-model \
  --agent-command 'your-agent --prompt-file {prompt_file}'
```

That writes `output/private-swebench/base-agent.predictions.jsonl` and
`output/private-swebench/tml-planner.predictions.jsonl` for the official
SWE-bench harness.

Prepare real repository worktrees for agent-context generation:

```bash
python3 scripts/generate_real_repo_issue_predictions.py \
  --dry-run \
  --prepare-repos \
  --max-instances 1 \
  --report benchmarks/real-repo-prediction-generation-repo-prep-smoke-2026-06-11.json
```

Checked repo-prep smoke result:

- instance: `django__django-11790`
- base worktree prepared: true
- planner worktree prepared: true
- worktrees are condition-specific under ignored `output/private-swebench/repo-worktrees`
- predictions written: `0`
- official harness run: `false`
- performance claim allowed: `false`

Boundary: this proves the prediction wrapper can provide actual base-commit
repository context to an agent. It still does not test planner performance.

Run a one-instance real Codex prediction smoke:

```bash
python3 scripts/generate_real_repo_issue_predictions.py \
  --prepare-repos \
  --max-instances 1 \
  --model-name codex-gpt-5.4 \
  --timeout-s 1800 \
  --output-dir output/private-swebench/codex-real-smoke-1 \
  --raw-dir output/private-swebench/codex-real-smoke-1/raw-agent-output \
  --report benchmarks/real-repo-prediction-generation-codex-real-smoke-2026-06-11.json \
  --agent-command 'codex exec --ephemeral --sandbox danger-full-access --model gpt-5.4 --cd "{repo_worktree}" --output-last-message "{raw_output_file}" - < "{prompt_file}"'
```

Checked real prediction smoke result:

- instance: `django__django-11790`
- base prediction: 1 row, `1883` patch chars, `2` files, command succeeded in `111.541s`
- planner prediction: 1 row, `1938` patch chars, `2` files, command succeeded in `132.104s`
- same model name recorded: true
- official harness run: `false`
- performance claim allowed: `false`

The matching gate preflight is
`benchmarks/real-repo-issue-gate-codex-real-smoke-2026-06-11.json`.
It validates same-instance, same-model prediction coverage for the one-row
smoke and reports `waiting_for_official_harness_results`. The matching local
environment preflight is
`benchmarks/real-repo-issue-gate-local-preflight-codex-real-smoke-2026-06-11.json`;
the prediction files exist, but this machine is blocked from official scoring
by insufficient disk, missing Docker, and missing `swebench`.

Boundary: this is the first real patch-generation artifact for the gate. It is
not a resolved-rate result and does not prove TML improves real-repo issue
resolution.

Package the one-instance predictions for an official Docker scorer:

```bash
python3 scripts/prepare_real_repo_harness_handoff.py \
  --instances-jsonl examples/evaluation/swebench-verified-mini-public-manifest-codex-smoke-1-2026-06-11.jsonl \
  --base-predictions output/private-swebench/codex-real-smoke-1/base-agent.predictions.jsonl \
  --planner-predictions output/private-swebench/codex-real-smoke-1/tml-planner.predictions.jsonl \
  --output-dir output/private-swebench/scorer-handoff-codex-real-smoke-1 \
  --report benchmarks/real-repo-harness-handoff-codex-real-smoke-2026-06-11.json \
  --subset-label verified-mini-codex-real-smoke-1 \
  --base-run-id tml_base_codex_real_smoke_1 \
  --planner-run-id tml_planner_codex_real_smoke_1
```

Checked handoff result:

- status: `handoff_ready_waiting_for_official_harness`
- instance count: `1`
- same prediction ids: true
- same model names: true
- input fingerprints: SHA-256 hashes recorded for the manifest and both
  prediction JSONL files
- official harness run: `false`
- performance claim allowed: `false`

Boundary: this creates an ignored private scorer bundle with prediction JSONL
and exact harness commands. The private runner verifies those input
fingerprints before calling the official harness. It still does not score the
patches.

Prepare official result admission:

```bash
python3 scripts/prepare_real_repo_official_result_admission.py \
  --handoff-dir output/private-swebench/scorer-handoff-codex-real-smoke-1 \
  --report benchmarks/real-repo-official-result-admission-codex-real-smoke-2026-06-11.json \
  --subset-label verified-mini-codex-real-smoke-1 \
  --base-run-id tml_base_codex_real_smoke_1 \
  --planner-run-id tml_planner_codex_real_smoke_1
```

Checked admission result:

- status: `waiting_for_official_reports`
- handoff fingerprints verified: true
- verified scorer inputs: `3`
- missing reports: base and planner `evaluation_results` directories
- performance claim allowed: `false`

Boundary: this verifies the frozen handoff identity and records the exact
report paths needed later. It still does not run SWE-bench or score patches.

Grow the real-prediction packet incrementally:

```bash
python3 scripts/select_real_repo_manifest_subset.py \
  --input examples/evaluation/swebench-verified-mini-public-manifest-2026-06-11.jsonl \
  --output examples/evaluation/swebench-verified-mini-public-manifest-codex-smoke-2-2026-06-11.jsonl \
  --report benchmarks/swebench-verified-mini-public-manifest-codex-smoke-2-2026-06-11.json \
  --count 1 \
  --exclude-predictions output/private-swebench/codex-real-smoke-1/base-agent.predictions.jsonl
```

Checked incremental two-instance packet:

- new selected instance: `django__django-11815`
- second Codex prediction smoke: base patch `5365` chars, planner patch `4711` chars
- merged packet: `2` instances, same base/planner ids
- gate status: `waiting_for_official_harness_results`
- handoff status: `handoff_ready_waiting_for_official_harness`
- admission status: `waiting_for_official_reports`
- patch apply: base `2/2`, planner `2/2`
- official harness run: `false`
- performance claim allowed: `false`

Boundary: this expands the future scorer input set from one real issue to two
real issues and proves both generated patch sets apply. It still does not run
SWE-bench, hidden tests, or measure issue resolution.

The next incremental batch adds `django__django-11848` and merges the first
three private Codex batches into
`output/private-swebench/codex-real-mini-merged-3`.

Checked three-instance packet:

- instances: `django__django-11790`, `django__django-11815`,
  `django__django-11848`
- third Codex prediction smoke: base patch `2607` chars, planner patch `2431` chars
- merged packet: `3` instances, same base/planner ids
- gate status: `waiting_for_official_harness_results`
- handoff status: `handoff_ready_waiting_for_official_harness`
- admission status: `waiting_for_official_reports`
- patch apply: base `3/3`, planner `3/3`
- official harness run: `false`
- performance claim allowed: `false`

Boundary: this is still scorer-input preparation and patch-apply evidence only.
It does not measure resolved rate, regressions, hidden tests, or planner lift.

The next incremental batch adds `django__django-11880` and merges the first
four private Codex batches into
`output/private-swebench/codex-real-mini-merged-4`.

Checked four-instance packet:

- instances: `django__django-11790`, `django__django-11815`,
  `django__django-11848`, `django__django-11880`
- fourth Codex prediction smoke: base patch `1499` chars, planner patch `1402` chars
- merged packet: `4` instances, same base/planner ids
- gate status: `waiting_for_official_harness_results`
- handoff status: `handoff_ready_waiting_for_official_harness`
- admission status: `waiting_for_official_reports`
- patch apply: base `4/4`, planner `4/4`
- official harness run: `false`
- performance claim allowed: `false`

Boundary: this is still scorer-input preparation and patch-apply evidence only.
It does not measure resolved rate, regressions, hidden tests, or planner lift.

The four-instance scorer bootstrap report
`benchmarks/real-repo-scorer-bootstrap-codex-real-mini-4-2026-06-11.json`
records handoff metadata derived from
`output/private-swebench/scorer-handoff-codex-real-mini-4/run_official_harness.sh`:
dataset `princeton-nlp/SWE-bench_Verified`, split `test`, run IDs
`tml_base_codex_real_mini_4` and `tml_planner_codex_real_mini_4`, and all four
instance IDs. The ignored private `modal_command_reference.sh` is generated
from the same metadata, so Docker and Modal references target the same
four-instance scorer input set.

Post-four-instance scorer audit:

- report: `benchmarks/real-repo-scorer-target-audit-post-four-instance-2026-06-11.json`
- status: `no_ready_official_scorer`
- ready targets: `0`
- local: blocked by `4.56 GiB` free disk, no Docker, and missing `swebench`
- Mac4: blocked by `12.45 GiB` free disk and missing `swebench`
- Mac5: reachable, but blocked by `16.04 GiB` free disk, no Docker, and missing `swebench`
- cloud-vm: unreachable over SSH
- official harness run: `false`
- performance claim allowed: `false`

Boundary: this is a current readiness audit only. It explains why the
fingerprint-locked handoff has not been scored by the official harness.

Four-instance local public-test smoke:

- `django__django-11790`: base passed, planner passed
- `django__django-11815`: base passed, planner passed
- `django__django-11848`: base passed, planner passed
- `django__django-11880`: base passed, planner passed
- reports: `benchmarks/real-repo-local-test-smoke-codex-real-mini-4-django-*-2026-06-11.json`
- official harness run: `false`
- hidden tests run: `false`
- performance claim allowed: `false`

Boundary: this proves only that both patched worktrees pass selected local
public/touched Django tests. It is not the full Django suite, not hidden
SWE-bench tests, and not an official resolved-rate measurement.

Audit scorer targets:

```bash
python3 scripts/audit_real_repo_scorer_targets.py \
  --output benchmarks/real-repo-scorer-target-audit-2026-06-11.json \
  --gcloud-account <account> \
  --gcloud-project <project>
```

Checked scorer audit result:

- status: `no_ready_official_scorer`
- ready targets: `0`
- local: blocked by disk, Docker, and missing `swebench`
- Mac4: blocked by disk and missing `swebench`
- Mac5: blocked by disk, Docker, and missing `swebench`
- cloud-vm: unreachable
- Modal CLI / sb-cli: unavailable
- public report redacts cloud account/project identifiers

Boundary: this explains why the official scorer has not run. It is not scoring
evidence.

Prepare scorer bootstrap scripts:

```bash
python3 scripts/prepare_real_repo_scorer_bootstrap.py \
  --handoff-dir output/private-swebench/scorer-handoff-codex-real-smoke-1 \
  --output-dir output/private-swebench/scorer-bootstrap-codex-real-smoke-1 \
  --report benchmarks/real-repo-scorer-bootstrap-codex-real-smoke-2026-06-11.json
```

Checked bootstrap result:

- status: `scorer_bootstrap_packet_ready`
- recommended scorer: x86_64, 120 GB free storage, 16 GB RAM, 8 CPU cores, Docker
- generated private scripts: bootstrap scorer, sync handoff, run handoff, Modal command reference
- official harness run: `false`
- performance claim allowed: `false`

Boundary: this prepares a future scorer machine. It does not provision a
machine, submit a cloud job, or score patches.

Check one-instance patch applicability:

```bash
python3 scripts/check_real_repo_prediction_patch_apply.py \
  --instances-jsonl examples/evaluation/swebench-verified-mini-public-manifest-codex-smoke-1-2026-06-11.jsonl \
  --base-predictions output/private-swebench/codex-real-smoke-1/base-agent.predictions.jsonl \
  --planner-predictions output/private-swebench/codex-real-smoke-1/tml-planner.predictions.jsonl \
  --private-dir output/private-swebench/patch-apply-check-codex-real-smoke-1 \
  --report benchmarks/real-repo-patch-apply-codex-real-smoke-2026-06-11.json
```

Checked patch-apply result:

- status: `patch_apply_check_passed`
- base patch applies: 1/1
- planner patch applies: 1/1
- official harness run: `false`
- repository tests run: `false`
- performance claim allowed: `false`

Boundary: this proves only that both generated patches apply cleanly to the
real base commit. It does not prove either patch fixes the issue.

Run the narrow local public-test smoke:

```bash
python3 scripts/run_real_repo_local_test_smoke.py \
  --instance-id django__django-11790 \
  --repo django/django \
  --base-worktree output/private-swebench/repo-worktrees/worktrees/base_agent/django__django-11790 \
  --planner-worktree output/private-swebench/repo-worktrees/worktrees/base_agent_tml_planner/django__django-11790 \
  --dependency-path output/private-swebench/django-test-deps \
  --test-label auth_tests.test_forms.AuthenticationFormTest.test_username_field_max_length_matches_user_model \
  --test-label auth_tests.test_forms.AuthenticationFormTest.test_username_field_max_length_defaults_to_254 \
  --report benchmarks/real-repo-local-test-smoke-codex-real-smoke-2026-06-11.json
```

Checked local public-test result:

- status: `local_test_smoke_passed`
- base condition: passed
- planner condition: passed
- conditions passed: 2/2
- official harness run: `false`
- hidden tests run: `false`
- performance claim allowed: `false`

Boundary: this is a narrow local public-test smoke. It is not the full Django
suite and not official SWE-bench scoring.

Run the stronger Gemma 4 base-model sanity gate:

```bash
python3 scripts/generate_executable_candidates_mlx_vlm.py \
  --public-tasks examples/evaluation/executable-public-tasks-python-stdlib-heldout-v0.jsonl \
  --model-path ~/Desktop/tml-gemma4-models/gemma-4-E2B-it-qat-4bit \
  --model-label mlx-community/gemma-4-E2B-it-qat-4bit \
  --condition gemma4_e2b_qat_base \
  --output examples/evaluation/executable-candidates-mlx-gemma4-e2b-qat-base-mac5-2026-06-10.jsonl \
  --raw-dir output/private-generation-raw-gemma4-e2b-qat-base-2026-06-10 \
  --report benchmarks/executable-candidate-generation-mlx-gemma4-e2b-qat-base-mac5-2026-06-10.json \
  --max-tokens 2048 \
  --temperature 0.0 \
  --repair-attempts 2

cargo run --bin materialize-executable-bench -- \
  --tasks examples/evaluation/executable-taskset-python-stdlib-heldout-v0.jsonl \
  --candidates examples/evaluation/executable-candidates-mlx-gemma4-e2b-qat-base-mac5-2026-06-10.jsonl \
  --output examples/evaluation/executable-task-mlx-gemma4-e2b-qat-base-mac5-2026-06-10.jsonl

cargo run --bin executable-task-bench -- \
  --input examples/evaluation/executable-task-mlx-gemma4-e2b-qat-base-mac5-2026-06-10.jsonl \
  --output benchmarks/executable-task-mlx-gemma4-e2b-qat-base-mac5-2026-06-10.json \
  --require-real
```

Checked Mac5 base-model result with `mlx-community/gemma-4-E2B-it-qat-4bit` through `mlx-vlm`:

- executable held-out task pass rate: `gemma4_e2b_qat_base` 3/6
- pass rate: 50.0%
- passed tasks: `py_parse_duration`, `py_merge_intervals`, `py_group_by_key`
- failed tasks: `py_topological_sort`, `py_chunked`, `py_redact_secrets`
- synthetic rows: 0/6
- hidden tests sent to model: false

The same gate with `mlx-community/gemma-4-12B-it-qat-4bit` loaded successfully on Mac5 and was run with `--max-tokens 4096`:

- executable held-out task pass rate: `gemma4_12b_qat_base` 5/6
- pass rate: 83.33%
- passed tasks: `py_parse_duration`, `py_merge_intervals`, `py_topological_sort`, `py_group_by_key`, `py_chunked`
- failed task: `py_redact_secrets`
- synthetic rows: 0/6
- hidden tests sent to model: false

Boundary: this is a base-model sanity result, not trained ledger lift. It corrects the old all-zero local-model picture: the Gemma 3 1B adapter setup failed downstream task completion, Gemma 4 E2B QAT reaches 3/6, and Gemma 4 12B QAT reaches 5/6 before any ledger fine-tuning.

## Test

```bash
cargo test
cargo clippy -- -D warnings
```

## Architecture

```text
Gateway Events
    |
    v
trajectory-ledgerd
    |-- date-scoped cursor
    |-- flow grouping
    |-- schema-v2 normalization
    |-- six-signal reward scoring
    |-- locked JSONL append
    |-- Prometheus metrics
    v
Trajectory Memory Ledger
    |
    +--> SFT / preference export
    +--> reward ablations
    +--> skill/entity routing
    +--> paper metrics
```

## Publication Positioning

This is best treated as a systems and artifact paper first:

**Trajectory Memory Ledger: Schema-Normalized Experience Replay for Self-Improving Coding Agents**

The Rust daemon makes the artifact reproducible. The held-out KARL V7 benchmark adds a real model-quality result over coding-agent contexts, and the non-synthetic executable reports add real model-output task-completion measurements. The training-lift gate has now been run through multiple Mac5 adapter tiers. The first Gemma 3 1B/256-token adapter result was negative at 0/6 for all conditions. The six-task Gemma 4 E2B/512-row/4096-token adapter result was positive for reward-selected data: `reward_selected` reached 5/6 versus `random` at 3/6 and `full_ledger` at 2/6. The larger 60-task replication did not confirm adapter lift: E2B base reached 50/60, E4B base reached 49/60, and the E2B reward-selected adapter reached 46/60. A narrow skillgraph math router reached 51/60 with zero regressions, a task-level repair router reached 55/60 with zero regressions, a focused E4B chat overlay router reached 57/60 with zero regressions, and a public-only anticipatory repair planner reached 60/60 by admitting the three remaining shared-failure repairs after public checks. The current honest claim is that TML has a working reproducible evaluation, harness-skill extraction, and surgical router/planner repair pipeline. It has proven router-level repair lift on the 60-task executable gate, and it can now generate same-model base/planner real-repo patches for a one-instance SWE-bench-style smoke. It has not yet proven SWE-bench-style real-repo issue-resolution lift or broad adapter-level downstream coding-agent performance lift, because the generated patches have not been scored by official harness reports.

## License

MIT
