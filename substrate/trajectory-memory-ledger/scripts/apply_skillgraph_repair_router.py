#!/usr/bin/env python3
"""Apply regression-gated skillgraph repairs to candidate rows.

This builds a surgical router candidate set: start from a strong baseline
candidate file and swap in comparison candidates only for task ids repaired by
allowed skill statuses. Hidden tests are not read here.
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def main() -> int:
    args = parse_args()
    base_rows = read_jsonl(args.base_candidates)
    comparison_rows = read_jsonl(args.comparison_candidates)
    skills = read_jsonl(args.skills_jsonl)

    base_by_task = rows_by_task(base_rows, "base")
    comparison_by_task = rows_by_task(comparison_rows, "comparison")
    allowed_statuses = set(args.allow_status)
    repairs = collect_repairs(skills, allowed_statuses, args.require_no_skill_regressions)
    preserved_regressions = collect_regressions(skills, allowed_statuses)
    routed_rows, routed_task_ids = apply_repairs(
        base_rows=base_rows,
        comparison_by_task=comparison_by_task,
        repairs=repairs,
        condition=args.condition,
    )

    missing_repairs = sorted(set(repairs) - set(base_by_task))
    if missing_repairs:
        raise SystemExit(f"repair task ids missing from base candidates: {missing_repairs}")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        "".join(json.dumps(row, sort_keys=True) + "\n" for row in routed_rows),
        encoding="utf-8",
    )

    report = {
        "generator": "apply_skillgraph_repair_router.py",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "base_candidates": str(args.base_candidates),
        "comparison_candidates": str(args.comparison_candidates),
        "skills_jsonl": str(args.skills_jsonl),
        "output": str(args.output),
        "condition": args.condition,
        "allow_status": args.allow_status,
        "require_no_skill_regressions": args.require_no_skill_regressions,
        "hidden_tests_sent_to_model": False,
        "synthetic_rows": sum(1 for row in routed_rows if row.get("synthetic")),
        "total_rows": len(routed_rows),
        "base_condition": single_condition(base_rows, "base"),
        "comparison_condition": single_condition(comparison_rows, "comparison"),
        "routed_task_ids": routed_task_ids,
        "routed_row_count": len(routed_task_ids),
        "preserved_base_row_count": len(routed_rows) - len(routed_task_ids),
        "repairs_by_task": repairs,
        "known_regression_task_ids_preserved_from_base": sorted(
            set(preserved_regressions) - set(routed_task_ids)
        ),
    }
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-candidates", type=Path, required=True)
    parser.add_argument("--comparison-candidates", type=Path, required=True)
    parser.add_argument("--skills-jsonl", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--condition", default="skillgraph_repair_router")
    parser.add_argument("--allow-status", nargs="+", default=["promoted"])
    parser.add_argument("--require-no-skill-regressions", action=argparse.BooleanOptionalAction, default=True)
    return parser.parse_args()


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open(encoding="utf-8") as handle:
        for line_no, line in enumerate(handle, 1):
            if not line.strip():
                continue
            row = json.loads(line)
            if not isinstance(row, dict):
                raise SystemExit(f"{path}:{line_no}: expected JSON object")
            rows.append(row)
    if not rows:
        raise SystemExit(f"{path} contained no rows")
    return rows


def rows_by_task(rows: list[dict[str, Any]], label: str) -> dict[str, dict[str, Any]]:
    by_task: dict[str, dict[str, Any]] = {}
    for row in rows:
        task_id = str(row.get("task_id", "")).strip()
        if not task_id:
            raise SystemExit(f"{label}: candidate row missing task_id")
        if task_id in by_task:
            raise SystemExit(f"{label}: duplicate task_id {task_id}")
        by_task[task_id] = row
    return by_task


def single_condition(rows: list[dict[str, Any]], label: str) -> str:
    conditions = sorted({str(row.get("condition", "")).strip() for row in rows})
    if len(conditions) != 1 or not conditions[0]:
        raise SystemExit(f"{label}: expected exactly one non-empty condition, found {conditions}")
    return conditions[0]


def collect_repairs(
    skills: list[dict[str, Any]],
    allow_status: set[str],
    require_no_skill_regressions: bool,
) -> dict[str, dict[str, str]]:
    repairs: dict[str, dict[str, str]] = {}
    for skill in skills:
        status = str(skill.get("status", "")).strip()
        if status not in allow_status:
            continue
        skill_id = str(skill.get("id", "")).strip()
        if not skill_id:
            raise SystemExit("allowed skill missing id")
        regressions = [str(task_id) for task_id in skill.get("regression_task_ids", [])]
        if require_no_skill_regressions and regressions:
            raise SystemExit(f"allowed skill {skill_id} has regressions: {regressions}")
        for task_id in skill.get("repairs_task_ids", []):
            task_id = str(task_id)
            previous = repairs.get(task_id)
            if previous:
                raise SystemExit(
                    f"repair task {task_id} claimed by both {previous['skill_id']} and {skill_id}"
                )
            repairs[task_id] = {"skill_id": skill_id, "status": status}
    if not repairs:
        raise SystemExit(f"no repairs found for allowed statuses {sorted(allow_status)}")
    return repairs


def collect_regressions(skills: list[dict[str, Any]], allow_status: set[str]) -> list[str]:
    regressions: list[str] = []
    for skill in skills:
        status = str(skill.get("status", "")).strip()
        if status not in allow_status:
            continue
        regressions.extend(str(task_id) for task_id in skill.get("regression_task_ids", []))
    return sorted(set(regressions))


def apply_repairs(
    base_rows: list[dict[str, Any]],
    comparison_by_task: dict[str, dict[str, Any]],
    repairs: dict[str, dict[str, str]],
    condition: str,
) -> tuple[list[dict[str, Any]], list[str]]:
    routed_rows: list[dict[str, Any]] = []
    routed_task_ids: list[str] = []
    for base_row in base_rows:
        task_id = str(base_row["task_id"])
        repair = repairs.get(task_id)
        source_row = base_row
        routed = False
        if repair:
            if task_id not in comparison_by_task:
                raise SystemExit(f"repair task {task_id} missing from comparison candidates")
            source_row = comparison_by_task[task_id]
            routed = True
            routed_task_ids.append(task_id)

        row = dict(source_row)
        row["condition"] = condition
        row["synthetic"] = bool(source_row.get("synthetic", False))
        row["generated_tools"] = list(source_row.get("generated_tools") or [])
        if routed:
            row["generated_tools"].append("SkillGraphRepairRouter")
            row["source_artifact"] = (
                f"skillgraph-repair-router:skill={repair['skill_id']}:"
                f"status={repair['status']}:source={source_row.get('source_artifact', '')}"
            )
        else:
            row["generated_tools"].append("SkillGraphBasePreserve")
            row["source_artifact"] = (
                f"skillgraph-repair-router:base-preserve:"
                f"source={source_row.get('source_artifact', '')}"
            )
        routed_rows.append(row)
    return routed_rows, routed_task_ids


if __name__ == "__main__":
    raise SystemExit(main())
