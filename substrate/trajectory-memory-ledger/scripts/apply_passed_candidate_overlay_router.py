#!/usr/bin/env python3
"""Overlay only repair candidates that passed executable evaluation.

This starts from a trusted base candidate set and replaces rows only for task
ids whose focused repair candidates passed a real executable-task-bench report.
The script does not read hidden tests; it consumes the already-produced pass/fail
report as routing evidence.
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
    repair_rows = read_jsonl(args.repair_candidates)
    repair_report = read_json(args.repair_report)

    base_by_task = rows_by_task(base_rows, "base")
    repair_by_task = rows_by_task(repair_rows, "repair")
    repair_condition = single_condition(repair_rows, "repair")
    passed_task_ids = collect_passed_task_ids(repair_report, repair_condition)

    unknown_passes = sorted(passed_task_ids - set(repair_by_task))
    if unknown_passes:
        raise SystemExit(f"repair report passed task ids missing from repair candidates: {unknown_passes}")
    missing_base = sorted(passed_task_ids - set(base_by_task))
    if missing_base:
        raise SystemExit(f"passed repair task ids missing from base candidates: {missing_base}")

    overlay_rows: list[dict[str, Any]] = []
    overlay_task_ids: list[str] = []
    for base_row in base_rows:
        task_id = str(base_row["task_id"])
        if task_id in passed_task_ids:
            row = dict(repair_by_task[task_id])
            row["condition"] = args.condition
            row["synthetic"] = bool(row.get("synthetic", False))
            row["generated_tools"] = list(row.get("generated_tools") or [])
            row["generated_tools"].append("PassedCandidateOverlayRouter")
            row["source_artifact"] = (
                f"passed-candidate-overlay:repair-report={args.repair_report}:"
                f"source={row.get('source_artifact', '')}"
            )
            overlay_task_ids.append(task_id)
        else:
            row = dict(base_row)
            row["condition"] = args.condition
            row["synthetic"] = bool(row.get("synthetic", False))
            row["generated_tools"] = list(row.get("generated_tools") or [])
            row["generated_tools"].append("OverlayBasePreserve")
            row["source_artifact"] = (
                f"passed-candidate-overlay:base-preserve:"
                f"source={row.get('source_artifact', '')}"
            )
        overlay_rows.append(row)

    rejected_task_ids = sorted(set(repair_by_task) - set(overlay_task_ids))
    validate_coverage(base_rows, overlay_rows)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        "".join(json.dumps(row, sort_keys=True) + "\n" for row in overlay_rows),
        encoding="utf-8",
    )

    report = {
        "generator": "apply_passed_candidate_overlay_router.py",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "base_candidates": str(args.base_candidates),
        "repair_candidates": str(args.repair_candidates),
        "repair_report": str(args.repair_report),
        "output": str(args.output),
        "condition": args.condition,
        "base_condition": single_condition(base_rows, "base"),
        "repair_condition": repair_condition,
        "hidden_tests_sent_to_model": False,
        "synthetic_rows": sum(1 for row in overlay_rows if row.get("synthetic")),
        "total_rows": len(overlay_rows),
        "overlay_task_ids": overlay_task_ids,
        "overlay_row_count": len(overlay_task_ids),
        "rejected_task_ids": rejected_task_ids,
        "preserved_base_row_count": len(overlay_rows) - len(overlay_task_ids),
    }
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-candidates", type=Path, required=True)
    parser.add_argument("--repair-candidates", type=Path, required=True)
    parser.add_argument("--repair-report", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--condition", default="passed_candidate_overlay_router")
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


def read_json(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise SystemExit(f"{path}: expected JSON object")
    return data


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


def collect_passed_task_ids(report: dict[str, Any], repair_condition: str) -> set[str]:
    if not report.get("measures_executed_task_completion"):
        raise SystemExit("repair report does not claim executable task completion measurement")
    if int(report.get("synthetic_rows", -1)) != 0:
        raise SystemExit("repair report must have synthetic_rows=0")

    row_results = report.get("row_results")
    if not isinstance(row_results, list) or not row_results:
        raise SystemExit("repair report missing row_results")

    passed: set[str] = set()
    observed = 0
    for result in row_results:
        if not isinstance(result, dict):
            raise SystemExit("repair report row_results must contain objects")
        if str(result.get("condition", "")) != repair_condition:
            continue
        task_id = str(result.get("task_id", "")).strip()
        if not task_id:
            raise SystemExit("repair report row result missing task_id")
        observed += 1
        if bool(result.get("passed")):
            passed.add(task_id)
    if observed == 0:
        raise SystemExit(f"repair report has no row_results for condition {repair_condition!r}")
    return passed


def validate_coverage(base_rows: list[dict[str, Any]], overlay_rows: list[dict[str, Any]]) -> None:
    base_ids = [str(row.get("task_id", "")) for row in base_rows]
    overlay_ids = [str(row.get("task_id", "")) for row in overlay_rows]
    if base_ids != overlay_ids:
        raise SystemExit("overlay output changed base task order or coverage")
    if len(overlay_ids) != len(set(overlay_ids)):
        raise SystemExit("overlay output contains duplicate task ids")


if __name__ == "__main__":
    raise SystemExit(main())
