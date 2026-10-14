#!/usr/bin/env python3
"""Check whether real-repo prediction patches apply to their base commits.

This is a lightweight, non-harness check. It uses a private Git index backed by
the cached mirror repository, so it does not need a full checkout and does not
run tests. It cannot prove issue resolution.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


FORBIDDEN_MANIFEST_FIELDS = {"patch", "test_patch", "FAIL_TO_PASS", "PASS_TO_PASS"}
CONDITIONS = {
    "base_agent": "base_predictions",
    "base_agent_tml_planner": "planner_predictions",
}


def main() -> int:
    args = parse_args()
    instances = read_jsonl(args.instances_jsonl)
    validate_manifest(instances, args.instances_jsonl)
    by_instance = {str(row["instance_id"]): row for row in instances}
    predictions = {
        "base_agent": load_predictions(args.base_predictions),
        "base_agent_tml_planner": load_predictions(args.planner_predictions),
    }
    errors = coverage_errors(by_instance, predictions)

    args.private_dir.mkdir(parents=True, exist_ok=True)
    condition_reports: dict[str, Any] = {}
    for condition, rows_by_id in predictions.items():
        per_instance = []
        for instance_id, row in rows_by_id.items():
            instance = by_instance.get(instance_id)
            if instance is None:
                continue
            per_instance.append(check_patch(condition, instance, row, args))
        pass_count = sum(1 for item in per_instance if item["patch_applies"])
        condition_reports[condition] = {
            "instance_count": len(per_instance),
            "patch_apply_pass_count": pass_count,
            "patch_apply_fail_count": len(per_instance) - pass_count,
            "all_patches_apply": pass_count == len(per_instance),
            "per_instance": per_instance,
        }

    status = "patch_apply_check_failed" if errors else "patch_apply_check_passed"
    for report in condition_reports.values():
        if not report["all_patches_apply"]:
            status = "patch_apply_check_failed"

    report = {
        "schema": "trajectory-memory-ledger.real_repo_prediction_patch_apply.v1",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "status": status,
        "claim_boundary": (
            "Patch-apply checks are not SWE-bench results. They validate whether "
            "model patches apply to the base commit, but they do not run tests or "
            "measure issue resolution."
        ),
        "instances_jsonl": str(args.instances_jsonl),
        "repo_cache_dir": str(args.repo_cache_dir),
        "private_dir": str(args.private_dir),
        "conditions": condition_reports,
        "errors": errors,
        "ran_official_harness": False,
        "ran_repository_tests": False,
        "performance_claim_allowed": False,
    }
    write_json(args.report, report)
    print(json.dumps({"status": status, "errors": errors}, indent=2))
    return 2 if errors else 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--instances-jsonl", type=Path, required=True)
    parser.add_argument("--base-predictions", type=Path, required=True)
    parser.add_argument("--planner-predictions", type=Path, required=True)
    parser.add_argument(
        "--repo-cache-dir",
        type=Path,
        default=Path("output/private-swebench/repo-worktrees/cache"),
    )
    parser.add_argument(
        "--private-dir",
        type=Path,
        default=Path("output/private-swebench/patch-apply-check"),
    )
    parser.add_argument("--report", type=Path, required=True)
    return parser.parse_args()


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows = []
    with path.open(encoding="utf-8") as handle:
        for line_no, line in enumerate(handle, 1):
            if not line.strip():
                continue
            row = json.loads(line)
            if not isinstance(row, dict):
                raise SystemExit(f"{path}:{line_no}: expected object")
            rows.append(row)
    if not rows:
        raise SystemExit(f"{path}: no rows")
    return rows


def validate_manifest(rows: list[dict[str, Any]], path: Path) -> None:
    seen: set[str] = set()
    for line_no, row in enumerate(rows, 1):
        forbidden = FORBIDDEN_MANIFEST_FIELDS & set(row)
        if forbidden:
            raise SystemExit(f"{path}:{line_no}: forbidden eval fields {sorted(forbidden)}")
        for field in ("instance_id", "repo", "base_commit"):
            if not str(row.get(field, "")).strip():
                raise SystemExit(f"{path}:{line_no}: missing {field}")
        instance_id = str(row["instance_id"])
        if instance_id in seen:
            raise SystemExit(f"{path}:{line_no}: duplicate instance_id {instance_id}")
        seen.add(instance_id)


def load_predictions(path: Path) -> dict[str, dict[str, Any]]:
    rows = read_jsonl(path)
    by_id: dict[str, dict[str, Any]] = {}
    for line_no, row in enumerate(rows, 1):
        for field in ("instance_id", "model_name_or_path", "model_patch"):
            if field not in row:
                raise SystemExit(f"{path}:{line_no}: missing {field}")
        instance_id = str(row["instance_id"]).strip()
        patch = row["model_patch"]
        if not isinstance(patch, str) or not patch.strip():
            raise SystemExit(f"{path}:{line_no}: empty model_patch")
        if instance_id in by_id:
            raise SystemExit(f"{path}:{line_no}: duplicate instance_id {instance_id}")
        by_id[instance_id] = row
    return by_id


def coverage_errors(
    by_instance: dict[str, dict[str, Any]],
    predictions: dict[str, dict[str, dict[str, Any]]],
) -> list[str]:
    errors: list[str] = []
    manifest_ids = set(by_instance)
    for condition, rows_by_id in predictions.items():
        pred_ids = set(rows_by_id)
        missing = sorted(manifest_ids - pred_ids)
        extra = sorted(pred_ids - manifest_ids)
        if missing:
            errors.append(f"{condition} missing manifest ids: {missing}")
        if extra:
            errors.append(f"{condition} has non-manifest ids: {extra}")
    if set(predictions["base_agent"]) != set(predictions["base_agent_tml_planner"]):
        errors.append("base and planner predictions have different instance ids")
    return errors


def check_patch(
    condition: str,
    instance: dict[str, Any],
    prediction: dict[str, Any],
    args: argparse.Namespace,
) -> dict[str, Any]:
    instance_id = str(instance["instance_id"])
    repo = str(instance["repo"])
    base_commit = str(instance["base_commit"])
    patch = str(prediction["model_patch"])
    repo_cache = args.repo_cache_dir / f"{repo.replace('/', '__')}.git"
    patch_path = args.private_dir / "patches" / condition / f"{safe_name(instance_id)}.patch"
    index_path = args.private_dir / "indexes" / condition / f"{safe_name(instance_id)}.index"
    patch_path.parent.mkdir(parents=True, exist_ok=True)
    index_path.parent.mkdir(parents=True, exist_ok=True)
    patch_path.write_text(patch, encoding="utf-8")

    if not repo_cache.exists():
        return result(
            condition,
            instance_id,
            repo,
            patch,
            False,
            f"missing repo cache: {repo_cache}",
            patch_path,
            index_path,
        )

    env = os.environ.copy()
    env["GIT_INDEX_FILE"] = str(index_path)
    read_tree = run_git(["git", f"--git-dir={repo_cache}", "read-tree", base_commit], env)
    if read_tree.returncode != 0:
        return result(
            condition,
            instance_id,
            repo,
            patch,
            False,
            command_error(read_tree),
            patch_path,
            index_path,
        )
    apply_check = run_git(
        ["git", f"--git-dir={repo_cache}", "apply", "--cached", "--check", str(patch_path)],
        env,
    )
    return result(
        condition,
        instance_id,
        repo,
        patch,
        apply_check.returncode == 0,
        None if apply_check.returncode == 0 else command_error(apply_check),
        patch_path,
        index_path,
    )


def run_git(command: list[str], env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        text=True,
        capture_output=True,
        timeout=120,
        env=env,
        check=False,
    )


def result(
    condition: str,
    instance_id: str,
    repo: str,
    patch: str,
    applies: bool,
    error: str | None,
    patch_path: Path,
    index_path: Path,
) -> dict[str, Any]:
    return {
        "condition": condition,
        "instance_id": instance_id,
        "repo": repo,
        "patch_applies": applies,
        "patch_chars": len(patch),
        "patch_file_count": patch.count("diff --git "),
        "private_patch_path": str(patch_path),
        "private_index_path": str(index_path),
        "error": error,
    }


def command_error(result: subprocess.CompletedProcess[str]) -> str:
    text = (result.stderr or result.stdout or "unknown git error").strip()
    return text[:1000]


def safe_name(value: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_.-]+", "_", value)


def write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2, sort_keys=True)
        handle.write("\n")


if __name__ == "__main__":
    raise SystemExit(main())
