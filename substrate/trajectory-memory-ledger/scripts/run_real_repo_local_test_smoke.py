#!/usr/bin/env python3
"""Run a narrow local test smoke for generated real-repo predictions.

This script is intentionally not a SWE-bench harness replacement. It runs an
explicit command in already-prepared private worktrees and records whether that
local public test command passes. It does not run hidden tests, Docker, or the
official SWE-bench evaluator.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


CONDITIONS = ["base_agent", "base_agent_tml_planner"]


def main() -> int:
    args = parse_args()
    worktrees = {
        "base_agent": args.base_worktree,
        "base_agent_tml_planner": args.planner_worktree,
    }
    for condition, worktree in worktrees.items():
        if not worktree.exists():
            raise SystemExit(f"{condition} worktree not found: {worktree}")

    results: dict[str, Any] = {}
    for condition in CONDITIONS:
        results[condition] = run_condition(condition, worktrees[condition], args)

    pass_count = sum(1 for result in results.values() if result["passed"])
    status = "local_test_smoke_passed" if pass_count == len(CONDITIONS) else "local_test_smoke_failed"
    report = {
        "schema": "trajectory-memory-ledger.real_repo_local_test_smoke.v1",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "status": status,
        "claim_boundary": (
            "This is a narrow local public-test smoke. It does not run Docker, "
            "hidden tests, or the official SWE-bench harness, and cannot prove "
            "issue resolution."
        ),
        "instance_id": args.instance_id,
        "repo": args.repo,
        "conditions": results,
        "test_labels": args.test_label,
        "dependency_paths": [str(path) for path in args.dependency_path],
        "command_template": args.command_template,
        "condition_pass_count": pass_count,
        "condition_count": len(CONDITIONS),
        "all_conditions_passed": pass_count == len(CONDITIONS),
        "ran_official_harness": False,
        "ran_repository_full_test_suite": False,
        "ran_hidden_tests": False,
        "performance_claim_allowed": False,
    }
    write_json(args.report, report)
    print(json.dumps({"status": status, "condition_pass_count": pass_count}, indent=2))
    return 0 if pass_count == len(CONDITIONS) else 2


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--instance-id", required=True)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--base-worktree", type=Path, required=True)
    parser.add_argument("--planner-worktree", type=Path, required=True)
    parser.add_argument("--dependency-path", type=Path, action="append", default=[])
    parser.add_argument("--test-label", action="append", required=True)
    parser.add_argument(
        "--command-template",
        default="{python} tests/runtests.py {test_labels} --verbosity 2",
        help="Template fields: python, test_labels.",
    )
    parser.add_argument("--python", default="python3.11")
    parser.add_argument("--timeout-s", type=int, default=300)
    parser.add_argument("--report", type=Path, required=True)
    return parser.parse_args()


def run_condition(condition: str, worktree: Path, args: argparse.Namespace) -> dict[str, Any]:
    worktree = worktree.resolve()
    env = os.environ.copy()
    pythonpath_parts = [str(worktree), *[str(path.resolve()) for path in args.dependency_path]]
    existing_pythonpath = env.get("PYTHONPATH")
    if existing_pythonpath:
        pythonpath_parts.append(existing_pythonpath)
    env["PYTHONPATH"] = os.pathsep.join(pythonpath_parts)
    command = args.command_template.format(
        python=args.python,
        test_labels=" ".join(args.test_label),
    )
    started = time.monotonic()
    result = subprocess.run(
        command,
        shell=True,
        cwd=str(worktree),
        env=env,
        text=True,
        capture_output=True,
        timeout=args.timeout_s,
        check=False,
    )
    duration = time.monotonic() - started
    return {
        "condition": condition,
        "worktree": str(worktree),
        "command": command,
        "returncode": result.returncode,
        "duration_s": round(duration, 3),
        "passed": result.returncode == 0,
        "stdout_tail": tail(result.stdout),
        "stderr_tail": tail(result.stderr),
    }


def tail(text: str, max_chars: int = 4000) -> str:
    return text[-max_chars:] if len(text) > max_chars else text


def write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2, sort_keys=True)
        handle.write("\n")


if __name__ == "__main__":
    raise SystemExit(main())
