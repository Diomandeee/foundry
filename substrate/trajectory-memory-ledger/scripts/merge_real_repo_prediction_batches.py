#!/usr/bin/env python3
"""Merge private real-repo prediction batches into one scorer input set.

The merged prediction JSONL files remain private. The public report records
counts, instance ids, and fingerprints only, with no patch text.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


CONDITIONS = {
    "base_agent": "base-agent.predictions.jsonl",
    "base_agent_tml_planner": "tml-planner.predictions.jsonl",
}
FORBIDDEN_MANIFEST_FIELDS = {"patch", "test_patch", "FAIL_TO_PASS", "PASS_TO_PASS"}


def main() -> int:
    args = parse_args()
    manifest_rows = read_manifest(args.instances_jsonl)
    manifest_by_id = {str(row["instance_id"]): row for row in manifest_rows}

    merged: dict[str, dict[str, dict[str, Any]]] = {
        condition: {} for condition in CONDITIONS
    }
    source_reports: dict[str, Any] = {}
    for batch_dir in args.batch_dir:
        source_reports[str(batch_dir)] = {}
        for condition, filename in CONDITIONS.items():
            path = batch_dir / filename
            rows = read_predictions(path)
            source_reports[str(batch_dir)][condition] = {
                "path": str(path),
                "fingerprint": file_fingerprint(path),
                "prediction_count": len(rows),
                "instance_ids": [str(row["instance_id"]) for row in rows],
            }
            for row in rows:
                instance_id = str(row["instance_id"])
                existing = merged[condition].get(instance_id)
                if existing is not None and existing != row:
                    raise SystemExit(f"conflicting duplicate {condition} prediction for {instance_id}")
                merged[condition][instance_id] = row

    base_ids = set(merged["base_agent"])
    planner_ids = set(merged["base_agent_tml_planner"])
    if base_ids != planner_ids:
        raise SystemExit(
            "base/planner merged ids differ: "
            f"base_only={sorted(base_ids - planner_ids)} planner_only={sorted(planner_ids - base_ids)}"
        )

    missing_manifest = sorted(base_ids - set(manifest_by_id))
    if missing_manifest:
        raise SystemExit(f"prediction ids missing from manifest: {missing_manifest}")

    selected_ids = [str(row["instance_id"]) for row in manifest_rows if str(row["instance_id"]) in base_ids]
    args.output_dir.mkdir(parents=True, exist_ok=True)
    output_paths = {
        condition: args.output_dir / filename for condition, filename in CONDITIONS.items()
    }
    for condition, path in output_paths.items():
        write_jsonl(path, [merged[condition][instance_id] for instance_id in selected_ids])

    subset_manifest_path = args.output_dir / "instances.jsonl"
    write_jsonl(subset_manifest_path, [manifest_by_id[instance_id] for instance_id in selected_ids])
    if args.public_manifest_output:
        shutil.copyfile(subset_manifest_path, args.public_manifest_output)

    report = {
        "schema": "trajectory-memory-ledger.real_repo_prediction_batch_merge.v1",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "status": "merged_predictions_ready",
        "claim_boundary": (
            "Merged predictions are scorer inputs only. This does not run "
            "SWE-bench and cannot prove issue resolution."
        ),
        "source_batches": source_reports,
        "output_dir": str(args.output_dir),
        "public_manifest_output": str(args.public_manifest_output)
        if args.public_manifest_output
        else None,
        "instance_count": len(selected_ids),
        "instance_ids": selected_ids,
        "conditions": {
            condition: {
                "path": str(path),
                "fingerprint": file_fingerprint(path),
                "prediction_count": len(merged[condition]),
            }
            for condition, path in output_paths.items()
        },
        "subset_manifest": file_fingerprint(subset_manifest_path),
        "same_prediction_instance_ids": True,
        "ran_official_harness": False,
        "performance_claim_allowed": False,
    }
    write_json(args.report, report)
    print(json.dumps({"status": report["status"], "instance_count": len(selected_ids)}, indent=2))
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--instances-jsonl", type=Path, required=True)
    parser.add_argument("--batch-dir", action="append", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--public-manifest-output", type=Path)
    return parser.parse_args()


def read_manifest(path: Path) -> list[dict[str, Any]]:
    rows = read_jsonl(path)
    seen: set[str] = set()
    for line_no, row in enumerate(rows, 1):
        forbidden = FORBIDDEN_MANIFEST_FIELDS & set(row)
        if forbidden:
            raise SystemExit(f"{path}:{line_no}: forbidden manifest fields {sorted(forbidden)}")
        instance_id = str(row.get("instance_id", "")).strip()
        if not instance_id:
            raise SystemExit(f"{path}:{line_no}: missing instance_id")
        if instance_id in seen:
            raise SystemExit(f"{path}:{line_no}: duplicate instance_id {instance_id}")
        seen.add(instance_id)
    return rows


def read_predictions(path: Path) -> list[dict[str, Any]]:
    rows = read_jsonl(path)
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
        if not isinstance(row["model_patch"], str) or not row["model_patch"].strip():
            raise SystemExit(f"{path}:{line_no}: model_patch must be a non-empty string")
        seen.add(instance_id)
    return rows


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
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


def write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for row in rows:
            json.dump(row, handle, sort_keys=True)
            handle.write("\n")


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
