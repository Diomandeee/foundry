# Skill-to-LoRA Preflight

This repo now has a local Skill-to-LoRA preflight for converting evidence-bound harness skill packages into trainable behavior-adapter artifacts.

The implementation is intentionally conservative. It prepares datasets, teacher prompts, adapter metadata, MLX training commands, and evaluation prompts. It does not train adapters, remove `SKILL.md` from routing, or claim that a skill adapter works until a later executable evaluation admits that adapter.

## Source Idea

The paper-level pattern is:

1. Use complete `SKILL.md` instructions offline to generate skill-guided demonstrations.
2. Train a skill-specific LoRA adapter from those demonstrations.
3. At inference time, omit the long skill text and load the relevant adapter dynamically.
4. Compare against no-skill, full-skill-text, wrong-adapter, and shared-adapter controls.

The local TML version maps that onto existing harness packages:

```text
promoted SkillDAG package
-> deterministic seed examples
-> teacher-generation prompts
-> per-skill MLX training command
-> adapter registry
-> executable eval prompts
-> only then adapter routing
```

## Entrypoint

Use `scripts/prepare_skill_to_lora_experiment.py`.

```bash
python3 scripts/prepare_skill_to_lora_experiment.py \
  --skill-run-dir examples/skills/python-stdlib-heldout-v1/anticipatory-public-repair-planner-vs-base \
  --status promoted \
  --output-dir output/private-skill-to-lora-2026-06-23 \
  --report benchmarks/skill-to-lora-preflight-2026-06-23.json \
  --adapter-root output/private-skill-lora-adapters-2026-06-23
```

The default base model is `mlx-community/gemma-4-e2b-4bit`. Override it with `--base-model` when the actual local adapter lane changes.

## Inputs

Each selected package must contain the normal harness skill files:

- `skill.json`
- `SKILL.md`
- `MEMORY.md`
- `tests.jsonl`
- `failure_modes.json`

The script defaults to `--status promoted` because proposed and quarantined skills are not safe adapter-training targets without an explicit experiment.

## Outputs

Private training artifacts are written under ignored `output/private-*` paths:

- `skills/<skill_id>/data/train.jsonl`
- `skills/<skill_id>/data/valid.jsonl`
- `skills/<skill_id>/data/test.jsonl`
- `skills/<skill_id>/skill_context.md`
- `skills/<skill_id>/eval_prompts.jsonl`
- `teacher_prompts/<skill_id>.task_inputs.md`
- `teacher_prompts/<skill_id>.labels.md`
- `commands/train_<skill_id>.sh`
- `adapter_registry.json`
- `eval_prompts.jsonl`

The public-safe report is written to `benchmarks/skill-to-lora-preflight-2026-06-23.json`.

## Current Preflight

The first checked preflight uses the strongest router/planner package set:

`examples/skills/python-stdlib-heldout-v1/anticipatory-public-repair-planner-vs-base`

It prepared six promoted skills:

| Skill | Family | Seed Rows | Readiness |
|---|---|---:|---|
| `python_stdlib_collection_trajectory_delta` | collection | 5 | `needs_teacher_generation` |
| `python_stdlib_date_trajectory_delta` | date | 5 | `needs_teacher_generation` |
| `python_stdlib_math_trajectory_delta` | math | 5 | `needs_teacher_generation` |
| `python_stdlib_parse_trajectory_delta` | parse | 5 | `needs_teacher_generation` |
| `python_stdlib_path_trajectory_delta` | path | 5 | `needs_teacher_generation` |
| `python_stdlib_security_trajectory_delta` | security | 5 | `needs_teacher_generation` |

Aggregate output:

| Metric | Value |
|---|---:|
| Skills prepared | 6 |
| Seed examples | 30 |
| Teacher prompt files | 12 |
| Eval prompt rows | 150 |

Every skill remains `needs_teacher_generation` because the deterministic evidence rows are useful seeds, not a sufficient SFT corpus.

## Training Command Shape

Each generated command uses MLX-LM LoRA with prompt masking and the local OpenMP workaround:

```bash
export KMP_DUPLICATE_LIB_OK="${KMP_DUPLICATE_LIB_OK:-TRUE}"
python3 -m mlx_lm lora \
  --model "mlx-community/gemma-4-e2b-4bit" \
  --train \
  --data "output/private-skill-to-lora-2026-06-23/skills/<skill_id>/data" \
  --fine-tune-type lora \
  --mask-prompt \
  --num-layers 8 \
  --batch-size 2 \
  --iters 600 \
  --learning-rate 1e-5 \
  --max-seq-length 4096 \
  --save-every 200 \
  --adapter-path "output/private-skill-lora-adapters-2026-06-23/<skill_id>" \
  --seed 42 \
  --grad-checkpoint
```

Do not run these commands as final training until the teacher prompt outputs have been generated and substituted into the per-skill train/valid/test splits.

## Evaluation Gate

The generated eval prompts include five conditions per evidence task:

- `no_skill`
- `full_skill_text`
- `skill_lora`
- `wrong_lora_control`
- `shared_lora_control`

An adapter may be routed only after it beats or matches the full-skill-text and no-skill controls without regressions on executable checks. A trained adapter with lower validation loss but worse executable behavior is a negative result, not a promotion.

## Claim Boundary

This layer is a bridge from harness-side skill evidence to behavior-adapter experiments. It does not replace the current public-check repair planner. Until adapter evaluation is admitted, the honest production path remains:

```text
SkillDAG package -> planner/router -> public checks -> executable admission
```

The Skill-to-LoRA lane becomes relevant only after the teacher-generation and adapter-evaluation gates produce evidence that the same behavior can be carried by an adapter instead of full `SKILL.md` context.
