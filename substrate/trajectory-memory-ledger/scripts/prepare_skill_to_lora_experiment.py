#!/usr/bin/env python3
"""
Prepare Skill-to-LoRA artifacts from evidence-bound harness skill packages.

This script implements the local S2L preflight layer:

1. Read package-level SKILL.md/MEMORY.md/tests.jsonl/skill.json.
2. Build deterministic seed SFT examples that omit full SKILL.md from the
   student input.
3. Write teacher-generation prompts for scaling the dataset offline.
4. Write adapter registry metadata, MLX training command templates, and
   evaluation prompts for no-skill/full-skill/skill-LoRA/control comparisons.

It does not call an LLM, train an adapter, or claim downstream lift.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import stat
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


DEFAULT_SKILL_RUN = Path("examples/skills/python-stdlib-heldout-v1/anticipatory-public-repair-planner-vs-base")
DEFAULT_OUTPUT = Path("output/private-skill-to-lora-2026-06-23")
DEFAULT_REPORT = Path("benchmarks/skill-to-lora-preflight-2026-06-23.json")
DEFAULT_ADAPTER_ROOT = Path("output/private-skill-lora-adapters-2026-06-23")


@dataclass(frozen=True)
class SkillPackage:
    package_dir: Path
    skill_id: str
    status: str
    family: str
    skill: dict[str, Any]
    skill_md: str
    memory_md: str
    failure_modes: dict[str, Any]
    tests: list[dict[str, Any]]


def main() -> int:
    args = parse_args()
    packages = discover_packages(args)
    if not packages:
        raise SystemExit("no matching skill packages found")

    args.output_dir.mkdir(parents=True, exist_ok=True)
    (args.output_dir / "skills").mkdir(exist_ok=True)
    (args.output_dir / "teacher_prompts").mkdir(exist_ok=True)
    (args.output_dir / "commands").mkdir(exist_ok=True)

    registry: dict[str, Any] = {
        "schema": "trajectory-memory-ledger.skill_to_lora_adapter_registry.v1",
        "created_at": utc_now(),
        "base_model": args.base_model,
        "adapter_root": str(args.adapter_root),
        "skills": [],
        "claim_boundary": "Adapter metadata only. No adapter is trained until the command for that skill completes and evaluation reports are admitted.",
    }
    reports: list[dict[str, Any]] = []
    eval_rows: list[dict[str, Any]] = []

    for package in packages:
        skill_report, skill_eval_rows = prepare_skill(args, package)
        reports.append(skill_report)
        eval_rows.extend(skill_eval_rows)
        registry["skills"].append(skill_report["adapter_registry_entry"])

    write_json(args.output_dir / "adapter_registry.json", registry)
    write_jsonl(args.output_dir / "eval_prompts.jsonl", eval_rows)

    report = {
        "schema": "trajectory-memory-ledger.skill_to_lora_preflight.v1",
        "created_at": utc_now(),
        "paper_reference": {
            "title": "Skill-to-LoRA: From Using Skills to Learning Behaviors for Token-Efficient LLM Agents",
            "arxiv": "2606.16769",
            "local_interpretation": "convert promoted evidence-bound SKILL.md packages into trainable behavior adapters",
        },
        "skill_run_dir": str(args.skill_run_dir),
        "output_dir": str(args.output_dir),
        "adapter_root": str(args.adapter_root),
        "base_model": args.base_model,
        "selected_statuses": args.status,
        "skills_prepared": len(reports),
        "seed_examples_total": sum(item["seed_examples"] for item in reports),
        "teacher_prompt_files": sum(len(item["teacher_prompt_files"]) for item in reports),
        "eval_prompt_rows": len(eval_rows),
        "skills": reports,
        "next_steps": [
            "Use teacher_prompts/* to generate enough behavioral demonstrations per skill.",
            "Replace or augment each skill train/valid/test JSONL with teacher-labeled examples.",
            "Train one adapter per skill with commands/train_<skill_id>.sh.",
            "Evaluate no_skill, full_skill_text, skill_lora, wrong_lora, and shared_lora controls before any routing claim.",
        ],
        "claim_boundary": (
            "This preflight prepares data and commands only. It does not train LoRA adapters, "
            "does not prove full SKILL.md can be removed, and does not authorize routing a skill "
            "adapter until executable evaluation beats the full-skill or baseline control without regressions."
        ),
    }
    write_json(args.report, report)
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skill-run-dir", type=Path, default=DEFAULT_SKILL_RUN)
    parser.add_argument("--package-dir", action="append", type=Path, default=[])
    parser.add_argument("--status", nargs="+", default=["promoted"])
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--adapter-root", type=Path, default=DEFAULT_ADAPTER_ROOT)
    parser.add_argument("--base-model", default="mlx-community/gemma-4-e2b-4bit")
    parser.add_argument("--min-ready-examples", type=int, default=32)
    parser.add_argument("--max-evidence-rows", type=int, default=12)
    parser.add_argument("--valid-ratio", type=float, default=0.15)
    parser.add_argument("--test-ratio", type=float, default=0.15)
    parser.add_argument("--teacher-examples-per-skill", type=int, default=80)
    parser.add_argument("--train-iters", type=int, default=600)
    parser.add_argument("--train-batch-size", type=int, default=2)
    parser.add_argument("--train-num-layers", type=int, default=8)
    parser.add_argument("--train-max-seq-length", type=int, default=4096)
    parser.add_argument("--train-learning-rate", default="1e-5")
    parser.add_argument("--train-save-every", type=int, default=200)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--grad-checkpoint", action=argparse.BooleanOptionalAction, default=True)
    return parser.parse_args()


def discover_packages(args: argparse.Namespace) -> list[SkillPackage]:
    package_dirs = list(args.package_dir)
    if not package_dirs:
        package_dirs = sorted((args.skill_run_dir / "packages").glob("*"))
    allowed = {status.lower() for status in args.status}
    packages: list[SkillPackage] = []
    for package_dir in package_dirs:
        skill_json_path = package_dir / "skill.json"
        if not skill_json_path.exists():
            continue
        skill = json.loads(skill_json_path.read_text(encoding="utf-8"))
        status = str(skill.get("status") or "").lower()
        if status not in allowed:
            continue
        tests_path = package_dir / "tests.jsonl"
        tests = read_jsonl(tests_path) if tests_path.exists() else list(skill.get("evidence") or [])
        packages.append(
            SkillPackage(
                package_dir=package_dir,
                skill_id=str(skill["id"]),
                status=status,
                family=str(skill.get("family") or "unknown"),
                skill=skill,
                skill_md=read_optional(package_dir / "SKILL.md"),
                memory_md=read_optional(package_dir / "MEMORY.md"),
                failure_modes=read_optional_json(package_dir / "failure_modes.json"),
                tests=tests,
            )
        )
    return packages


def prepare_skill(args: argparse.Namespace, package: SkillPackage) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    safe_id = safe_name(package.skill_id)
    skill_dir = args.output_dir / "skills" / safe_id
    data_dir = skill_dir / "data"
    data_dir.mkdir(parents=True, exist_ok=True)

    evidence = package.tests[: args.max_evidence_rows]
    seed_examples = build_seed_examples(package, evidence)
    split = split_examples(seed_examples, args.valid_ratio, args.test_ratio)
    for name, rows in split.items():
        write_jsonl(data_dir / f"{name}.jsonl", rows)

    context_path = skill_dir / "skill_context.md"
    context_path.write_text(skill_context(package), encoding="utf-8")

    teacher_task_prompt = teacher_task_input_prompt(args, package)
    teacher_label_prompt = teacher_label_prompt_for_skill(args, package)
    teacher_task_path = args.output_dir / "teacher_prompts" / f"{safe_id}.task_inputs.md"
    teacher_label_path = args.output_dir / "teacher_prompts" / f"{safe_id}.labels.md"
    teacher_task_path.write_text(teacher_task_prompt, encoding="utf-8")
    teacher_label_path.write_text(teacher_label_prompt, encoding="utf-8")

    adapter_dir = args.adapter_root / safe_id
    command_path = args.output_dir / "commands" / f"train_{safe_id}.sh"
    command_path.write_text(train_command(args, data_dir, adapter_dir), encoding="utf-8")
    command_path.chmod(command_path.stat().st_mode | stat.S_IXUSR)

    adapter_entry = {
        "skill_id": package.skill_id,
        "status": "prepared_not_trained",
        "skill_status": package.status,
        "family": package.family,
        "adapter_path": str(adapter_dir),
        "data_dir": str(data_dir),
        "train_command": str(command_path),
        "context_sha256": sha256_file(context_path),
        "train_sha256": sha256_file(data_dir / "train.jsonl"),
        "valid_sha256": sha256_file(data_dir / "valid.jsonl"),
        "test_sha256": sha256_file(data_dir / "test.jsonl"),
        "routing_allowed": False,
        "routing_boundary": "Adapter must beat or match full_skill_text and no_skill controls with no regressions before routing.",
    }

    eval_rows = build_eval_rows(package, evidence, adapter_entry)
    write_jsonl(skill_dir / "eval_prompts.jsonl", eval_rows)

    readiness = "ready_for_adapter_training" if len(seed_examples) >= args.min_ready_examples else "needs_teacher_generation"
    return {
        "skill_id": package.skill_id,
        "status": package.status,
        "family": package.family,
        "package_dir": str(package.package_dir),
        "readiness": readiness,
        "seed_examples": len(seed_examples),
        "min_ready_examples": args.min_ready_examples,
        "split_counts": {key: len(value) for key, value in split.items()},
        "teacher_prompt_files": [str(teacher_task_path), str(teacher_label_path)],
        "data_dir": str(data_dir),
        "eval_prompts": str(skill_dir / "eval_prompts.jsonl"),
        "train_command": str(command_path),
        "adapter_registry_entry": adapter_entry,
        "evidence": {
            "repairs": len(package.skill.get("repairs_task_ids") or []),
            "regressions": len(package.skill.get("regression_task_ids") or []),
            "shared_failures": len(package.skill.get("shared_failure_task_ids") or []),
            "preserved_passes": len(package.skill.get("preserved_pass_task_ids") or []),
        },
    }, eval_rows


def build_seed_examples(package: SkillPackage, evidence: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for row in evidence:
        task_id = str(row.get("task_id") or "")
        candidate_path = str(row.get("candidate_path") or "")
        function_name = str(row.get("function_name") or "")
        relation = str(row.get("relation") or "")
        user = f"""skill_id: {package.skill_id}
task_family: {package.family}
candidate_path: {candidate_path}
function_name: {function_name}
public_task:
{row.get("public_prompt", "")}

Apply the selected skill behavior. Do not include the full SKILL.md text in the answer."""
        assistant = f"""Skill applicability: applies to `{package.family}` because the candidate path is `{candidate_path}` and the target function is `{function_name}`.

Behavior:
- Keep the implementation scoped to `{candidate_path}`.
- Use only the Python standard library.
- Preserve existing public contract details from the prompt.
- Pay attention to the known evidence relation `{relation}` for `{task_id}`.
- Prefer a direct implementation over broad rewrites.

Verification:
- Public verifier command: `{row.get("verifier_command", "python3 -m unittest discover -s tests")}`.
- Treat hidden tests as unavailable; do not invent hidden-test evidence.
- If public checks fail, repair only from public prompt/starter compatibility.

Boundary:
- This is a skill-conditioned behavioral plan, not proof that a LoRA adapter is trained."""
        rows.append({
            "messages": [
                {"role": "user", "content": user},
                {"role": "assistant", "content": assistant},
            ],
            "metadata": {
                "schema": "trajectory-memory-ledger.skill_to_lora_seed_example.v1",
                "skill_id": package.skill_id,
                "task_id": task_id,
                "relation": relation,
                "source": "deterministic_skill_evidence_seed",
            },
        })
    return rows


def split_examples(
    examples: list[dict[str, Any]],
    valid_ratio: float,
    test_ratio: float,
) -> dict[str, list[dict[str, Any]]]:
    if not examples:
        return {"train": [], "valid": [], "test": []}
    rows = sorted(examples, key=lambda item: item["metadata"]["task_id"])
    if len(rows) < 3:
        return {"train": rows, "valid": rows[:1], "test": rows[:1]}
    test_count = max(1, math.floor(len(rows) * test_ratio))
    valid_count = max(1, math.floor(len(rows) * valid_ratio))
    train_count = max(1, len(rows) - valid_count - test_count)
    return {
        "train": rows[:train_count],
        "valid": rows[train_count:train_count + valid_count],
        "test": rows[train_count + valid_count:],
    }


def skill_context(package: SkillPackage) -> str:
    return f"""# Skill-to-LoRA Context

Skill id: `{package.skill_id}`
Status: `{package.status}`
Family: `{package.family}`

## SKILL.md

{package.skill_md}

## MEMORY.md

{package.memory_md}

## Structured Skill

```json
{json.dumps(package.skill, indent=2, sort_keys=True)}
```

## Failure Modes

```json
{json.dumps(package.failure_modes, indent=2, sort_keys=True)}
```
"""


def teacher_task_input_prompt(args: argparse.Namespace, package: SkillPackage) -> str:
    return f"""# Skill-to-LoRA Teacher Prompt: Task Input Generation

Generate {args.teacher_examples_per_skill} realistic user/task inputs for skill `{package.skill_id}`.

Use only this skill package context:

{skill_context(package)}

Rules:
- Produce JSONL.
- Each row must have `skill_id`, `example_id`, `example_input`, `difficulty`, and `source_intent`.
- The `example_input` must include only a short skill id plus a realistic task request.
- Do not include full SKILL.md text in `example_input`.
- Vary repository context, file names, edge cases, and failure modes.
- Include both positive applicability examples and near-miss examples where the skill should not activate.
- Do not include hidden tests or private data.
"""


def teacher_label_prompt_for_skill(args: argparse.Namespace, package: SkillPackage) -> str:
    return f"""# Skill-to-LoRA Teacher Prompt: Behavioral Label Generation

Use the complete skill package to label generated example inputs for skill `{package.skill_id}`.

The student LoRA will later see only `skill_id` plus `example_input`, not SKILL.md.

Skill package context:

{skill_context(package)}

Input format:
- JSONL rows from `{safe_name(package.skill_id)}.task_inputs.md`.

Output format:
- JSONL chat rows compatible with MLX-LM LoRA training:
  {{"messages":[{{"role":"user","content":"..."}},{{"role":"assistant","content":"..."}}],"metadata":{{...}}}}

Assistant response requirements:
- Demonstrate the concrete behavior induced by the skill.
- State whether the skill applies.
- Name the scoped implementation strategy.
- Include public verification steps.
- Include avoidance conditions for near-miss examples.
- Stay under 700 words.
- Do not claim hidden-test evidence.
"""


def build_eval_rows(
    package: SkillPackage,
    evidence: list[dict[str, Any]],
    adapter_entry: dict[str, Any],
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for row in evidence:
        base = {
            "schema": "trajectory-memory-ledger.skill_to_lora_eval_prompt.v1",
            "skill_id": package.skill_id,
            "task_id": row.get("task_id", ""),
            "family": package.family,
            "candidate_path": row.get("candidate_path", ""),
            "public_prompt": row.get("public_prompt", ""),
            "hidden_tests_sent_to_model": False,
        }
        rows.extend([
            {**base, "condition": "no_skill", "adapter_path": "", "prompt": str(row.get("public_prompt", ""))},
            {
                **base,
                "condition": "full_skill_text",
                "adapter_path": "",
                "prompt": f"{package.skill_md}\n\nTask:\n{row.get('public_prompt', '')}",
            },
            {
                **base,
                "condition": "skill_lora",
                "adapter_path": adapter_entry["adapter_path"],
                "prompt": f"skill_id: {package.skill_id}\nTask:\n{row.get('public_prompt', '')}",
            },
            {
                **base,
                "condition": "wrong_lora_control",
                "adapter_path": "<intentionally-wrong-adapter>",
                "prompt": f"skill_id: {package.skill_id}\nTask:\n{row.get('public_prompt', '')}",
            },
            {
                **base,
                "condition": "shared_lora_control",
                "adapter_path": "<shared-pooled-skill-adapter>",
                "prompt": f"skill_id: {package.skill_id}\nTask:\n{row.get('public_prompt', '')}",
            },
        ])
    return rows


def train_command(args: argparse.Namespace, data_dir: Path, adapter_dir: Path) -> str:
    grad_checkpoint = " \\\n  --grad-checkpoint" if args.grad_checkpoint else ""
    return f"""#!/usr/bin/env bash
set -euo pipefail
export KMP_DUPLICATE_LIB_OK="${{KMP_DUPLICATE_LIB_OK:-TRUE}}"

python3 -m mlx_lm lora \\
  --model "{args.base_model}" \\
  --train \\
  --data "{data_dir}" \\
  --fine-tune-type lora \\
  --mask-prompt \\
  --num-layers {args.train_num_layers} \\
  --batch-size {args.train_batch_size} \\
  --iters {args.train_iters} \\
  --learning-rate {args.train_learning_rate} \\
  --max-seq-length {args.train_max_seq_length} \\
  --save-every {args.train_save_every} \\
  --adapter-path "{adapter_dir}" \\
  --seed {args.seed}{grad_checkpoint}
"""


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open(encoding="utf-8") as handle:
        for line_no, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as exc:
                raise SystemExit(f"{path}:{line_no}: bad JSON: {exc}") from exc
            if not isinstance(row, dict):
                raise SystemExit(f"{path}:{line_no}: row must be an object")
            rows.append(row)
    return rows


def read_optional(path: Path) -> str:
    return path.read_text(encoding="utf-8") if path.exists() else ""


def read_optional_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    raw = json.loads(path.read_text(encoding="utf-8"))
    return raw if isinstance(raw, dict) else {"value": raw}


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, sort_keys=True) + "\n")


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def safe_name(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", value).strip("_") or "skill"


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


if __name__ == "__main__":
    raise SystemExit(main())
