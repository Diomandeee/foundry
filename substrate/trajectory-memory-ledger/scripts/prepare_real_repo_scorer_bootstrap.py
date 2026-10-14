#!/usr/bin/env python3
"""Prepare scripts for bootstrapping an official SWE-bench scorer.

This script only writes a private bootstrap packet and a public metadata report.
It does not install packages, enable cloud APIs, create machines, submit Modal
jobs, or run the SWE-bench harness.
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def main() -> int:
    args = parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    handoff_dir = args.handoff_dir
    if not (handoff_dir / "run_official_harness.sh").exists():
        raise SystemExit(f"{handoff_dir}: missing run_official_harness.sh")
    if not (handoff_dir / "inputs" / "base-agent.predictions.jsonl").exists():
        raise SystemExit(f"{handoff_dir}: missing base predictions")
    if not (handoff_dir / "inputs" / "tml-planner.predictions.jsonl").exists():
        raise SystemExit(f"{handoff_dir}: missing planner predictions")
    handoff_metadata = read_handoff_metadata(handoff_dir)

    scripts = {
        "bootstrap_ubuntu_x86_scorer": args.output_dir / "bootstrap_ubuntu_x86_scorer.sh",
        "rsync_handoff_to_scorer": args.output_dir / "rsync_handoff_to_scorer.sh",
        "run_handoff_on_scorer": args.output_dir / "run_handoff_on_scorer.sh",
        "modal_command_reference": args.output_dir / "modal_command_reference.sh",
        "README": args.output_dir / "README.md",
    }
    write_bootstrap_script(scripts["bootstrap_ubuntu_x86_scorer"], args)
    write_rsync_script(scripts["rsync_handoff_to_scorer"], args)
    write_run_script(scripts["run_handoff_on_scorer"], args)
    write_modal_script(scripts["modal_command_reference"], handoff_metadata)
    write_readme(scripts["README"], args, handoff_metadata)

    for path in scripts.values():
        if path.suffix == ".sh":
            os.chmod(path, 0o755)

    report = {
        "schema": "trajectory-memory-ledger.real_repo_scorer_bootstrap.v1",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "status": "scorer_bootstrap_packet_ready",
        "claim_boundary": (
            "This packet prepares scorer setup scripts only. It does not run "
            "SWE-bench and cannot prove planner performance."
        ),
        "private_bootstrap_dir": str(args.output_dir),
        "private_handoff_dir": str(handoff_dir),
        "handoff_metadata": handoff_metadata,
        "recommended_scorer": {
            "architecture": "x86_64",
            "free_storage_gb": args.min_free_gb,
            "ram_gb": args.min_ram_gb,
            "cpu_cores": args.min_cpu_cores,
            "docker_required": True,
            "swebench_install": "git clone https://github.com/SWE-bench/SWE-bench.git && pip install -e SWE-bench",
        },
        "scripts": {key: str(path) for key, path in scripts.items()},
        "official_sources": [
            "https://github.com/SWE-bench/SWE-bench",
            "https://www.swebench.com/SWE-bench/guides/evaluation/",
            "https://www.swebench.com/SWE-bench/reference/harness/",
        ],
        "ran_official_harness": False,
        "performance_claim_allowed": False,
        "next_gate": (
            "Run rsync_handoff_to_scorer.sh with SCORER_HOST set, run "
            "bootstrap_ubuntu_x86_scorer.sh on the scorer if needed, then run "
            "run_handoff_on_scorer.sh on the scorer."
        ),
    }
    write_json(args.report, report)
    print(json.dumps({"status": report["status"], "scripts": report["scripts"]}, indent=2))
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--handoff-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--repo-url", default="https://github.com/Diomandeee/trajectory-memory-ledger.git")
    parser.add_argument("--repo-dir", default="trajectory-memory-ledger")
    parser.add_argument("--work-dir", default="$HOME/tml-swebench-scorer")
    parser.add_argument("--remote-work-dir", default="$HOME/tml-swebench-scorer")
    parser.add_argument("--min-free-gb", type=int, default=120)
    parser.add_argument("--min-ram-gb", type=int, default=16)
    parser.add_argument("--min-cpu-cores", type=int, default=8)
    parser.add_argument("--max-workers", type=int, default=1)
    return parser.parse_args()


def read_handoff_metadata(handoff_dir: Path) -> dict[str, Any]:
    runner = handoff_dir / "run_official_harness.sh"
    commands = extract_harness_commands(runner)
    if len(commands) != 2:
        raise SystemExit(f"{runner}: expected 2 run_evaluation commands, found {len(commands)}")
    base = parse_run_evaluation_command(commands[0])
    planner = parse_run_evaluation_command(commands[1])
    for field in ("dataset_name", "split", "max_workers", "timeout", "report_dir", "instance_ids"):
        if base[field] != planner[field]:
            raise SystemExit(f"{runner}: base/planner command mismatch for {field}")
    if not str(base["predictions_path"]).endswith("base-agent.predictions.jsonl"):
        raise SystemExit(f"{runner}: first command does not look like base predictions")
    if not str(planner["predictions_path"]).endswith("tml-planner.predictions.jsonl"):
        raise SystemExit(f"{runner}: second command does not look like planner predictions")
    return {
        "dataset_name": base["dataset_name"],
        "split": base["split"],
        "max_workers": int(base["max_workers"]),
        "timeout": int(base["timeout"]),
        "report_dir": base["report_dir"],
        "instance_ids": base["instance_ids"],
        "instance_count": len(base["instance_ids"]),
        "base_run_id": base["run_id"],
        "planner_run_id": planner["run_id"],
        "base_predictions_path": base["predictions_path"],
        "planner_predictions_path": planner["predictions_path"],
        "namespace": base.get("namespace"),
    }


def extract_harness_commands(runner: Path) -> list[str]:
    commands: list[str] = []
    for line in runner.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if stripped.startswith("python -m swebench.harness.run_evaluation "):
            commands.append(stripped)
    return commands


def parse_run_evaluation_command(command: str) -> dict[str, Any]:
    parts = shlex.split(command)
    expected_prefix = ["python", "-m", "swebench.harness.run_evaluation"]
    if parts[:3] != expected_prefix:
        raise SystemExit(f"unexpected run_evaluation command: {command}")
    values: dict[str, Any] = {}
    index = 3
    while index < len(parts):
        flag = parts[index]
        if not flag.startswith("--"):
            raise SystemExit(f"unexpected positional argument in command: {flag}")
        name = flag[2:].replace("-", "_")
        index += 1
        if name == "instance_ids":
            ids: list[str] = []
            while index < len(parts) and not parts[index].startswith("--"):
                ids.append(parts[index])
                index += 1
            values[name] = ids
            continue
        if index >= len(parts) or parts[index].startswith("--"):
            values[name] = True
            continue
        values[name] = parts[index]
        index += 1
    required = {
        "dataset_name",
        "split",
        "predictions_path",
        "max_workers",
        "timeout",
        "run_id",
        "report_dir",
        "instance_ids",
    }
    missing = sorted(required - set(values))
    if missing:
        raise SystemExit(f"run_evaluation command missing fields: {missing}")
    return values


def write_bootstrap_script(path: Path, args: argparse.Namespace) -> None:
    text = f"""#!/usr/bin/env bash
set -euo pipefail

WORK_DIR="${{WORK_DIR:-{args.work_dir}}}"
REPO_URL="${{REPO_URL:-{args.repo_url}}}"
REPO_DIR="${{REPO_DIR:-{args.repo_dir}}}"
MIN_FREE_GB="${{MIN_FREE_GB:-{args.min_free_gb}}}"

mkdir -p "$WORK_DIR"
cd "$WORK_DIR"

ARCH="$(uname -m)"
if [ "$ARCH" != "x86_64" ] && [ "$ARCH" != "amd64" ]; then
  echo "[tml] WARNING: official SWE-bench recommends x86_64; detected $ARCH" >&2
fi

FREE_GB="$(df -Pk . | awk 'NR==2 {{ printf "%d", $4 / 1024 / 1024 }}')"
if [ "$FREE_GB" -lt "$MIN_FREE_GB" ]; then
  echo "[tml] ERROR: $FREE_GB GiB free, need at least $MIN_FREE_GB GiB for SWE-bench Docker evaluation" >&2
  exit 2
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "[tml] ERROR: docker is required. Install Docker Engine, then rerun." >&2
  exit 2
fi

docker info >/dev/null

if ! command -v python3 >/dev/null 2>&1; then
  echo "[tml] ERROR: python3 is required." >&2
  exit 2
fi

if [ ! -d "$REPO_DIR/.git" ]; then
  git clone "$REPO_URL" "$REPO_DIR"
fi

cd "$REPO_DIR"
git pull --ff-only

python3 -m venv .venv-swebench
. .venv-swebench/bin/activate
python -m pip install --upgrade pip

mkdir -p external
if [ ! -d external/SWE-bench/.git ]; then
  git clone https://github.com/SWE-bench/SWE-bench.git external/SWE-bench
fi
python -m pip install -e external/SWE-bench

python - <<'PY'
import importlib.util
raise SystemExit(0 if importlib.util.find_spec("swebench") else 1)
PY

echo "[tml] scorer bootstrap ready"
echo "[tml] next: run {args.handoff_dir}/run_official_harness.sh from repo root"
"""
    path.write_text(text, encoding="utf-8")


def write_rsync_script(path: Path, args: argparse.Namespace) -> None:
    text = f"""#!/usr/bin/env bash
set -euo pipefail

SCORER_HOST="${{SCORER_HOST:-}}"
REMOTE_WORK_DIR="${{REMOTE_WORK_DIR:-{args.remote_work_dir}}}"
REPO_DIR="${{REPO_DIR:-{args.repo_dir}}}"

if [ -z "$SCORER_HOST" ]; then
  echo "Usage: SCORER_HOST=user@host ./rsync_handoff_to_scorer.sh" >&2
  exit 2
fi

ssh "$SCORER_HOST" "mkdir -p '$REMOTE_WORK_DIR/$REPO_DIR/output/private-swebench'"
rsync -av --delete "{args.handoff_dir}/" "$SCORER_HOST:$REMOTE_WORK_DIR/$REPO_DIR/{args.handoff_dir}/"
echo "[tml] handoff synced to $SCORER_HOST:$REMOTE_WORK_DIR/$REPO_DIR/{args.handoff_dir}"
"""
    path.write_text(text, encoding="utf-8")


def write_run_script(path: Path, args: argparse.Namespace) -> None:
    text = f"""#!/usr/bin/env bash
set -euo pipefail

REMOTE_WORK_DIR="${{REMOTE_WORK_DIR:-{args.remote_work_dir}}}"
REPO_DIR="${{REPO_DIR:-{args.repo_dir}}}"

cd "$REMOTE_WORK_DIR/$REPO_DIR"
. .venv-swebench/bin/activate
./{args.handoff_dir}/run_official_harness.sh
"""
    path.write_text(text, encoding="utf-8")


def write_modal_script(path: Path, handoff_metadata: dict[str, Any]) -> None:
    base_command = render_run_evaluation_command(
        handoff_metadata,
        predictions_path=str(handoff_metadata["base_predictions_path"]),
        run_id=str(handoff_metadata["base_run_id"]),
        modal=True,
    )
    planner_command = render_run_evaluation_command(
        handoff_metadata,
        predictions_path=str(handoff_metadata["planner_predictions_path"]),
        run_id=str(handoff_metadata["planner_run_id"]),
        modal=True,
    )
    text = f"""#!/usr/bin/env bash
set -euo pipefail

# Reference only. This machine does not currently have the Modal CLI installed.
# Official SWE-bench supports cloud evaluation with --modal true.
cd "$(git rev-parse --show-toplevel)"
. .venv-swebench/bin/activate

{base_command}

{planner_command}
"""
    path.write_text(text, encoding="utf-8")


def render_run_evaluation_command(
    handoff_metadata: dict[str, Any],
    *,
    predictions_path: str,
    run_id: str,
    modal: bool,
) -> str:
    parts = [
        "python",
        "-m",
        "swebench.harness.run_evaluation",
        "--dataset_name",
        str(handoff_metadata["dataset_name"]),
        "--split",
        str(handoff_metadata["split"]),
        "--predictions_path",
        predictions_path,
        "--max_workers",
        str(handoff_metadata["max_workers"]),
        "--timeout",
        str(handoff_metadata["timeout"]),
        "--run_id",
        run_id,
        "--report_dir",
        str(handoff_metadata["report_dir"]),
    ]
    instance_ids = [str(instance_id) for instance_id in handoff_metadata["instance_ids"]]
    if instance_ids:
        parts.extend(["--instance_ids", *instance_ids])
    if handoff_metadata.get("namespace") is not None:
        parts.extend(["--namespace", str(handoff_metadata["namespace"])])
    if modal:
        parts.extend(["--modal", "true"])
    return " ".join(shlex.quote(part) for part in parts)


def write_readme(path: Path, args: argparse.Namespace, handoff_metadata: dict[str, Any]) -> None:
    instance_ids = ", ".join(str(instance_id) for instance_id in handoff_metadata["instance_ids"])
    text = f"""# TML SWE-bench Scorer Bootstrap Packet

This private packet prepares a clean Docker scorer for the existing TML
real-repo handoff. It is not a benchmark result.

Recommended scorer shape:

- x86_64 Linux
- at least {args.min_free_gb} GB free storage
- at least {args.min_ram_gb} GB RAM
- at least {args.min_cpu_cores} CPU cores
- Docker Engine installed and running

Handoff scope:

- Dataset: `{handoff_metadata["dataset_name"]}`
- Split: `{handoff_metadata["split"]}`
- Base run id: `{handoff_metadata["base_run_id"]}`
- Planner run id: `{handoff_metadata["planner_run_id"]}`
- Instances: {instance_ids}

Flow:

1. Copy or clone the TML repo onto the scorer.
2. Run `bootstrap_ubuntu_x86_scorer.sh` on the scorer.
3. From the local machine, sync the private handoff with
   `SCORER_HOST=user@host ./rsync_handoff_to_scorer.sh`.
4. On the scorer, run `run_handoff_on_scorer.sh`.
5. Commit only the resulting official summary reports, not private patch JSONL.

Boundary: no script in this packet has been run as part of the public artifact.
Official performance remains unproven until SWE-bench reports exist.
"""
    path.write_text(text, encoding="utf-8")


def write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2, sort_keys=True)
        handle.write("\n")


if __name__ == "__main__":
    raise SystemExit(main())
