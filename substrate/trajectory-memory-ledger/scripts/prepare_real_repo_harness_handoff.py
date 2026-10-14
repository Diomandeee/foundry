#!/usr/bin/env python3
"""Create a private handoff bundle for official SWE-bench scoring.

This script does not run the harness and does not claim performance. It copies
validated manifest/prediction inputs into an ignored private directory, writes
the exact official harness commands, and emits a public metadata report that
contains no patch text.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import shlex
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


FORBIDDEN_MANIFEST_FIELDS = {"patch", "test_patch", "FAIL_TO_PASS", "PASS_TO_PASS"}


def main() -> int:
    args = parse_args()
    manifest_rows = read_jsonl(args.instances_jsonl)
    base_rows = read_jsonl(args.base_predictions)
    planner_rows = read_jsonl(args.planner_predictions)
    validate_manifest(manifest_rows, args.instances_jsonl)
    validate_predictions(base_rows, args.base_predictions)
    validate_predictions(planner_rows, args.planner_predictions)

    manifest_ids = ordered_ids(manifest_rows)
    base_ids = ordered_ids(base_rows)
    planner_ids = ordered_ids(planner_rows)
    errors: list[str] = []
    warnings: list[str] = []
    if set(base_ids) != set(planner_ids):
        errors.append("base and planner predictions do not contain the same instance ids")
    missing_base = sorted(set(manifest_ids) - set(base_ids))
    missing_planner = sorted(set(manifest_ids) - set(planner_ids))
    extra_base = sorted(set(base_ids) - set(manifest_ids))
    extra_planner = sorted(set(planner_ids) - set(manifest_ids))
    if missing_base:
        errors.append(f"base predictions missing manifest ids: {missing_base}")
    if missing_planner:
        errors.append(f"planner predictions missing manifest ids: {missing_planner}")
    if extra_base:
        errors.append(f"base predictions contain non-manifest ids: {extra_base}")
    if extra_planner:
        errors.append(f"planner predictions contain non-manifest ids: {extra_planner}")

    model_names = {
        "base": sorted({str(row["model_name_or_path"]) for row in base_rows}),
        "planner": sorted({str(row["model_name_or_path"]) for row in planner_rows}),
    }
    same_model = model_names["base"] == model_names["planner"]
    if not same_model:
        warnings.append("base and planner model_name_or_path values differ")

    args.output_dir.mkdir(parents=True, exist_ok=True)
    input_dir = args.output_dir / "inputs"
    input_dir.mkdir(parents=True, exist_ok=True)
    bundle_paths = {
        "instances_jsonl": input_dir / "instances.jsonl",
        "base_predictions": input_dir / "base-agent.predictions.jsonl",
        "planner_predictions": input_dir / "tml-planner.predictions.jsonl",
    }
    shutil.copyfile(args.instances_jsonl, bundle_paths["instances_jsonl"])
    shutil.copyfile(args.base_predictions, bundle_paths["base_predictions"])
    shutil.copyfile(args.planner_predictions, bundle_paths["planner_predictions"])

    fingerprints = build_bundle_fingerprints(args.output_dir, bundle_paths)
    fingerprint_path = args.output_dir / "input-fingerprints.json"
    write_json(fingerprint_path, fingerprints)

    ids_for_harness = manifest_ids
    harness_commands = build_harness_commands(args, bundle_paths, ids_for_harness)
    summarize_command = build_summarize_command(args, bundle_paths)
    write_runner(
        args.output_dir / "run_official_harness.sh",
        harness_commands,
        summarize_command,
        fingerprint_path,
    )
    write_readme(
        args.output_dir / "README.md",
        args,
        ids_for_harness,
        harness_commands,
        summarize_command,
        fingerprint_path,
    )

    env = environment_status(args.workspace)
    status = "handoff_ready_waiting_for_official_harness"
    if errors:
        status = "handoff_input_validation_failed"
    report = {
        "schema": "trajectory-memory-ledger.real_repo_harness_handoff.v1",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "status": status,
        "claim_boundary": (
            "This handoff only packages prediction inputs and official harness commands. "
            "It does not run SWE-bench and cannot prove planner performance."
        ),
        "dataset_name": args.dataset_name,
        "split": args.split,
        "subset_label": args.subset_label,
        "instance_count": len(ids_for_harness),
        "instance_ids": ids_for_harness,
        "same_prediction_instance_ids": set(base_ids) == set(planner_ids),
        "same_model_names_recorded": same_model,
        "model_names": model_names,
        "input_paths": {
            "instances_jsonl": str(args.instances_jsonl),
            "base_predictions": str(args.base_predictions),
            "planner_predictions": str(args.planner_predictions),
        },
        "private_handoff_dir": str(args.output_dir),
        "private_bundle_paths": {key: str(path) for key, path in bundle_paths.items()},
        "input_fingerprints": fingerprints["input_fingerprints"],
        "fingerprint_manifest_path": str(fingerprint_path),
        "runner_path": str(args.output_dir / "run_official_harness.sh"),
        "harness_commands": harness_commands,
        "summarize_command": summarize_command,
        "environment_status": env,
        "errors": errors,
        "warnings": warnings,
        "ran_official_harness": False,
        "performance_claim_allowed": False,
        "next_gate": "Run the private handoff runner on a Docker machine with enough disk, then summarize official reports.",
    }
    write_json(args.report, report)
    print(json.dumps({"status": status, "instance_count": len(ids_for_harness), "errors": errors}, indent=2))
    return 2 if errors else 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--instances-jsonl", type=Path, required=True)
    parser.add_argument("--base-predictions", type=Path, required=True)
    parser.add_argument("--planner-predictions", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--dataset-name", default="princeton-nlp/SWE-bench_Verified")
    parser.add_argument("--split", default="test")
    parser.add_argument("--subset-label", default="verified-mini-or-frozen-subset")
    parser.add_argument("--base-run-id", default="tml_base_real_repo_gate")
    parser.add_argument("--planner-run-id", default="tml_planner_real_repo_gate")
    parser.add_argument("--max-workers", type=int, default=1)
    parser.add_argument("--timeout", type=int, default=1800)
    parser.add_argument("--report-dir", default="evaluation_results")
    parser.add_argument("--namespace", default=None)
    parser.add_argument("--workspace", type=Path, default=Path("."))
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
        raise SystemExit(f"{path}: no rows")
    return rows


def validate_manifest(rows: list[dict[str, Any]], path: Path) -> None:
    seen: set[str] = set()
    for line_no, row in enumerate(rows, 1):
        forbidden = FORBIDDEN_MANIFEST_FIELDS & set(row)
        if forbidden:
            raise SystemExit(f"{path}:{line_no}: forbidden fields present {sorted(forbidden)}")
        instance_id = str(row.get("instance_id", "")).strip()
        if not instance_id:
            raise SystemExit(f"{path}:{line_no}: missing instance_id")
        if instance_id in seen:
            raise SystemExit(f"{path}:{line_no}: duplicate instance_id {instance_id}")
        seen.add(instance_id)


def validate_predictions(rows: list[dict[str, Any]], path: Path) -> None:
    seen: set[str] = set()
    for line_no, row in enumerate(rows, 1):
        for key in ("instance_id", "model_name_or_path", "model_patch"):
            if key not in row:
                raise SystemExit(f"{path}:{line_no}: missing {key}")
        instance_id = str(row["instance_id"]).strip()
        if not instance_id:
            raise SystemExit(f"{path}:{line_no}: empty instance_id")
        if instance_id in seen:
            raise SystemExit(f"{path}:{line_no}: duplicate instance_id {instance_id}")
        seen.add(instance_id)
        if not isinstance(row["model_patch"], str):
            raise SystemExit(f"{path}:{line_no}: model_patch must be a string")
        if not row["model_patch"].strip():
            raise SystemExit(f"{path}:{line_no}: empty model_patch")


def ordered_ids(rows: list[dict[str, Any]]) -> list[str]:
    return [str(row["instance_id"]).strip() for row in rows]


def build_bundle_fingerprints(
    output_dir: Path,
    bundle_paths: dict[str, Path],
) -> dict[str, Any]:
    return {
        "schema": "trajectory-memory-ledger.real_repo_handoff_fingerprints.v1",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "claim_boundary": (
            "Fingerprints bind a future scorer run to these exact handoff inputs. "
            "They are not performance evidence."
        ),
        "input_fingerprints": {
            key: file_fingerprint(path, root=output_dir)
            for key, path in sorted(bundle_paths.items())
        },
    }


def build_harness_commands(
    args: argparse.Namespace,
    bundle_paths: dict[str, Path],
    instance_ids: list[str],
) -> dict[str, str]:
    def command(predictions: Path, run_id: str) -> str:
        parts = [
            "python",
            "-m",
            "swebench.harness.run_evaluation",
            "--dataset_name",
            args.dataset_name,
            "--split",
            args.split,
            "--predictions_path",
            str(predictions),
            "--max_workers",
            str(args.max_workers),
            "--timeout",
            str(args.timeout),
            "--run_id",
            run_id,
            "--report_dir",
            args.report_dir,
        ]
        if instance_ids:
            parts.extend(["--instance_ids", *instance_ids])
        if args.namespace is not None:
            parts.extend(["--namespace", args.namespace])
        return " ".join(shlex.quote(part) for part in parts)

    return {
        "base_agent": command(bundle_paths["base_predictions"], args.base_run_id),
        "base_agent_tml_planner": command(
            bundle_paths["planner_predictions"], args.planner_run_id
        ),
    }


def build_summarize_command(args: argparse.Namespace, bundle_paths: dict[str, Path]) -> str:
    parts = [
        "python3",
        "scripts/prepare_real_repo_issue_gate.py",
        "--dataset-name",
        args.dataset_name,
        "--split",
        args.split,
        "--subset-label",
        args.subset_label,
        "--instances-jsonl",
        str(bundle_paths["instances_jsonl"]),
        "--base-predictions",
        str(bundle_paths["base_predictions"]),
        "--planner-predictions",
        str(bundle_paths["planner_predictions"]),
        "--base-report",
        str(Path(args.report_dir) / args.base_run_id),
        "--planner-report",
        str(Path(args.report_dir) / args.planner_run_id),
        "--output",
        f"benchmarks/real-repo-issue-gate-{args.subset_label}.json",
    ]
    return " ".join(shlex.quote(part) for part in parts)


def write_runner(
    path: Path,
    harness_commands: dict[str, str],
    summarize_command: str,
    fingerprint_path: Path,
) -> None:
    text = "\n".join(
        [
            "#!/usr/bin/env bash",
            "set -euo pipefail",
            'SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
            'REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"',
            'cd "$REPO_ROOT"',
            "",
            "echo '[tml] verifying handoff input fingerprints'",
            f"python3 - \"$SCRIPT_DIR/{fingerprint_path.name}\" <<'PY'",
            "import hashlib, json, sys",
            "from pathlib import Path",
            "",
            "fingerprint_path = Path(sys.argv[1])",
            "bundle_root = fingerprint_path.parent",
            "fingerprints = json.loads(fingerprint_path.read_text(encoding='utf-8'))",
            "",
            "def sha256_file(path):",
            "    digest = hashlib.sha256()",
            "    with path.open('rb') as handle:",
            "        for chunk in iter(lambda: handle.read(1024 * 1024), b''):",
            "            digest.update(chunk)",
            "    return digest.hexdigest()",
            "",
            "for label, expected in sorted(fingerprints['input_fingerprints'].items()):",
            "    path = bundle_root / expected['relative_path']",
            "    actual_size = path.stat().st_size",
            "    actual_hash = sha256_file(path)",
            "    if actual_size != expected['size_bytes'] or actual_hash != expected['sha256']:",
            "        raise SystemExit(f'fingerprint mismatch for {label}: {path}')",
            "print('[tml] handoff fingerprints verified')",
            "PY",
            "",
            "echo '[tml] running base official harness'",
            harness_commands["base_agent"],
            "",
            "echo '[tml] running planner official harness'",
            harness_commands["base_agent_tml_planner"],
            "",
            "echo '[tml] summarizing official harness reports'",
            summarize_command,
            "",
        ]
    )
    path.write_text(text, encoding="utf-8")
    os.chmod(path, 0o755)


def write_readme(
    path: Path,
    args: argparse.Namespace,
    instance_ids: list[str],
    harness_commands: dict[str, str],
    summarize_command: str,
    fingerprint_path: Path,
) -> None:
    text = "\n".join(
        [
            "# TML Real-Repo Harness Handoff",
            "",
            "This private bundle contains prediction JSONL files for official SWE-bench scoring.",
            "It is not a performance result until the harness has produced reports.",
            "",
            f"Dataset: `{args.dataset_name}`",
            f"Split: `{args.split}`",
            f"Subset: `{args.subset_label}`",
            f"Instances: `{', '.join(instance_ids)}`",
            f"Input fingerprints: `{fingerprint_path}`",
            "",
            "Run both conditions:",
            "",
            "```bash",
            "./run_official_harness.sh",
            "```",
            "",
            "Base command:",
            "",
            "```bash",
            harness_commands["base_agent"],
            "```",
            "",
            "Planner command:",
            "",
            "```bash",
            harness_commands["base_agent_tml_planner"],
            "```",
            "",
            "Summarize after reports exist:",
            "",
            "```bash",
            summarize_command,
            "```",
            "",
        ]
    )
    path.write_text(text, encoding="utf-8")


def environment_status(workspace: Path) -> dict[str, Any]:
    usage = shutil.disk_usage(workspace)
    docker_path = shutil.which("docker")
    swebench = importlib.util.find_spec("swebench") is not None
    docker_info = None
    docker_error = None
    if docker_path:
        result = subprocess.run(
            [docker_path, "info", "--format", "{{json .ServerVersion}}"],
            text=True,
            capture_output=True,
            timeout=15,
            check=False,
        )
        if result.returncode == 0:
            docker_info = result.stdout.strip()
        else:
            docker_error = (result.stderr or result.stdout).strip()[:500]
    return {
        "workspace": str(workspace),
        "free_disk_gb": round(usage.free / (1024**3), 3),
        "docker_path": docker_path,
        "docker_server_version": docker_info,
        "docker_error": docker_error,
        "swebench_importable": swebench,
    }


def write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2, sort_keys=True)
        handle.write("\n")


def file_fingerprint(path: Path, *, root: Path | None = None) -> dict[str, Any]:
    data = {
        "path": str(path),
        "size_bytes": path.stat().st_size,
        "sha256": sha256_file(path),
    }
    if root is not None:
        data["relative_path"] = path.relative_to(root).as_posix()
    return data


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


if __name__ == "__main__":
    raise SystemExit(main())
