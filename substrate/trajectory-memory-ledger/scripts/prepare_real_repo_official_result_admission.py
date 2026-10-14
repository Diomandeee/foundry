#!/usr/bin/env python3
"""Prepare or verify admission of official SWE-bench result reports.

This script sits after the scorer handoff. It verifies that the private handoff
inputs still match the recorded SHA-256 fingerprints, then either records that
official reports are still missing or summarizes supplied reports through the
real-repo issue gate. It does not run SWE-bench.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


REQUIRED_FINGERPRINT_KEYS = {
    "instances_jsonl",
    "base_predictions",
    "planner_predictions",
}


def main() -> int:
    args = parse_args()
    if args.gate_output is None:
        args.gate_output = Path(
            f"benchmarks/real-repo-issue-gate-{args.subset_label}-official.json"
        )

    expected_reports = {
        "base_agent": args.base_report or Path(args.report_dir) / args.base_run_id,
        "base_agent_tml_planner": args.planner_report
        or Path(args.report_dir) / args.planner_run_id,
    }
    input_paths = {
        "instances_jsonl": args.handoff_dir / "inputs" / "instances.jsonl",
        "base_predictions": args.handoff_dir / "inputs" / "base-agent.predictions.jsonl",
        "planner_predictions": args.handoff_dir / "inputs" / "tml-planner.predictions.jsonl",
    }

    errors: list[str] = []
    warnings: list[str] = []
    fingerprint_report = verify_handoff_fingerprints(args.handoff_dir, errors, warnings)

    report_presence = {
        key: {
            "path": str(path),
            "exists": path.exists(),
        }
        for key, path in expected_reports.items()
    }
    report_supplied = all(row["exists"] for row in report_presence.values())
    any_report_supplied = any(row["exists"] for row in report_presence.values())
    partial_report_summaries = summarize_present_reports(expected_reports, warnings)
    failure_evidence = collect_failure_evidence(args.failure_log_dir)
    gate_command: list[str] | None = None
    gate_result: dict[str, Any] | None = None
    gate_process: dict[str, Any] | None = None

    if not errors and report_supplied:
        gate_command = build_gate_command(args, input_paths, expected_reports)
        process = subprocess.run(
            gate_command,
            text=True,
            capture_output=True,
            check=False,
        )
        gate_process = {
            "returncode": process.returncode,
            "stdout_tail": tail(process.stdout),
            "stderr_tail": tail(process.stderr),
        }
        if process.returncode != 0:
            errors.append("real-repo issue gate summary failed")
        elif args.gate_output.exists():
            gate_result = read_json(args.gate_output)
        else:
            errors.append(f"gate output was not written: {args.gate_output}")

    status = status_from_state(
        errors,
        report_supplied,
        any_report_supplied,
        gate_result,
    )
    admission = {
        "schema": "trajectory-memory-ledger.real_repo_official_result_admission.v1",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "status": status,
        "claim_boundary": (
            "This admission step verifies scorer input identity and summarizes "
            "official reports when present. It does not run SWE-bench and does "
            "not create performance evidence without official reports."
        ),
        "handoff_dir": str(args.handoff_dir),
        "input_paths": {key: str(path) for key, path in input_paths.items()},
        "handoff_fingerprints": fingerprint_report,
        "expected_reports": {key: str(path) for key, path in expected_reports.items()},
        "report_presence": report_presence,
        "official_reports_present": report_supplied,
        "all_official_reports_present": report_supplied,
        "any_official_report_present": any_report_supplied,
        "missing_reports": [
            str(path) for path in expected_reports.values() if not path.exists()
        ],
        "partial_report_summaries": partial_report_summaries,
        "failure_evidence": failure_evidence,
        "gate_output": str(args.gate_output),
        "gate_output_fingerprint": file_fingerprint(args.gate_output)
        if args.gate_output.exists()
        else None,
        "gate_command": gate_command,
        "gate_process": gate_process,
        "gate_performance_claim": gate_result.get("performance_claim")
        if gate_result
        else None,
        "gate_comparison": gate_result.get("comparison") if gate_result else None,
        "errors": errors,
        "warnings": warnings,
        "ran_official_harness": False,
        "performance_claim_allowed": bool(
            gate_result and gate_result.get("performance_claim", {}).get("allowed")
        ),
        "next_gate": next_gate(status),
    }
    write_json(args.report, admission)
    print(
        json.dumps(
            {
                "status": status,
                "official_reports_present": report_supplied,
                "errors": errors,
            },
            indent=2,
        )
    )
    return 2 if errors else 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--handoff-dir", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--base-report", type=Path)
    parser.add_argument("--planner-report", type=Path)
    parser.add_argument("--gate-output", type=Path)
    parser.add_argument("--dataset-name", default="princeton-nlp/SWE-bench_Verified")
    parser.add_argument("--split", default="test")
    parser.add_argument("--subset-label", default="verified-mini-or-frozen-subset")
    parser.add_argument("--base-run-id", default="tml_base_real_repo_gate")
    parser.add_argument("--planner-run-id", default="tml_planner_real_repo_gate")
    parser.add_argument("--report-dir", default="evaluation_results")
    parser.add_argument(
        "--failure-log-dir",
        action="append",
        type=Path,
        default=[],
        help=(
            "Optional private log directory to fingerprint and classify when an "
            "official report is missing because the scorer failed before tests."
        ),
    )
    parser.add_argument("--minimum-real-instances", type=int, default=50)
    parser.add_argument("--minimum-broad-instances", type=int, default=300)
    return parser.parse_args()


def verify_handoff_fingerprints(
    handoff_dir: Path,
    errors: list[str],
    warnings: list[str],
) -> dict[str, Any]:
    fingerprint_path = handoff_dir / "input-fingerprints.json"
    if not fingerprint_path.exists():
        errors.append(f"missing handoff fingerprint manifest: {fingerprint_path}")
        return {
            "manifest_path": str(fingerprint_path),
            "verified": False,
            "verified_count": 0,
            "inputs": {},
        }
    data = read_json(fingerprint_path)
    inputs = data.get("input_fingerprints")
    if not isinstance(inputs, dict):
        errors.append(f"{fingerprint_path}: missing input_fingerprints object")
        inputs = {}

    missing_keys = sorted(REQUIRED_FINGERPRINT_KEYS - set(inputs))
    extra_keys = sorted(set(inputs) - REQUIRED_FINGERPRINT_KEYS)
    if missing_keys:
        errors.append(f"{fingerprint_path}: missing fingerprint keys {missing_keys}")
    if extra_keys:
        warnings.append(f"{fingerprint_path}: extra fingerprint keys {extra_keys}")

    checked: dict[str, Any] = {}
    verified_count = 0
    for key, expected in sorted(inputs.items()):
        checked[key] = verify_one_fingerprint(handoff_dir, key, expected, errors)
        if checked[key]["verified"]:
            verified_count += 1

    return {
        "manifest_path": str(fingerprint_path),
        "manifest_fingerprint": file_fingerprint(fingerprint_path),
        "verified": not errors and verified_count == len(REQUIRED_FINGERPRINT_KEYS),
        "verified_count": verified_count,
        "inputs": checked,
    }


def verify_one_fingerprint(
    handoff_dir: Path,
    key: str,
    expected: Any,
    errors: list[str],
) -> dict[str, Any]:
    if not isinstance(expected, dict):
        errors.append(f"fingerprint entry for {key} is not an object")
        return {"verified": False, "error": "entry is not an object"}

    relative_path = str(expected.get("relative_path", "")).strip()
    if not relative_path:
        errors.append(f"fingerprint entry for {key} is missing relative_path")
        return {"verified": False, "error": "missing relative_path"}

    path = handoff_dir / relative_path
    if not path.exists():
        errors.append(f"fingerprinted input missing for {key}: {path}")
        return {"verified": False, "path": str(path), "error": "missing path"}

    actual = file_fingerprint(path)
    expected_sha = str(expected.get("sha256", "")).strip()
    expected_size = expected.get("size_bytes")
    verified = actual["sha256"] == expected_sha and actual["size_bytes"] == expected_size
    if not verified:
        errors.append(f"fingerprint mismatch for {key}: {path}")
    return {
        "verified": verified,
        "path": str(path),
        "relative_path": relative_path,
        "expected": {
            "sha256": expected_sha,
            "size_bytes": expected_size,
        },
        "actual": actual,
    }


def build_gate_command(
    args: argparse.Namespace,
    input_paths: dict[str, Path],
    reports: dict[str, Path],
) -> list[str]:
    script = Path(__file__).with_name("prepare_real_repo_issue_gate.py")
    return [
        sys.executable,
        str(script),
        "--dataset-name",
        args.dataset_name,
        "--split",
        args.split,
        "--subset-label",
        args.subset_label,
        "--instances-jsonl",
        str(input_paths["instances_jsonl"]),
        "--base-predictions",
        str(input_paths["base_predictions"]),
        "--planner-predictions",
        str(input_paths["planner_predictions"]),
        "--base-report",
        str(reports["base_agent"]),
        "--planner-report",
        str(reports["base_agent_tml_planner"]),
        "--base-run-id",
        args.base_run_id,
        "--planner-run-id",
        args.planner_run_id,
        "--minimum-real-instances",
        str(args.minimum_real_instances),
        "--minimum-broad-instances",
        str(args.minimum_broad_instances),
        "--output",
        str(args.gate_output),
    ]


def status_from_state(
    errors: list[str],
    report_supplied: bool,
    any_report_supplied: bool,
    gate_result: dict[str, Any] | None,
) -> str:
    if errors:
        return "official_result_admission_failed"
    if any_report_supplied and not report_supplied:
        return "partial_official_reports_waiting_for_counterpart"
    if not report_supplied:
        return "waiting_for_official_reports"
    if not gate_result:
        return "official_result_gate_missing"
    claim = gate_result.get("performance_claim", {})
    if claim.get("allowed"):
        return "official_result_packet_admitted"
    return f"official_result_not_claimable:{claim.get('status', 'unknown')}"


def next_gate(status: str) -> str:
    if status == "waiting_for_official_reports":
        return "Run the fingerprint-locked handoff on a ready SWE-bench scorer, then rerun this admission script with the report paths."
    if status == "partial_official_reports_waiting_for_counterpart":
        return "Keep the valid official report as partial evidence, repair scorer infrastructure, and rerun only the missing counterpart before comparing performance."
    if status == "official_result_packet_admitted":
        return "Review fixed/regressed ids and decide whether TML planner lift justifies scaling to a 50-row Verified Mini run."
    if status.startswith("official_result_not_claimable"):
        return "Treat the official reports as a negative or invalid result; inspect failure families before adapter work."
    return "Repair the admission errors before citing any official result."


def summarize_present_reports(
    reports: dict[str, Path],
    warnings: list[str],
) -> dict[str, Any]:
    summaries: dict[str, Any] = {}
    for label, path in sorted(reports.items()):
        if not path.exists():
            continue
        try:
            data = read_json(path)
        except Exception as exc:
            warnings.append(f"could not summarize report {path}: {type(exc).__name__}: {exc}")
            summaries[label] = {
                "path": str(path),
                "source_fingerprint": file_fingerprint(path),
                "summary_error": f"{type(exc).__name__}: {exc}",
            }
            continue
        summaries[label] = {
            "path": str(path),
            "source_fingerprint": file_fingerprint(path),
            "schema_version": data.get("schema_version"),
            "total_instances": data.get("total_instances"),
            "submitted_instances": data.get("submitted_instances"),
            "completed_instances": data.get("completed_instances"),
            "resolved_instances": data.get("resolved_instances"),
            "unresolved_instances": data.get("unresolved_instances"),
            "empty_patch_instances": data.get("empty_patch_instances"),
            "error_instances": data.get("error_instances"),
            "resolved_ids": extract_string_list(data, "resolved_ids"),
            "unresolved_ids": extract_string_list(data, "unresolved_ids"),
            "error_ids": extract_string_list(data, "error_ids"),
        }
    return summaries


def collect_failure_evidence(log_dirs: list[Path]) -> list[dict[str, Any]]:
    return [summarize_failure_log_dir(path) for path in log_dirs]


def summarize_failure_log_dir(log_dir: Path) -> dict[str, Any]:
    logs = sorted(log_dir.rglob("*.log")) if log_dir.exists() else []
    markers: dict[str, int] = {}
    affected_instances: set[str] = set()
    fingerprints: dict[str, dict[str, Any]] = {}

    marker_patterns = {
        "docker_api_error": "docker.errors.",
        "docker_http_500": "500 Server Error",
        "docker_image_not_found": "ImageNotFound",
        "docker_no_such_image": "No such image",
        "swebench_build_image_error": "BuildImageError",
        "containerd_io_error": "input/output error",
        "containerd_metadata_write_error": "io.containerd.metadata",
    }
    for log_path in logs:
        fingerprints[str(log_path)] = file_fingerprint(log_path)
        affected_instances.add(log_path.parent.name)
        text = log_path.read_text(encoding="utf-8", errors="replace")
        for marker, pattern in marker_patterns.items():
            if pattern in text:
                markers[marker] = markers.get(marker, 0) + 1

    classified_as = "unknown"
    if "containerd_io_error" in markers or "containerd_metadata_write_error" in markers:
        classified_as = "docker_containerd_io_error_before_tests"
    elif "swebench_build_image_error" in markers:
        classified_as = "swebench_docker_image_build_or_pull_failure_before_tests"

    return {
        "log_dir": str(log_dir),
        "exists": log_dir.exists(),
        "log_count": len(logs),
        "log_fingerprints": fingerprints,
        "affected_instance_ids": sorted(affected_instances),
        "infra_failure_markers": sorted(markers),
        "marker_counts": markers,
        "classified_as": classified_as,
        "public_summary": (
            "The missing official report is treated as infrastructure failure "
            "evidence only. These logs are not interpreted as model failures or "
            "issue-resolution results."
        ),
    }


def extract_string_list(data: dict[str, Any], key: str) -> list[str]:
    value = data.get(key)
    if not isinstance(value, list):
        return []
    return [str(item) for item in value if str(item).strip()]


def read_json(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        raise SystemExit(f"{path}: expected JSON object")
    return data


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


def tail(text: str, max_chars: int = 4000) -> str:
    return text[-max_chars:] if len(text) > max_chars else text


if __name__ == "__main__":
    raise SystemExit(main())
