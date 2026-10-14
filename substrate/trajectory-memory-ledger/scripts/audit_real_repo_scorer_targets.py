#!/usr/bin/env python3
"""Audit available machines for official SWE-bench scoring readiness.

The audit is read-only. It does not install packages, enable cloud APIs, reset
VMs, submit jobs, pull Docker images, or run the SWE-bench harness.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import platform
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def main() -> int:
    args = parse_args()
    local = audit_local(args.workspace, args.min_free_gb)
    remotes = [audit_remote(host, args.min_free_gb, args.ssh_timeout_s) for host in args.remote_host]
    gcloud = audit_gcloud(args.gcloud_project, args.gcloud_account)
    modal = audit_cli("modal", "modal")
    sb_cli = audit_cli("sb", "sb-cli")

    scorer_candidates = [local, *remotes]
    ready = [
        target
        for target in scorer_candidates
        if target.get("status") == "ready_for_official_harness"
    ]
    if ready:
        status = "ready_scorer_available"
    else:
        status = "no_ready_official_scorer"

    report = {
        "schema": "trajectory-memory-ledger.real_repo_scorer_target_audit.v1",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "status": status,
        "min_free_disk_gb": args.min_free_gb,
        "claim_boundary": (
            "This audit checks scorer readiness only. It does not run SWE-bench "
            "and cannot prove planner performance."
        ),
        "local": local,
        "remotes": remotes,
        "gcloud": gcloud,
        "cloud_cli": {
            "modal": modal,
            "sb_cli": sb_cli,
        },
        "ready_targets": [target["target"] for target in ready],
        "ran_official_harness": False,
        "performance_claim_allowed": False,
        "next_gate": (
            "Run the handoff bundle on a ready Docker scorer, or provision/repair "
            "one with enough disk and swebench installed."
        ),
    }
    write_json(args.output, report)
    print(json.dumps({"status": status, "ready_targets": report["ready_targets"]}, indent=2))
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace", type=Path, default=Path("."))
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--min-free-gb", type=float, default=120.0)
    parser.add_argument("--ssh-timeout-s", type=int, default=8)
    parser.add_argument(
        "--remote-host",
        action="append",
        default=["mac4", "mac5", "cloud-vm"],
    )
    parser.add_argument("--gcloud-project", action="append", default=[])
    parser.add_argument("--gcloud-account", action="append", default=[])
    return parser.parse_args()


def audit_local(workspace: Path, min_free_gb: float) -> dict[str, Any]:
    candidate_paths = candidate_storage_paths(workspace)
    storage_candidates = audit_storage_candidates(candidate_paths)
    ready_storage_paths = ready_storage_candidates(storage_candidates, min_free_gb)
    workspace_usage = shutil.disk_usage(workspace)
    free_gb = workspace_usage.free / (1024**3)
    docker_path = shutil.which("docker")
    docker_info = docker_server_version()
    swebench = importlib.util.find_spec("swebench") is not None
    machine = platform.machine()
    blockers = blockers_for(
        ready_storage_paths,
        min_free_gb,
        docker_path,
        docker_info["ok"],
        swebench,
    )
    return {
        "target": "local",
        "status": "ready_for_official_harness" if not blockers else "blocked",
        "architecture": machine,
        "architecture_warning": architecture_warning(machine),
        "free_disk_gb": round(free_gb, 3),
        "storage_candidates": storage_candidates,
        "ready_storage_paths": ready_storage_paths,
        "docker_path": docker_path,
        "docker_ok": docker_info["ok"],
        "docker_server_version": docker_info["server_version"],
        "docker_error": docker_info["error"],
        "swebench_importable": swebench,
        "blockers": blockers,
    }


def audit_remote(host: str, min_free_gb: float, timeout_s: int) -> dict[str, Any]:
    script = r'''
python3 - <<'PY'
import importlib.util, json, platform, shutil, subprocess
from pathlib import Path
usage = shutil.disk_usage(".")
docker = shutil.which("docker")
docker_ok = False
docker_version = None
docker_error = None
if docker:
    result = subprocess.run([docker, "info", "--format", "{{json .ServerVersion}}"], text=True, capture_output=True, timeout=15)
    docker_ok = result.returncode == 0
    if docker_ok:
        docker_version = result.stdout.strip()
    else:
        docker_error = (result.stderr or result.stdout).strip()[:500]
def candidate_paths():
    paths = [Path("."), Path.home(), Path("/"), Path("/tmp")]
    for root in (Path("/Volumes"), Path("/mnt"), Path("/media"), Path("/workspace")):
        if root.exists():
            paths.append(root)
            try:
                paths.extend(path for path in root.iterdir() if path.is_dir())
            except Exception:
                pass
    seen = set()
    unique = []
    for path in paths:
        text = str(path.expanduser())
        if text not in seen:
            unique.append(path)
            seen.add(text)
    return unique
def storage_rows():
    rows = []
    for path in candidate_paths():
        try:
            usage = shutil.disk_usage(path)
        except Exception as exc:
            rows.append({"path": str(path), "available": False, "error": f"{type(exc).__name__}: {exc}"[:200]})
            continue
        rows.append({
            "path": str(path),
            "available": True,
            "free_disk_gb": round(usage.free / (1024**3), 3),
            "total_disk_gb": round(usage.total / (1024**3), 3),
        })
    return rows
print(json.dumps({
    "architecture": platform.machine(),
    "free_disk_gb": round(usage.free / (1024**3), 3),
    "storage_candidates": storage_rows(),
    "docker_path": docker,
    "docker_ok": docker_ok,
    "docker_server_version": docker_version,
    "docker_error": docker_error,
    "swebench_importable": importlib.util.find_spec("swebench") is not None,
}))
PY
'''
    result = subprocess.run(
        ["ssh", "-o", f"ConnectTimeout={timeout_s}", host, script],
        text=True,
        capture_output=True,
        timeout=timeout_s + 20,
        check=False,
    )
    if result.returncode != 0:
        return {
            "target": host,
            "status": "unreachable",
            "error": (result.stderr or result.stdout).strip()[:500],
            "blockers": ["ssh unreachable"],
        }
    try:
        data = json.loads(result.stdout.strip().splitlines()[-1])
    except Exception as exc:
        return {
            "target": host,
            "status": "unknown",
            "error": f"{type(exc).__name__}: {exc}",
            "raw_stdout": result.stdout[-500:],
            "blockers": ["remote audit parse failed"],
        }
    ready_storage_paths = ready_storage_candidates(
        data.get("storage_candidates", []),
        min_free_gb,
    )
    blockers = blockers_for(
        ready_storage_paths,
        min_free_gb,
        data.get("docker_path"),
        bool(data.get("docker_ok")),
        bool(data.get("swebench_importable")),
    )
    data.update(
        {
            "target": host,
            "status": "ready_for_official_harness" if not blockers else "blocked",
            "architecture_warning": architecture_warning(str(data.get("architecture", ""))),
            "ready_storage_paths": ready_storage_paths,
            "blockers": blockers,
        }
    )
    return data


def blockers_for(
    ready_storage_paths: list[str],
    min_free_gb: float,
    docker_path: str | None,
    docker_ok: bool,
    swebench: bool,
) -> list[str]:
    blockers: list[str] = []
    if not ready_storage_paths:
        blockers.append(f"no audited path has at least {min_free_gb:.2f} GiB free")
    if docker_path is None:
        blockers.append("docker executable not found")
    elif not docker_ok:
        blockers.append("docker info failed")
    if not swebench:
        blockers.append("python module 'swebench' is not importable")
    return blockers


def candidate_storage_paths(workspace: Path) -> list[Path]:
    paths = [
        workspace,
        Path.home(),
        Path("/"),
        Path("/tmp"),
    ]
    for root in (Path("/Volumes"), Path("/mnt"), Path("/media"), Path("/workspace")):
        if root.exists():
            paths.append(root)
            try:
                paths.extend(path for path in root.iterdir() if path.is_dir())
            except Exception:
                pass
    seen: set[str] = set()
    unique: list[Path] = []
    for path in paths:
        text = str(path.expanduser())
        if text not in seen:
            unique.append(path)
            seen.add(text)
    return unique


def audit_storage_candidates(paths: list[Path]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for path in paths:
        try:
            usage = shutil.disk_usage(path)
        except Exception as exc:
            rows.append(
                {
                    "path": str(path),
                    "available": False,
                    "error": f"{type(exc).__name__}: {exc}"[:200],
                }
            )
            continue
        rows.append(
            {
                "path": str(path),
                "available": True,
                "free_disk_gb": round(usage.free / (1024**3), 3),
                "total_disk_gb": round(usage.total / (1024**3), 3),
            }
        )
    return rows


def ready_storage_candidates(storage_candidates: list[dict[str, Any]], min_free_gb: float) -> list[str]:
    return [
        str(row["path"])
        for row in storage_candidates
        if row.get("available") and float(row.get("free_disk_gb", 0.0)) >= min_free_gb
    ]


def architecture_warning(machine: str) -> str | None:
    normalized = machine.lower()
    if normalized in {"x86_64", "amd64"}:
        return None
    return "official SWE-bench Docker evaluation is recommended on x86_64; this target may need an experimental ARM path"


def docker_server_version() -> dict[str, Any]:
    docker = shutil.which("docker")
    if docker is None:
        return {"ok": False, "server_version": None, "error": "docker executable not found"}
    result = subprocess.run(
        [docker, "info", "--format", "{{json .ServerVersion}}"],
        text=True,
        capture_output=True,
        timeout=15,
        check=False,
    )
    if result.returncode != 0:
        return {
            "ok": False,
            "server_version": None,
            "error": (result.stderr or result.stdout).strip()[:500],
        }
    return {"ok": True, "server_version": result.stdout.strip(), "error": None}


def audit_gcloud(projects: list[str], accounts: list[str]) -> dict[str, Any]:
    if shutil.which("gcloud") is None:
        return {"available": False, "error": "gcloud executable not found"}
    auth_list = run_text(["gcloud", "auth", "list", "--format=json"])
    config = run_text(["gcloud", "config", "list", "--format=json"])
    auth_data = parse_json_or_raw(auth_list["stdout"])
    config_data = parse_json_or_raw(config["stdout"])
    project_results = []
    for account in accounts:
        for project in projects:
            command = [
                "gcloud",
                "--quiet",
                f"--account={account}",
                "compute",
                "instances",
                "list",
                f"--project={project}",
                "--format=json",
            ]
            result = run_text(command)
            project_results.append(
                {
                    "account": account,
                    "project": project,
                    "ok": result["returncode"] == 0,
                    "stdout_json_count": json_count(result["stdout"]),
                    "stderr_or_error": (result["stderr"] or result["stdout"])[:1000],
                }
            )
    report = {
        "available": True,
        "auth_list_returncode": auth_list["returncode"],
        "auth_list": auth_data,
        "config_returncode": config["returncode"],
        "config": config_data,
        "project_results": project_results,
    }
    return redact_cloud_identifiers(report, accounts, projects)


def redact_cloud_identifiers(data: dict[str, Any], accounts: list[str], projects: list[str]) -> dict[str, Any]:
    account_tokens = set(accounts)
    project_tokens = set(projects)
    collect_cloud_tokens(data, account_tokens, project_tokens)
    replacements: dict[str, str] = {}
    for index, token in enumerate(sorted(account_tokens), 1):
        if token:
            replacements[token] = f"account_{index}"
    for index, token in enumerate(sorted(project_tokens), 1):
        if token:
            replacements[token] = f"project_{index}"
    redacted = replace_tokens(data, replacements)
    if isinstance(redacted, dict):
        redacted["redacted_identifiers"] = True
        redacted["account_count"] = len(account_tokens)
        redacted["project_count"] = len(project_tokens)
    return redacted


def collect_cloud_tokens(data: Any, accounts: set[str], projects: set[str]) -> None:
    if isinstance(data, dict):
        for key, value in data.items():
            if key == "account" and isinstance(value, str):
                accounts.add(value)
            if key == "project" and isinstance(value, str):
                projects.add(value)
            collect_cloud_tokens(value, accounts, projects)
    elif isinstance(data, list):
        for item in data:
            collect_cloud_tokens(item, accounts, projects)


def replace_tokens(data: Any, replacements: dict[str, str]) -> Any:
    if isinstance(data, dict):
        return {key: replace_tokens(value, replacements) for key, value in data.items()}
    if isinstance(data, list):
        return [replace_tokens(item, replacements) for item in data]
    if isinstance(data, str):
        redacted = data
        for source, target in replacements.items():
            redacted = redacted.replace(source, target)
        return redacted
    return data


def audit_cli(executable: str, label: str) -> dict[str, Any]:
    path = shutil.which(executable)
    if path is None:
        return {"label": label, "available": False, "path": None}
    result = subprocess.run(
        [path, "--version"],
        text=True,
        capture_output=True,
        timeout=15,
        check=False,
    )
    return {
        "label": label,
        "available": True,
        "path": path,
        "version_output": (result.stdout or result.stderr).strip()[:500],
        "returncode": result.returncode,
    }


def run_text(command: list[str]) -> dict[str, Any]:
    result = subprocess.run(command, text=True, capture_output=True, timeout=60, check=False)
    return {
        "returncode": result.returncode,
        "stdout": result.stdout,
        "stderr": result.stderr,
    }


def parse_json_or_raw(text: str) -> Any:
    try:
        return json.loads(text)
    except Exception:
        return text[:1000]


def json_count(text: str) -> int | None:
    try:
        data = json.loads(text)
    except Exception:
        return None
    return len(data) if isinstance(data, list) else None


def write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2, sort_keys=True)
        handle.write("\n")


if __name__ == "__main__":
    raise SystemExit(main())
