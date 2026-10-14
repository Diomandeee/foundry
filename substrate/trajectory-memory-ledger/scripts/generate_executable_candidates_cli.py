#!/usr/bin/env python3
"""
Generate executable benchmark candidate rows with a real non-interactive model CLI.

This script intentionally separates public task prompts from hidden verifier tests.
It can use a private trajectory store to build condition-specific prompt context,
but it only writes model-generated candidate files to the output JSONL.
"""

import argparse
import json
import random
import re
import subprocess
import sys
from pathlib import Path
from typing import Any


CONDITIONS = ("random", "reward_selected", "full_ledger")


def main() -> int:
    args = parse_args()
    public_tasks = read_jsonl(args.public_tasks)
    task_ids = [task["task_id"] for task in public_tasks]
    condition_contexts = build_condition_contexts(args.trajectory_store, args.seed)

    rows: list[dict[str, Any]] = []
    report = {
        "generator": "generate_executable_candidates_cli.py",
        "backend": args.backend,
        "model": args.model,
        "public_tasks": str(args.public_tasks),
        "trajectory_store": args.trajectory_store_label,
        "trajectory_store_private": True,
        "seed": args.seed,
        "conditions": {},
        "raw_dir": str(args.raw_dir),
    }
    args.raw_dir.mkdir(parents=True, exist_ok=True)

    for condition in CONDITIONS:
        prompt = build_prompt(condition, condition_contexts[condition], public_tasks)
        raw_path = args.raw_dir / f"{condition}.raw.txt"
        response = call_backend(args, prompt)
        raw_path.write_text(response, encoding="utf-8")
        parsed = parse_response_json(response)
        candidates = parsed.get("candidates") if isinstance(parsed, dict) else parsed
        if not isinstance(candidates, list):
            raise SystemExit(f"{condition}: model response did not contain a candidates list")

        condition_rows = []
        for candidate in candidates:
            row = normalize_candidate_row(
                condition=condition,
                candidate=candidate,
                public_tasks=public_tasks,
                source_artifact=f"{args.backend}:{args.model}:{raw_path.name}",
            )
            condition_rows.append(row)
        validate_condition_coverage(condition, condition_rows, task_ids)
        rows.extend(condition_rows)
        report["conditions"][condition] = {
            "rows": len(condition_rows),
            "raw_response": str(raw_path),
        }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text("".join(json.dumps(row, sort_keys=True) + "\n" for row in rows), encoding="utf-8")
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--public-tasks", type=Path, required=True)
    parser.add_argument("--trajectory-store", type=Path, required=True)
    parser.add_argument("--trajectory-store-label", default="private-local-trajectory-store")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--raw-dir", type=Path, required=True)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--backend", choices=("claude", "gemini"), default="claude")
    parser.add_argument("--model", default="sonnet")
    parser.add_argument("--max-budget-usd", type=float, default=2.0)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--timeout-s", type=int, default=240)
    return parser.parse_args()


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows = []
    with path.open(encoding="utf-8") as handle:
        for line_no, line in enumerate(handle, 1):
            if not line.strip():
                continue
            rows.append(json.loads(line))
    if not rows:
        raise SystemExit(f"{path} contained no rows")
    return rows


def build_condition_contexts(trajectory_store: Path, seed: int) -> dict[str, str]:
    records = load_trajectory_summaries(trajectory_store)
    if len(records) < 18:
        raise SystemExit(f"Need at least 18 usable trajectory records, found {len(records)}")

    rng = random.Random(seed)
    random_records = rng.sample(records, 6)
    reward_records = sorted(records, key=lambda row: row["reward"], reverse=True)[:6]

    by_rank = sorted(records, key=lambda row: row["reward"])
    full_records = [
        by_rank[0],
        by_rank[len(by_rank) // 5],
        by_rank[len(by_rank) // 2],
        by_rank[(len(by_rank) * 4) // 5],
        by_rank[-2],
        by_rank[-1],
    ]

    return {
        "random": format_context(
            "Random trajectory context. These are ordinary sampled ledger records and may contain weak, noisy, or incomplete process patterns.",
            random_records,
        ),
        "reward_selected": format_context(
            "Reward-selected trajectory context. These are high-reward ledger records. Prefer their process traits: inspect before editing, verify results, avoid repeated failures, and keep changes scoped.",
            reward_records,
        ),
        "full_ledger": format_context(
            "Full-ledger mixed context. This condition receives a broad slice across low, medium, and high reward records, representing the unfiltered ledger distribution.",
            full_records,
        ),
    }


def load_trajectory_summaries(path: Path) -> list[dict[str, Any]]:
    records = []
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            try:
                raw = json.loads(line)
            except json.JSONDecodeError:
                continue
            outcome = raw.get("outcome") or {}
            reward = outcome.get("reward_score")
            trajectory = raw.get("trajectory") or {}
            total_tools = trajectory.get("total_tools") or len(trajectory.get("tool_sequence") or [])
            if reward is None or total_tools < 2:
                continue
            prompt = (raw.get("context") or {}).get("prompt_text") or trajectory.get("prompt") or ""
            if len(prompt.strip()) < 10:
                continue
            records.append(
                {
                    "reward": float(reward),
                    "advantage": outcome.get("advantage"),
                    "prompt": clean_text(prompt, 360),
                    "tools": list((trajectory.get("tool_counts") or {}).keys())[:8],
                    "total_tools": total_tools,
                    "successes": trajectory.get("successes"),
                    "domain": raw.get("domain") or (raw.get("skill") or {}).get("domain"),
                }
            )
    return records


def format_context(title: str, records: list[dict[str, Any]]) -> str:
    lines = [title]
    for idx, record in enumerate(records, 1):
        lines.append(
            f"{idx}. reward={record['reward']:.4f}, advantage={record.get('advantage')}, "
            f"tools={record.get('tools')}, total_tools={record.get('total_tools')}, "
            f"domain={record.get('domain')}, prompt={record['prompt']}"
        )
    return "\n".join(lines)


def clean_text(text: str, limit: int) -> str:
    text = re.sub(r"\s+", " ", text).strip()
    text = re.sub(r"(?i)(api[_-]?key|secret|token|password)=\S+", r"\1=[REDACTED]", text)
    text = re.sub(r"\bsk-[A-Za-z0-9_-]{10,}\b", "[REDACTED]", text)
    return text[:limit]


def build_prompt(condition: str, context: str, public_tasks: list[dict[str, Any]]) -> str:
    task_block = json.dumps(public_tasks, indent=2, sort_keys=True)
    return f"""You are generating candidate source files for an executable held-out Python benchmark.

Condition: {condition}

Trajectory context for this condition:
{context}

Public tasks are below. Hidden tests are not shown. Implement only the requested candidate files.

{task_block}

Return ONLY valid JSON with this shape:
{{
  "candidates": [
    {{
      "task_id": "task id from the public task list",
      "candidate_files": {{"relative/path.py": "complete Python source code"}},
      "generated_tools": ["ModelGenerate"],
      "tests_included": false,
      "build_included": false
    }}
  ]
}}

Rules:
- Return one candidate for every public task.
- Use only the candidate_paths listed for each task.
- Do not include hidden tests, explanations, markdown fences, or extra keys.
- candidate_files values must be complete source file contents.
"""


def call_backend(args: argparse.Namespace, prompt: str) -> str:
    if args.backend == "claude":
        cmd = [
            "claude",
            "-p",
            prompt,
            "--model",
            args.model,
            "--output-format",
            "text",
            "--max-budget-usd",
            str(args.max_budget_usd),
            "--tools",
            "",
            "--no-session-persistence",
        ]
    elif args.backend == "gemini":
        cmd = [
            "gemini",
            "-p",
            prompt,
            "--model",
            args.model,
            "--output-format",
            "text",
        ]
    else:
        raise AssertionError(args.backend)

    completed = subprocess.run(
        cmd,
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=args.timeout_s,
    )
    response = completed.stdout.strip()
    if completed.returncode != 0:
        raise SystemExit(
            f"{args.backend} exited {completed.returncode}\nSTDERR:\n{completed.stderr}\nSTDOUT:\n{response}"
        )
    if not response:
        raise SystemExit(f"{args.backend} returned an empty response")
    return response


def parse_response_json(response: str) -> Any:
    response = response.strip()
    fenced = re.search(r"```(?:json)?\s*(.*?)```", response, flags=re.DOTALL)
    if fenced:
        response = fenced.group(1).strip()
    elif response.startswith("```"):
        response = re.sub(r"^```(?:json)?", "", response).strip()
        response = re.sub(r"```$", "", response).strip()
    decoder = json.JSONDecoder()
    starts = [idx for idx, char in enumerate(response) if char in "[{"]
    for start in starts:
        try:
            parsed, _ = decoder.raw_decode(response[start:])
            return parsed
        except json.JSONDecodeError:
            continue
    raise SystemExit(f"Could not parse JSON from model response:\n{response[:1000]}")


def normalize_candidate_row(
    condition: str,
    candidate: dict[str, Any],
    public_tasks: list[dict[str, Any]],
    source_artifact: str,
) -> dict[str, Any]:
    task_id = candidate.get("task_id")
    task = next((row for row in public_tasks if row["task_id"] == task_id), None)
    if task is None:
        raise SystemExit(f"{condition}: unknown task_id {task_id!r}")
    allowed_paths = set(task["candidate_paths"])
    files = candidate.get("candidate_files")
    if not isinstance(files, dict) or not files:
        raise SystemExit(f"{condition}/{task_id}: candidate_files missing")
    for path, content in files.items():
        if path not in allowed_paths:
            raise SystemExit(f"{condition}/{task_id}: path {path!r} not in allowed paths {sorted(allowed_paths)}")
        if not isinstance(content, str) or not content.strip():
            raise SystemExit(f"{condition}/{task_id}: empty content for {path}")
        validate_relative_path(path)
    return {
        "condition": condition,
        "task_id": task_id,
        "candidate_files": files,
        "generated_tools": candidate.get("generated_tools") or ["ModelGenerate"],
        "tests_included": bool(candidate.get("tests_included", False)),
        "build_included": bool(candidate.get("build_included", False)),
        "source_artifact": source_artifact,
        "synthetic": False,
    }


def validate_relative_path(path: str) -> None:
    candidate = Path(path)
    if candidate.is_absolute() or ".." in candidate.parts or not candidate.parts:
        raise SystemExit(f"unsafe relative path {path!r}")


def validate_condition_coverage(condition: str, rows: list[dict[str, Any]], task_ids: list[str]) -> None:
    observed = [row["task_id"] for row in rows]
    if sorted(observed) != sorted(task_ids):
        raise SystemExit(
            f"{condition}: expected task ids {sorted(task_ids)}, observed {sorted(observed)}"
        )
    if len(observed) != len(set(observed)):
        raise SystemExit(f"{condition}: duplicate task ids in model response")


if __name__ == "__main__":
    raise SystemExit(main())
