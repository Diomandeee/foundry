#!/usr/bin/env python3
"""Prepare or summarize a SWE-bench-style real-repo issue gate.

This script is intentionally conservative. It can validate base-vs-planner
prediction coverage before an official harness run, and it can summarize
official SWE-bench harness reports after they exist. It never turns a fixture
or missing report into a performance claim.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class ConditionPredictions:
    label: str
    path: Path
    rows: list[dict[str, Any]]
    by_instance: dict[str, dict[str, Any]]
    model_names: list[str]
    synthetic_rows: int
    sha256: str
    size_bytes: int


@dataclass(frozen=True)
class HarnessReport:
    path: Path
    total_instances: int | None
    submitted_instances: int | None
    completed_instances: int | None
    resolved_instances: int | None
    resolved_ids: list[str]
    patch_applied_instances: int | None
    tests_passed_instances: int | None
    error_count: int | None
    synthetic: bool
    source_files: list[str]
    source_fingerprints: dict[str, dict[str, Any]]


def main() -> int:
    args = parse_args()

    instances = read_jsonl(args.instances_jsonl) if args.instances_jsonl else []
    instance_ids = instance_id_set(instances)
    instance_synthetic_rows = count_synthetic(instances)

    base = load_predictions(args.base_condition, args.base_predictions)
    planner = load_predictions(args.planner_condition, args.planner_predictions)

    errors: list[str] = []
    warnings: list[str] = []
    if not args.allow_synthetic_fixture:
        if base.synthetic_rows or planner.synthetic_rows or instance_synthetic_rows:
            errors.append("synthetic fixture rows require --allow-synthetic-fixture")

    same_prediction_ids = set(base.by_instance) == set(planner.by_instance)
    if not same_prediction_ids:
        errors.append("base and planner prediction files do not cover the same instance ids")

    if instance_ids:
        missing_base = sorted(instance_ids - set(base.by_instance))
        missing_planner = sorted(instance_ids - set(planner.by_instance))
        extra_base = sorted(set(base.by_instance) - instance_ids)
        extra_planner = sorted(set(planner.by_instance) - instance_ids)
        if missing_base:
            errors.append(f"base predictions missing manifest instances: {missing_base}")
        if missing_planner:
            errors.append(f"planner predictions missing manifest instances: {missing_planner}")
        if extra_base:
            errors.append(f"base predictions contain non-manifest instances: {extra_base}")
        if extra_planner:
            errors.append(f"planner predictions contain non-manifest instances: {extra_planner}")

    same_model_names = sorted(set(base.model_names)) == sorted(set(planner.model_names))
    if not same_model_names:
        warnings.append(
            "base and planner prediction model_name_or_path values differ; "
            "record an explicit same-model justification before citing results"
        )

    base_report = load_harness_report(args.base_report) if args.base_report else None
    planner_report = load_harness_report(args.planner_report) if args.planner_report else None
    comparison = compare_reports(base_report, planner_report)

    result_ids_known = (
        base_report is not None
        and planner_report is not None
        and bool(base_report.resolved_ids or planner_report.resolved_ids)
    )
    reports_available = base_report is not None and planner_report is not None
    synthetic_any = any(
        [
            base.synthetic_rows > 0,
            planner.synthetic_rows > 0,
            instance_synthetic_rows > 0,
            bool(base_report and base_report.synthetic),
            bool(planner_report and planner_report.synthetic),
        ]
    )

    claim = build_claim(
        args=args,
        reports_available=reports_available,
        result_ids_known=result_ids_known,
        comparison=comparison,
        same_prediction_ids=same_prediction_ids,
        same_model_names=same_model_names,
        synthetic_any=synthetic_any,
        errors=errors,
    )

    prediction_ids = sorted(set(base.by_instance) | set(planner.by_instance) | instance_ids)
    report = {
        "schema": "trajectory-memory-ledger.real_repo_issue_gate.v1",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "gate_kind": "swebench_style_real_repo_issue_resolution",
        "dataset": {
            "name": args.dataset_name,
            "split": args.split,
            "subset_label": args.subset_label,
            "instances_jsonl": str(args.instances_jsonl) if args.instances_jsonl else None,
            "instances_fingerprint": file_fingerprint(args.instances_jsonl)
            if args.instances_jsonl
            else None,
            "manifest_instance_count": len(instance_ids) if instance_ids else None,
            "prediction_instance_count": len(prediction_ids),
            "synthetic_manifest_rows": instance_synthetic_rows,
            "instance_ids": prediction_ids,
        },
        "conditions": {
            args.base_condition: summarize_predictions(base),
            args.planner_condition: summarize_predictions(planner),
        },
        "contract": {
            "same_prediction_instance_ids": same_prediction_ids,
            "same_model_names_recorded": same_model_names,
            "same_budget_label": args.budget_label,
            "same_timeout_required": True,
            "same_harness_required": True,
            "official_harness_required_for_performance_claim": True,
            "hidden_tests_may_not_be_used_for_generation": True,
            "planner_may_use_ledger_memory_before_patch_generation": True,
            "planner_may_not_use_harness_results_until_after_both_runs": True,
            "minimum_real_instances_for_pilot_claim": args.minimum_real_instances,
            "minimum_real_instances_for_broad_claim": args.minimum_broad_instances,
        },
        "official_harness_commands": build_harness_commands(args),
        "official_sources": [
            "https://www.swebench.com/SWE-bench/guides/evaluation/",
            "https://github.com/SWE-bench/SWE-bench",
            "https://www.swebench.com/verified.html",
            "https://www.swebench.com/lite.html",
        ],
        "preflight": {
            "ok": not errors,
            "errors": errors,
            "warnings": warnings,
        },
        "harness_reports": {
            args.base_condition: summarize_report(base_report),
            args.planner_condition: summarize_report(planner_report),
        },
        "comparison": comparison,
        "performance_claim": claim,
    }

    write_json(args.output, report)
    print(json.dumps(report["performance_claim"], indent=2, sort_keys=True))
    if errors:
        return 2
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-predictions", type=Path, required=True)
    parser.add_argument("--planner-predictions", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--instances-jsonl", type=Path)
    parser.add_argument("--base-report", type=Path)
    parser.add_argument("--planner-report", type=Path)
    parser.add_argument("--dataset-name", default="princeton-nlp/SWE-bench_Verified")
    parser.add_argument("--split", default="test")
    parser.add_argument("--subset-label", default="verified-mini-or-frozen-subset")
    parser.add_argument("--base-condition", default="base_agent")
    parser.add_argument("--planner-condition", default="base_agent_tml_planner")
    parser.add_argument("--budget-label", default="same-model-same-budget-same-timeout")
    parser.add_argument("--base-run-id", default="tml_base_real_repo_gate")
    parser.add_argument("--planner-run-id", default="tml_planner_real_repo_gate")
    parser.add_argument("--max-workers", type=int, default=1)
    parser.add_argument("--harness-timeout", type=int, default=1800)
    parser.add_argument("--report-dir", default="evaluation_results")
    parser.add_argument("--minimum-real-instances", type=int, default=50)
    parser.add_argument("--minimum-broad-instances", type=int, default=300)
    parser.add_argument("--allow-synthetic-fixture", action="store_true")
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
        raise SystemExit(f"{path}: no rows found")
    return rows


def load_predictions(label: str, path: Path) -> ConditionPredictions:
    rows = read_jsonl(path)
    by_instance: dict[str, dict[str, Any]] = {}
    model_names: set[str] = set()
    for line_no, row in enumerate(rows, 1):
        for key in ("instance_id", "model_name_or_path", "model_patch"):
            if key not in row:
                raise SystemExit(f"{path}:{line_no}: prediction missing {key}")
        instance_id = str(row["instance_id"]).strip()
        model_name = str(row["model_name_or_path"]).strip()
        patch = row["model_patch"]
        if not instance_id:
            raise SystemExit(f"{path}:{line_no}: empty instance_id")
        if not model_name:
            raise SystemExit(f"{path}:{line_no}: empty model_name_or_path")
        if not isinstance(patch, str):
            raise SystemExit(f"{path}:{line_no}: model_patch must be a string")
        if instance_id in by_instance:
            raise SystemExit(f"{path}:{line_no}: duplicate instance_id {instance_id}")
        by_instance[instance_id] = row
        model_names.add(model_name)
    return ConditionPredictions(
        label=label,
        path=path,
        rows=rows,
        by_instance=by_instance,
        model_names=sorted(model_names),
        synthetic_rows=count_synthetic(rows),
        sha256=sha256_file(path),
        size_bytes=path.stat().st_size,
    )


def count_synthetic(rows: list[dict[str, Any]]) -> int:
    return sum(1 for row in rows if bool(row.get("synthetic") or row.get("synthetic_fixture")))


def instance_id_set(rows: list[dict[str, Any]]) -> set[str]:
    ids: set[str] = set()
    for line_no, row in enumerate(rows, 1):
        instance_id = str(row.get("instance_id", "")).strip()
        if not instance_id:
            raise SystemExit(f"instances row {line_no}: missing instance_id")
        if instance_id in ids:
            raise SystemExit(f"instances row {line_no}: duplicate instance_id {instance_id}")
        ids.add(instance_id)
    return ids


def summarize_predictions(predictions: ConditionPredictions) -> dict[str, Any]:
    return {
        "path": str(predictions.path),
        "sha256": predictions.sha256,
        "size_bytes": predictions.size_bytes,
        "prediction_count": len(predictions.rows),
        "model_names": predictions.model_names,
        "synthetic_rows": predictions.synthetic_rows,
        "instance_ids": sorted(predictions.by_instance),
    }


def load_harness_report(path: Path) -> HarnessReport:
    source_files: list[Path] = []
    summary_data: dict[str, Any] = {}
    instance_rows: list[dict[str, Any]] = []

    if path.is_dir():
        result_path = path / "results.json"
        instance_path = path / "instance_results.jsonl"
        if result_path.exists():
            summary_data = read_json(result_path)
            source_files.append(result_path)
        if instance_path.exists():
            instance_rows = read_jsonl(instance_path)
            source_files.append(instance_path)
    elif path.suffix == ".jsonl":
        instance_rows = read_jsonl(path)
        source_files.append(path)
    else:
        summary_data = read_json(path)
        source_files.append(path)

    if not source_files:
        raise SystemExit(f"{path}: no results.json or instance_results.jsonl found")

    instance_summary = summarize_instance_results(instance_rows)
    resolved_ids = sorted(
        set(extract_string_list(summary_data, "resolved_ids"))
        | set(extract_string_list(summary_data, "resolved_instances"))
        | set(instance_summary["resolved_ids"])
    )
    total = first_int(summary_data, ["total_instances", "total", "num_instances"])
    submitted = first_int(
        summary_data,
        ["submitted_instances", "instances_submitted", "num_submitted", "submitted"],
    )
    completed = first_int(
        summary_data,
        ["completed_instances", "instances_completed", "num_completed", "completed"],
    )
    resolved = first_int(
        summary_data,
        ["resolved_instances", "instances_resolved", "num_resolved", "resolved"],
    )
    patch_applied = first_int(
        summary_data,
        ["patch_applied_instances", "instances_patch_applied", "num_patch_applied"],
    )
    tests_passed = first_int(
        summary_data,
        ["tests_passed_instances", "instances_tests_passed", "num_tests_passed"],
    )
    error_count = first_int(summary_data, ["error_count", "errors", "num_errors"])

    if total is None:
        total = instance_summary["total_instances"] or None
    if submitted is None:
        submitted = total
    if completed is None:
        completed = instance_summary["completed_instances"] or None
    if resolved is None:
        resolved = len(resolved_ids) if resolved_ids else None
    if patch_applied is None:
        patch_applied = instance_summary["patch_applied_instances"] or None
    if tests_passed is None:
        tests_passed = instance_summary["tests_passed_instances"] or None
    if error_count is None:
        error_count = instance_summary["error_count"] or None

    synthetic = bool(summary_data.get("synthetic") or summary_data.get("synthetic_fixture"))
    synthetic = synthetic or any(bool(row.get("synthetic") or row.get("synthetic_fixture")) for row in instance_rows)

    return HarnessReport(
        path=path,
        total_instances=total,
        submitted_instances=submitted,
        completed_instances=completed,
        resolved_instances=resolved,
        resolved_ids=resolved_ids,
        patch_applied_instances=patch_applied,
        tests_passed_instances=tests_passed,
        error_count=error_count,
        synthetic=synthetic,
        source_files=[str(p) for p in source_files],
        source_fingerprints={str(p): file_fingerprint(p) for p in source_files},
    )


def read_json(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        raise SystemExit(f"{path}: expected JSON object")
    return data


def first_int(data: dict[str, Any], keys: list[str]) -> int | None:
    for key in keys:
        value = data.get(key)
        if isinstance(value, bool):
            continue
        if isinstance(value, int):
            return value
        if isinstance(value, float) and value.is_integer():
            return int(value)
    return None


def extract_string_list(data: dict[str, Any], key: str) -> list[str]:
    value = data.get(key)
    if not isinstance(value, list):
        return []
    return [str(item) for item in value if str(item).strip()]


def summarize_instance_results(rows: list[dict[str, Any]]) -> dict[str, Any]:
    resolved_ids: list[str] = []
    patch_applied = 0
    tests_passed = 0
    completed = 0
    errors = 0
    for row in rows:
        instance_id = str(row.get("instance_id", "")).strip()
        if not instance_id:
            continue
        status = str(row.get("status", "")).lower()
        resolved = bool(row.get("resolved") or row.get("is_resolved") or row.get("passed"))
        resolved = resolved or status in {"resolved", "pass", "passed", "success"}
        if resolved:
            resolved_ids.append(instance_id)
        if bool(row.get("patch_applied") or row.get("patch_apply_success")):
            patch_applied += 1
        if bool(row.get("tests_passed") or row.get("test_passed")):
            tests_passed += 1
        if status not in {"", "pending"}:
            completed += 1
        if "error" in status or row.get("error"):
            errors += 1
    return {
        "total_instances": len(rows),
        "completed_instances": completed,
        "resolved_ids": sorted(set(resolved_ids)),
        "patch_applied_instances": patch_applied,
        "tests_passed_instances": tests_passed,
        "error_count": errors,
    }


def summarize_report(report: HarnessReport | None) -> dict[str, Any] | None:
    if report is None:
        return None
    submitted = report.submitted_instances or report.total_instances or len(report.resolved_ids)
    rate = None
    if submitted:
        rate = (report.resolved_instances or 0) / submitted
    return {
        "path": str(report.path),
        "source_files": report.source_files,
        "source_fingerprints": report.source_fingerprints,
        "total_instances": report.total_instances,
        "submitted_instances": report.submitted_instances,
        "completed_instances": report.completed_instances,
        "resolved_instances": report.resolved_instances,
        "resolution_rate": rate,
        "resolved_ids": report.resolved_ids,
        "patch_applied_instances": report.patch_applied_instances,
        "tests_passed_instances": report.tests_passed_instances,
        "error_count": report.error_count,
        "synthetic": report.synthetic,
    }


def compare_reports(
    base_report: HarnessReport | None,
    planner_report: HarnessReport | None,
) -> dict[str, Any] | None:
    if base_report is None or planner_report is None:
        return None
    base_resolved = set(base_report.resolved_ids)
    planner_resolved = set(planner_report.resolved_ids)
    base_count = base_report.resolved_instances
    planner_count = planner_report.resolved_instances
    if base_count is None:
        base_count = len(base_resolved)
    if planner_count is None:
        planner_count = len(planner_resolved)
    submitted = (
        planner_report.submitted_instances
        or base_report.submitted_instances
        or planner_report.total_instances
        or base_report.total_instances
    )
    evaluated = max(
        value or 0
        for value in [
            base_report.submitted_instances,
            planner_report.submitted_instances,
            base_report.total_instances,
            planner_report.total_instances,
            base_report.completed_instances,
            planner_report.completed_instances,
        ]
    )
    return {
        "evaluated_instances": evaluated,
        "base_resolved_instances": base_count,
        "planner_resolved_instances": planner_count,
        "resolved_delta": planner_count - base_count,
        "resolution_rate_delta": ((planner_count - base_count) / submitted) if submitted else None,
        "fixed_by_planner_ids": sorted(planner_resolved - base_resolved),
        "regressed_by_planner_ids": sorted(base_resolved - planner_resolved),
        "shared_resolved_ids": sorted(base_resolved & planner_resolved),
        "resolved_id_sets_available": bool(base_resolved or planner_resolved),
    }


def build_claim(
    *,
    args: argparse.Namespace,
    reports_available: bool,
    result_ids_known: bool,
    comparison: dict[str, Any] | None,
    same_prediction_ids: bool,
    same_model_names: bool,
    synthetic_any: bool,
    errors: list[str],
) -> dict[str, Any]:
    if errors:
        return {
            "allowed": False,
            "status": "preflight_failed",
            "honest_interpretation": "The gate inputs are invalid; no performance claim is allowed.",
        }
    if not reports_available:
        return {
            "allowed": False,
            "status": "waiting_for_official_harness_results",
            "honest_interpretation": (
                "Prediction coverage can be checked, but real-repo performance is unmeasured until "
                "both conditions have official SWE-bench harness reports."
            ),
        }
    if synthetic_any:
        return {
            "allowed": False,
            "status": "synthetic_fixture_not_performance_evidence",
            "honest_interpretation": (
                "The fixture exercises the gate and comparison logic only. It is not evidence that "
                "TML improves real repository issue resolution."
            ),
        }
    if not same_prediction_ids:
        return {
            "allowed": False,
            "status": "mismatched_instance_coverage",
            "honest_interpretation": "Base and planner did not run on the same instance set.",
        }
    if not same_model_names:
        return {
            "allowed": False,
            "status": "same_model_contract_unproven",
            "honest_interpretation": "The run does not yet prove a same-model base-vs-planner comparison.",
        }
    if comparison is None:
        return {
            "allowed": False,
            "status": "missing_comparison",
            "honest_interpretation": "Harness reports were present but could not be compared.",
        }
    delta = int(comparison["resolved_delta"])
    instance_count = int(comparison.get("evaluated_instances") or 0)
    if result_ids_known:
        ids_seen = set(comparison["fixed_by_planner_ids"])
        ids_seen |= set(comparison["regressed_by_planner_ids"])
        ids_seen |= set(comparison["shared_resolved_ids"])
        instance_count = max(instance_count, len(ids_seen))
    if delta <= 0:
        return {
            "allowed": True,
            "status": "no_planner_lift_observed" if delta == 0 else "planner_regression_observed",
            "planner_lift_observed": False,
            "honest_interpretation": (
                "The real-repo gate did not show a positive TML planner delta. Treat failed traces "
                "as diagnostics, not proof."
            ),
        }
    if instance_count < args.minimum_real_instances:
        return {
            "allowed": True,
            "status": "positive_tiny_real_repo_smoke_only",
            "planner_lift_observed": True,
            "broad_claim_allowed": False,
            "honest_interpretation": (
                "A positive delta was observed, but the run is smaller than the configured pilot "
                "threshold. It is a smoke signal, not a paper-grade result."
            ),
        }
    if instance_count < args.minimum_broad_instances:
        return {
            "allowed": True,
            "status": "positive_real_repo_pilot",
            "planner_lift_observed": True,
            "broad_claim_allowed": False,
            "honest_interpretation": (
                "The planner improved a real-repo pilot gate. This supports further evaluation, "
                "but a broad SWE-bench claim still needs Lite or Verified scale."
            ),
        }
    return {
        "allowed": True,
        "status": "positive_real_repo_lite_or_verified_scale",
        "planner_lift_observed": True,
        "broad_claim_allowed": True,
        "honest_interpretation": (
            "The planner improved a Lite/Verified-scale real-repo gate under the recorded contract. "
            "This is the first paper-grade downstream issue-resolution claim, still distinct from "
            "adapter-level model replacement."
        ),
    }


def build_harness_commands(args: argparse.Namespace) -> dict[str, str]:
    def command(predictions: Path, run_id: str) -> str:
        return " \\\n  ".join(
            [
                "python -m swebench.harness.run_evaluation",
                f"--dataset_name {args.dataset_name}",
                f"--split {args.split}",
                f"--predictions_path {predictions}",
                f"--max_workers {args.max_workers}",
                f"--timeout {args.harness_timeout}",
                f"--run_id {run_id}",
                f"--report_dir {args.report_dir}",
            ]
        )

    return {
        args.base_condition: command(args.base_predictions, args.base_run_id),
        args.planner_condition: command(args.planner_predictions, args.planner_run_id),
        "mac_arm_note": "On macOS ARM, official SWE-bench docs say to add --namespace '' so images build locally.",
    }


def write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2, sort_keys=True)
        handle.write("\n")


def file_fingerprint(path: Path) -> dict[str, Any]:
    return {
        "path": str(path),
        "size_bytes": path.stat().st_size,
        "sha256": sha256_file(path),
    }


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


if __name__ == "__main__":
    raise SystemExit(main())
