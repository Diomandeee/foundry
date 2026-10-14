#!/usr/bin/env python3
"""Check whether this machine can run the real-repo issue gate."""

from __future__ import annotations

import argparse
import importlib.util
import json
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def main() -> int:
    args = parse_args()
    usage = shutil.disk_usage(args.workspace)
    free_gb = usage.free / (1024**3)
    docker_path = shutil.which("docker")
    docker_info = check_docker_info(docker_path)
    swebench_importable = importlib.util.find_spec("swebench") is not None
    datasets_importable = importlib.util.find_spec("datasets") is not None

    prediction_inputs = {
        "instances_jsonl": path_status(args.instances_jsonl),
        "base_predictions": path_status(args.base_predictions),
        "planner_predictions": path_status(args.planner_predictions),
    }

    blockers: list[str] = []
    warnings: list[str] = []
    if free_gb < args.min_free_gb:
        blockers.append(
            f"free disk {free_gb:.2f} GiB below required {args.min_free_gb:.2f} GiB"
        )
    if docker_path is None:
        blockers.append("docker executable not found")
    elif not docker_info["ok"]:
        blockers.append(f"docker info failed: {docker_info['error']}")
    if not swebench_importable:
        blockers.append("python module 'swebench' is not importable")
    if not datasets_importable:
        warnings.append("python module 'datasets' is not importable; manifest fetching can still use HTTP")

    missing_prediction_inputs = [
        label for label, status in prediction_inputs.items() if not status["exists"]
    ]
    if missing_prediction_inputs:
        warnings.append(
            "prediction inputs are not all present yet: " + ", ".join(missing_prediction_inputs)
        )

    if blockers:
        status = "blocked_local_official_harness_unavailable"
    elif missing_prediction_inputs:
        status = "environment_ready_waiting_for_predictions"
    else:
        status = "ready_for_official_harness"

    report = {
        "schema": "trajectory-memory-ledger.real_repo_gate_env_preflight.v1",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "status": status,
        "workspace": str(args.workspace),
        "free_disk_gb": round(free_gb, 3),
        "min_free_disk_gb": args.min_free_gb,
        "docker": {
            "path": docker_path,
            "info_ok": docker_info["ok"],
            "error": docker_info["error"],
        },
        "python_modules": {
            "swebench": swebench_importable,
            "datasets": datasets_importable,
        },
        "prediction_inputs": prediction_inputs,
        "blockers": blockers,
        "warnings": warnings,
        "ran_official_harness": False,
        "performance_claim_allowed": False,
        "claim_boundary": (
            "This preflight only checks local execution readiness. It is not a "
            "SWE-bench harness run and cannot prove planner performance."
        ),
    }
    write_json(args.output, report)
    print(json.dumps(report, indent=2, sort_keys=True))
    if args.fail_on_blocked and blockers:
        return 2
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace", type=Path, default=Path("."))
    parser.add_argument("--min-free-gb", type=float, default=10.0)
    parser.add_argument(
        "--instances-jsonl",
        type=Path,
        default=Path("examples/evaluation/swebench-verified-mini-public-manifest-2026-06-11.jsonl"),
    )
    parser.add_argument(
        "--base-predictions",
        type=Path,
        default=Path("output/private-swebench/base-agent.predictions.jsonl"),
    )
    parser.add_argument(
        "--planner-predictions",
        type=Path,
        default=Path("output/private-swebench/tml-planner.predictions.jsonl"),
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("benchmarks/real-repo-issue-gate-local-preflight-2026-06-11.json"),
    )
    parser.add_argument("--fail-on-blocked", action="store_true")
    return parser.parse_args()


def check_docker_info(docker_path: str | None) -> dict[str, Any]:
    if docker_path is None:
        return {"ok": False, "error": "docker executable not found"}
    try:
        result = subprocess.run(
            [docker_path, "info", "--format", "{{json .}}"],
            text=True,
            capture_output=True,
            timeout=15,
            check=False,
        )
    except Exception as exc:  # pragma: no cover - defensive environment check
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
    if result.returncode != 0:
        error = (result.stderr or result.stdout or "unknown docker error").strip()
        return {"ok": False, "error": error[:500]}
    return {"ok": True, "error": None}


def path_status(path: Path) -> dict[str, Any]:
    return {
        "path": str(path),
        "exists": path.exists(),
        "size_bytes": path.stat().st_size if path.exists() else None,
    }


def write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2, sort_keys=True)
        handle.write("\n")


if __name__ == "__main__":
    raise SystemExit(main())
