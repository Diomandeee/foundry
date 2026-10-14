#!/usr/bin/env python3
"""Fetch a public-safe SWE-bench Verified Mini manifest.

The manifest is for instance coverage and patch-generation prompts only. It
intentionally omits gold patches, test patches, and fail/pass oracle fields so
it cannot become an accidental generation leak.
"""

from __future__ import annotations

import argparse
import json
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


PUBLIC_FIELDS = [
    "repo",
    "instance_id",
    "base_commit",
    "problem_statement",
    "hints_text",
    "created_at",
    "version",
    "environment_setup_commit",
]

OMITTED_EVAL_FIELDS = ["patch", "test_patch", "FAIL_TO_PASS", "PASS_TO_PASS"]


def main() -> int:
    args = parse_args()
    dataset_meta = fetch_dataset_meta(args.dataset)
    rows_payload = fetch_rows(
        dataset=args.dataset,
        config=args.config,
        split=args.split,
        offset=args.offset,
        length=args.length,
    )
    rows = rows_payload.get("rows")
    if not isinstance(rows, list) or not rows:
        raise SystemExit("datasets-server returned no rows")

    manifest_rows = []
    omitted_seen: set[str] = set()
    for item in rows:
        if not isinstance(item, dict) or not isinstance(item.get("row"), dict):
            raise SystemExit("datasets-server row payload has unexpected shape")
        row = item["row"]
        for field in OMITTED_EVAL_FIELDS:
            if field in row and row[field]:
                omitted_seen.add(field)
        manifest = {field: row.get(field, "") for field in PUBLIC_FIELDS}
        for field in ("repo", "instance_id", "base_commit", "problem_statement"):
            if not str(manifest.get(field, "")).strip():
                raise SystemExit(f"row missing required public field {field}")
        manifest.update(
            {
                "source_dataset": args.dataset,
                "source_dataset_sha": dataset_meta.get("sha"),
                "source_config": args.config,
                "source_split": args.split,
                "source_row_idx": item.get("row_idx"),
                "hidden_eval_fields_omitted": True,
            }
        )
        manifest_rows.append(manifest)

    seen_ids: set[str] = set()
    for row in manifest_rows:
        instance_id = str(row["instance_id"])
        if instance_id in seen_ids:
            raise SystemExit(f"duplicate instance_id {instance_id}")
        seen_ids.add(instance_id)

    write_jsonl(args.output, manifest_rows)
    report = {
        "schema": "trajectory-memory-ledger.swebench_public_manifest.v1",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "status": "public_manifest_ready",
        "dataset": args.dataset,
        "dataset_sha": dataset_meta.get("sha"),
        "config": args.config,
        "split": args.split,
        "offset": args.offset,
        "requested_length": args.length,
        "row_count": len(manifest_rows),
        "output": str(args.output),
        "instance_ids": sorted(seen_ids),
        "public_fields": PUBLIC_FIELDS,
        "omitted_eval_fields": sorted(omitted_seen),
        "hidden_eval_fields_omitted": True,
        "downloaded_repositories": False,
        "ran_official_harness": False,
        "performance_claim_allowed": False,
        "source_urls": {
            "dataset_api": f"https://huggingface.co/api/datasets/{args.dataset}",
            "rows_api": rows_url(args.dataset, args.config, args.split, args.offset, args.length),
        },
        "claim_boundary": (
            "This freezes public instance metadata for generation coverage. It is not a "
            "SWE-bench harness run and does not measure TML planner performance."
        ),
    }
    if args.report:
        write_json(args.report, report)
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", default="MariusHobbhahn/swe-bench-verified-mini")
    parser.add_argument("--config", default="default")
    parser.add_argument("--split", default="test")
    parser.add_argument("--offset", type=int, default=0)
    parser.add_argument("--length", type=int, default=50)
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("examples/evaluation/swebench-verified-mini-public-manifest-2026-06-11.jsonl"),
    )
    parser.add_argument(
        "--report",
        type=Path,
        default=Path("benchmarks/swebench-verified-mini-public-manifest-2026-06-11.json"),
    )
    return parser.parse_args()


def fetch_dataset_meta(dataset: str) -> dict[str, Any]:
    return fetch_json(f"https://huggingface.co/api/datasets/{dataset}")


def fetch_rows(dataset: str, config: str, split: str, offset: int, length: int) -> dict[str, Any]:
    return fetch_json(rows_url(dataset, config, split, offset, length))


def rows_url(dataset: str, config: str, split: str, offset: int, length: int) -> str:
    params = urllib.parse.urlencode(
        {
            "dataset": dataset,
            "config": config,
            "split": split,
            "offset": offset,
            "length": length,
        }
    )
    return f"https://datasets-server.huggingface.co/rows?{params}"


def fetch_json(url: str) -> dict[str, Any]:
    with urllib.request.urlopen(url, timeout=30) as response:
        data = json.load(response)
    if not isinstance(data, dict):
        raise SystemExit(f"{url}: expected JSON object")
    return data


def write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, sort_keys=True, ensure_ascii=True))
            handle.write("\n")


def write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2, sort_keys=True, ensure_ascii=True)
        handle.write("\n")


if __name__ == "__main__":
    raise SystemExit(main())
