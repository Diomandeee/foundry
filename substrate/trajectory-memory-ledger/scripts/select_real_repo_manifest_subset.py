#!/usr/bin/env python3
"""Select a public-safe real-repo manifest subset.

The selector is intentionally public-safe: it rejects gold patches, test
patches, and oracle fields. It is useful for creating small incremental
prediction batches without changing already fingerprinted handoff inputs.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


FORBIDDEN_FIELDS = {"patch", "test_patch", "FAIL_TO_PASS", "PASS_TO_PASS"}


def main() -> int:
    args = parse_args()
    rows = read_manifest(args.input)
    excluded_ids = set(args.exclude_instance_id)
    for predictions_path in args.exclude_predictions:
        excluded_ids.update(read_prediction_ids(predictions_path))

    selected = select_rows(
        rows=rows,
        start_index=args.start_index,
        count=args.count,
        instance_ids=args.instance_id,
        excluded_ids=excluded_ids,
    )
    if not selected:
        raise SystemExit("selection produced no rows")

    write_jsonl(args.output, selected)
    report = {
        "schema": "trajectory-memory-ledger.real_repo_manifest_subset.v1",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "status": "manifest_subset_ready",
        "claim_boundary": (
            "This selects public generation rows only. It does not generate "
            "patches, run tests, or score issue resolution."
        ),
        "input": file_fingerprint(args.input),
        "output": file_fingerprint(args.output),
        "start_index": args.start_index,
        "requested_count": args.count,
        "selected_count": len(selected),
        "selected_instance_ids": [str(row["instance_id"]) for row in selected],
        "excluded_instance_count": len(excluded_ids),
        "forbidden_fields_present": False,
        "performance_claim_allowed": False,
    }
    write_json(args.report, report)
    print(json.dumps({"status": report["status"], "selected_count": len(selected)}, indent=2))
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--start-index", type=int, default=0)
    parser.add_argument("--count", type=int, required=True)
    parser.add_argument("--instance-id", action="append", default=[])
    parser.add_argument("--exclude-instance-id", action="append", default=[])
    parser.add_argument("--exclude-predictions", action="append", type=Path, default=[])
    return parser.parse_args()


def read_manifest(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    with path.open(encoding="utf-8") as handle:
        for line_no, line in enumerate(handle, 1):
            if not line.strip():
                continue
            row = json.loads(line)
            if not isinstance(row, dict):
                raise SystemExit(f"{path}:{line_no}: expected object")
            forbidden = FORBIDDEN_FIELDS & set(row)
            if forbidden:
                raise SystemExit(f"{path}:{line_no}: forbidden fields {sorted(forbidden)}")
            instance_id = str(row.get("instance_id", "")).strip()
            if not instance_id:
                raise SystemExit(f"{path}:{line_no}: missing instance_id")
            if instance_id in seen:
                raise SystemExit(f"{path}:{line_no}: duplicate instance_id {instance_id}")
            seen.add(instance_id)
            rows.append(row)
    if not rows:
        raise SystemExit(f"{path}: no rows")
    return rows


def read_prediction_ids(path: Path) -> set[str]:
    ids: set[str] = set()
    with path.open(encoding="utf-8") as handle:
        for line_no, line in enumerate(handle, 1):
            if not line.strip():
                continue
            row = json.loads(line)
            if not isinstance(row, dict):
                raise SystemExit(f"{path}:{line_no}: expected object")
            instance_id = str(row.get("instance_id", "")).strip()
            if not instance_id:
                raise SystemExit(f"{path}:{line_no}: missing instance_id")
            ids.add(instance_id)
    return ids


def select_rows(
    *,
    rows: list[dict[str, Any]],
    start_index: int,
    count: int,
    instance_ids: list[str],
    excluded_ids: set[str],
) -> list[dict[str, Any]]:
    if count < 1:
        raise SystemExit("--count must be positive")
    if start_index < 0:
        raise SystemExit("--start-index must be non-negative")

    if instance_ids:
        requested = set(instance_ids)
        selected = [
            row
            for row in rows
            if str(row["instance_id"]) in requested and str(row["instance_id"]) not in excluded_ids
        ]
        missing = sorted(requested - {str(row["instance_id"]) for row in selected} - excluded_ids)
        if missing:
            raise SystemExit(f"requested instance ids not found: {missing}")
        return selected[:count]

    candidates = [row for row in rows if str(row["instance_id"]) not in excluded_ids]
    return candidates[start_index : start_index + count]


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
