#!/usr/bin/env python3
"""Generate base and TML-planner SWE-bench prediction files.

The script owns the controlled prompt and command wrapper for the real-repo
gate. It does not run tests and does not read gold patches or test patches.
An external agent command is responsible for producing a unified diff from the
prompt file. Use --dry-run to validate prompt/retrieval/budget wiring without
creating predictions or claiming performance.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


FORBIDDEN_MANIFEST_FIELDS = {"patch", "test_patch", "FAIL_TO_PASS", "PASS_TO_PASS"}
CONDITIONS = ["base_agent", "base_agent_tml_planner"]


@dataclass(frozen=True)
class SkillMemory:
    name: str
    path: Path
    text: str
    tokens: set[str]


def main() -> int:
    args = parse_args()
    instances = read_manifest(args.instances_jsonl)
    if args.max_instances:
        instances = instances[: args.max_instances]
    if not instances:
        raise SystemExit("no instances selected")

    skill_memories = load_skill_memories(args.skill_root)
    args.raw_dir.mkdir(parents=True, exist_ok=True)
    if not args.dry_run:
        args.output_dir.mkdir(parents=True, exist_ok=True)
    if not args.agent_command and not args.dry_run:
        raise SystemExit("--agent-command is required unless --dry-run is set")

    condition_reports: dict[str, Any] = {}
    output_paths: dict[str, Path] = {
        "base_agent": args.output_dir / "base-agent.predictions.jsonl",
        "base_agent_tml_planner": args.output_dir / "tml-planner.predictions.jsonl",
    }

    for condition in CONDITIONS:
        rows: list[dict[str, str]] = []
        per_instance: list[dict[str, Any]] = []
        condition_dir = args.raw_dir / condition
        condition_dir.mkdir(parents=True, exist_ok=True)

        for instance in instances:
            instance_id = str(instance["instance_id"])
            retrieved = (
                retrieve_skill_memory(instance, skill_memories, args.planner_top_k)
                if condition == "base_agent_tml_planner"
                else []
            )
            repo_worktree = prepare_repo_worktree(instance, condition, args) if args.prepare_repos else None
            prompt = build_prompt(
                instance=instance,
                condition=condition,
                retrieved=retrieved,
                max_context_chars=args.max_planner_context_chars,
                repo_worktree=repo_worktree,
            )
            prompt_path = condition_dir / f"{safe_name(instance_id)}.prompt.md"
            raw_output_path = condition_dir / f"{safe_name(instance_id)}.raw.txt"
            write_text(prompt_path, prompt)

            instance_report: dict[str, Any] = {
                "instance_id": instance_id,
                "repo": instance.get("repo"),
                "condition": condition,
                "prompt_path": str(prompt_path),
                "raw_output_path": str(raw_output_path),
                "repo_worktree_path": str(repo_worktree) if repo_worktree else None,
                "repo_prepared": repo_worktree is not None,
                "prompt_chars": len(prompt),
                "retrieved_skill_count": len(retrieved),
                "retrieved_skills": [
                    {"name": memory.name, "path": str(memory.path), "score": score}
                    for memory, score in retrieved
                ],
                "dry_run": args.dry_run,
                "status": "dry_run_prompt_written" if args.dry_run else "pending",
            }

            if not args.dry_run:
                started = time.monotonic()
                command_report = run_agent_command(
                    command_template=args.agent_command,
                    prompt_path=prompt_path,
                    raw_output_path=raw_output_path,
                    condition=condition,
                    instance_id=instance_id,
                    model_name=args.model_name,
                    timeout_s=args.timeout_s,
                    cwd=repo_worktree or args.command_cwd,
                    repo_worktree=repo_worktree,
                )
                elapsed = time.monotonic() - started
                raw_text = read_text(raw_output_path)
                patch = extract_unified_diff(raw_text)
                if not patch.strip() and repo_worktree is not None:
                    patch = git_diff(repo_worktree)
                rows.append(
                    {
                        "instance_id": instance_id,
                        "model_name_or_path": args.model_name,
                        "model_patch": patch,
                    }
                )
                instance_report.update(command_report)
                instance_report.update(
                    {
                        "duration_s": round(elapsed, 3),
                        "patch_chars": len(patch),
                        "patch_extracted": bool(patch.strip()),
                        "status": command_report["status"]
                        if patch.strip()
                        else "no_unified_diff_extracted",
                    }
                )
            per_instance.append(instance_report)

        if not args.dry_run:
            write_prediction_jsonl(output_paths[condition], rows)

        condition_reports[condition] = {
            "prediction_path": str(output_paths[condition]) if not args.dry_run else None,
            "instance_count": len(instances),
            "prediction_count": len(rows),
            "all_predictions_written": (len(rows) == len(instances)) if not args.dry_run else False,
            "per_instance": per_instance,
        }

    report = {
        "schema": "trajectory-memory-ledger.real_repo_prediction_generation.v1",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "status": "dry_run_prompt_generation_ready"
        if args.dry_run
        else status_from_condition_reports(condition_reports, len(instances)),
        "instances_jsonl": str(args.instances_jsonl),
        "instance_count": len(instances),
        "conditions": CONDITIONS,
        "model_name": args.model_name,
        "same_agent_command_for_conditions": True,
        "same_timeout_s": args.timeout_s,
        "same_instance_order": True,
        "dry_run": args.dry_run,
        "agent_command_recorded": bool(args.agent_command),
        "raw_dir": str(args.raw_dir),
        "output_dir": str(args.output_dir),
        "repo_work_dir": str(args.repo_work_dir) if args.repo_work_dir else None,
        "prepare_repos": args.prepare_repos,
        "skill_roots": [str(path) for path in args.skill_root],
        "skill_memory_count": len(skill_memories),
        "hidden_eval_fields_used": False,
        "gold_patch_used": False,
        "test_patch_used": False,
        "ran_official_harness": False,
        "performance_claim_allowed": False,
        "condition_reports": condition_reports,
        "next_gate_command": build_next_gate_command(args, output_paths),
        "claim_boundary": (
            "Prediction generation is not performance evidence. Only official "
            "SWE-bench harness reports can measure real-repo issue resolution."
        ),
    }
    write_json(args.report, report)
    print(json.dumps({k: report[k] for k in ("status", "instance_count", "dry_run", "claim_boundary")}, indent=2))
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--instances-jsonl",
        type=Path,
        default=Path("examples/evaluation/swebench-verified-mini-public-manifest-2026-06-11.jsonl"),
    )
    parser.add_argument("--output-dir", type=Path, default=Path("output/private-swebench"))
    parser.add_argument("--raw-dir", type=Path, default=Path("output/private-swebench/raw-agent-output"))
    parser.add_argument(
        "--report",
        type=Path,
        default=Path("benchmarks/real-repo-prediction-generation-dry-run-2026-06-11.json"),
    )
    parser.add_argument("--model-name", default="external-agent-same-model")
    parser.add_argument(
        "--agent-command",
        help=(
            "Shell command template that reads {prompt_file} and writes a unified diff to "
            "stdout or {raw_output_file}. Available fields: prompt_file, raw_output_file, "
            "condition, instance_id, model_name, repo_worktree."
        ),
    )
    parser.add_argument("--command-cwd", type=Path)
    parser.add_argument(
        "--repo-work-dir", type=Path, default=Path("output/private-swebench/repo-worktrees")
    )
    parser.add_argument("--prepare-repos", action="store_true")
    parser.add_argument("--timeout-s", type=int, default=1800)
    parser.add_argument("--max-instances", type=int)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--planner-top-k", type=int, default=3)
    parser.add_argument("--max-planner-context-chars", type=int, default=8000)
    parser.add_argument(
        "--skill-root",
        action="append",
        type=Path,
        default=[
            Path("examples/skills/python-stdlib-heldout-v1/anticipatory-public-repair-planner-vs-base/packages")
        ],
    )
    return parser.parse_args()


def read_manifest(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open(encoding="utf-8") as handle:
        for line_no, line in enumerate(handle, 1):
            if not line.strip():
                continue
            row = json.loads(line)
            if not isinstance(row, dict):
                raise SystemExit(f"{path}:{line_no}: expected object")
            forbidden = FORBIDDEN_MANIFEST_FIELDS & set(row)
            if forbidden:
                raise SystemExit(f"{path}:{line_no}: forbidden eval fields present {sorted(forbidden)}")
            for field in ("repo", "instance_id", "base_commit", "problem_statement"):
                if not str(row.get(field, "")).strip():
                    raise SystemExit(f"{path}:{line_no}: missing {field}")
            rows.append(row)
    return rows


def load_skill_memories(roots: list[Path]) -> list[SkillMemory]:
    memories: list[SkillMemory] = []
    for root in roots:
        if not root.exists():
            continue
        package_dirs = [p for p in root.iterdir() if p.is_dir()] if root.is_dir() else []
        if not package_dirs and root.is_dir():
            package_dirs = [root]
        for package_dir in package_dirs:
            chunks: list[str] = []
            for name in ("skill.json", "SKILL.md", "MEMORY.md", "failure_modes.json"):
                path = package_dir / name
                if path.exists():
                    chunks.append(f"# {name}\n{read_text(path)[:4000]}")
            if chunks:
                text = "\n\n".join(chunks)
                memories.append(
                    SkillMemory(
                        name=package_dir.name,
                        path=package_dir,
                        text=text,
                        tokens=tokenize(text),
                    )
                )
    return memories


def retrieve_skill_memory(
    instance: dict[str, Any],
    memories: list[SkillMemory],
    top_k: int,
) -> list[tuple[SkillMemory, int]]:
    query = " ".join(
        [
            str(instance.get("repo", "")),
            str(instance.get("problem_statement", "")),
            str(instance.get("hints_text", "")),
        ]
    )
    query_tokens = tokenize(query)
    scored = [(memory, len(query_tokens & memory.tokens)) for memory in memories]
    scored = [item for item in scored if item[1] > 0]
    scored.sort(key=lambda item: (-item[1], item[0].name))
    return scored[:top_k]


def build_prompt(
    *,
    instance: dict[str, Any],
    condition: str,
    retrieved: list[tuple[SkillMemory, int]],
    max_context_chars: int,
    repo_worktree: Path | None,
) -> str:
    parts = [
        "You are a coding agent solving one SWE-bench style real repository issue.",
        "Return only a unified diff patch. Do not wrap it in Markdown.",
        "Do not use hidden tests, gold patches, or test patches.",
        "",
        f"Condition: {condition}",
        f"Repository: {instance['repo']}",
        f"Instance ID: {instance['instance_id']}",
        f"Base commit: {instance['base_commit']}",
        f"Version: {instance.get('version', '')}",
        "",
        "Problem statement:",
        str(instance["problem_statement"]),
    ]
    hints = str(instance.get("hints_text", "")).strip()
    if hints:
        parts.extend(["", "Public hints:", hints])
    if repo_worktree is not None:
        parts.extend(
            [
                "",
                "Repository working tree:",
                str(repo_worktree),
                "The working tree is checked out at the base commit. Inspect and edit files there, then output the final unified diff.",
            ]
        )
    if condition == "base_agent_tml_planner":
        parts.extend(
            [
                "",
                "Trajectory Memory Ledger planner context:",
                "Use this memory only as process guidance. It may suggest failure families, "
                "verification habits, and patch-shape checks, but it does not contain this "
                "issue's gold patch or hidden tests.",
            ]
        )
        context_chars = 0
        for memory, score in retrieved:
            remaining = max_context_chars - context_chars
            if remaining <= 0:
                break
            snippet = memory.text[:remaining]
            context_chars += len(snippet)
            parts.extend(
                [
                    "",
                    f"Retrieved TML memory package: {memory.name} (score={score})",
                    snippet,
                ]
            )
        if not retrieved:
            parts.append("No matching TML skill memory retrieved; use the base issue context.")
    parts.extend(
        [
            "",
            "Patch requirements:",
            "- Output a unified diff starting with diff --git when possible.",
            "- Keep the patch focused on the described issue.",
            "- Do not include explanation, analysis, or code fences.",
        ]
    )
    return "\n".join(parts).strip() + "\n"


def run_agent_command(
    *,
    command_template: str | None,
    prompt_path: Path,
    raw_output_path: Path,
    condition: str,
    instance_id: str,
    model_name: str,
    timeout_s: int,
    cwd: Path | None,
    repo_worktree: Path | None,
) -> dict[str, Any]:
    if command_template is None:
        raise SystemExit("--agent-command is required")
    command = command_template.format(
        prompt_file=str(prompt_path.resolve()),
        raw_output_file=str(raw_output_path.resolve()),
        condition=condition,
        instance_id=instance_id,
        model_name=model_name,
        repo_worktree=str(repo_worktree.resolve()) if repo_worktree else "",
    )
    result = subprocess.run(
        command,
        shell=True,
        text=True,
        capture_output=True,
        timeout=timeout_s,
        cwd=str(cwd) if cwd else None,
        check=False,
    )
    output_text = ""
    if raw_output_path.exists() and raw_output_path.stat().st_size:
        output_text = read_text(raw_output_path)
    else:
        output_text = result.stdout
        write_text(raw_output_path, output_text)
    stderr_path = raw_output_path.with_suffix(".stderr.txt")
    if result.stderr:
        write_text(stderr_path, result.stderr)
    return {
        "command": command,
        "returncode": result.returncode,
        "stderr_path": str(stderr_path) if result.stderr else None,
        "stdout_chars": len(result.stdout),
        "output_chars": len(output_text),
        "repo_worktree": str(repo_worktree) if repo_worktree else None,
        "status": "command_succeeded" if result.returncode == 0 else "command_failed",
    }


def prepare_repo_worktree(instance: dict[str, Any], condition: str, args: argparse.Namespace) -> Path:
    repo = str(instance["repo"])
    instance_id = safe_name(str(instance["instance_id"]))
    base_commit = str(instance["base_commit"])
    repo_key = repo.replace("/", "__")
    cache_dir = args.repo_work_dir / "cache" / f"{repo_key}.git"
    worktree = args.repo_work_dir / "worktrees" / condition / instance_id
    args.repo_work_dir.mkdir(parents=True, exist_ok=True)

    if not cache_dir.exists():
        cache_dir.parent.mkdir(parents=True, exist_ok=True)
        run_git(
            [
                "git",
                "clone",
                "--mirror",
                f"https://github.com/{repo}.git",
                str(cache_dir),
            ],
            cwd=None,
        )
    else:
        run_git(["git", "fetch", "--quiet", "origin"], cwd=cache_dir)

    if not worktree.exists():
        worktree.parent.mkdir(parents=True, exist_ok=True)
        run_git(["git", "clone", str(cache_dir), str(worktree)], cwd=None)
    else:
        status = git_status(worktree)
        if status:
            raise SystemExit(
                f"{worktree} has local changes; move it aside before regenerating predictions"
            )

    run_git(["git", "checkout", "--quiet", base_commit], cwd=worktree)
    return worktree


def run_git(command: list[str], cwd: Path | None) -> None:
    result = subprocess.run(
        command,
        cwd=str(cwd) if cwd else None,
        text=True,
        capture_output=True,
        timeout=300,
        check=False,
    )
    if result.returncode != 0:
        raise SystemExit(
            f"git command failed ({' '.join(command)}): {(result.stderr or result.stdout).strip()}"
        )


def git_status(repo_worktree: Path) -> str:
    result = subprocess.run(
        ["git", "status", "--porcelain"],
        cwd=str(repo_worktree),
        text=True,
        capture_output=True,
        timeout=60,
        check=False,
    )
    if result.returncode != 0:
        raise SystemExit(f"git status failed in {repo_worktree}: {result.stderr.strip()}")
    return result.stdout.strip()


def git_diff(repo_worktree: Path) -> str:
    mark_untracked_files_for_diff(repo_worktree)
    result = subprocess.run(
        ["git", "diff", "--binary"],
        cwd=str(repo_worktree),
        text=True,
        capture_output=True,
        timeout=60,
        check=False,
    )
    if result.returncode != 0:
        return ""
    return result.stdout.strip() + ("\n" if result.stdout.strip() else "")


def mark_untracked_files_for_diff(repo_worktree: Path) -> None:
    result = subprocess.run(
        ["git", "ls-files", "--others", "--exclude-standard", "-z"],
        cwd=str(repo_worktree),
        text=True,
        capture_output=True,
        timeout=60,
        check=False,
    )
    if result.returncode != 0:
        raise SystemExit(f"git ls-files failed in {repo_worktree}: {result.stderr.strip()}")
    untracked = [path for path in result.stdout.split("\0") if path]
    if not untracked:
        return
    add_result = subprocess.run(
        ["git", "add", "--intent-to-add", "--", *untracked],
        cwd=str(repo_worktree),
        text=True,
        capture_output=True,
        timeout=60,
        check=False,
    )
    if add_result.returncode != 0:
        raise SystemExit(
            f"git add --intent-to-add failed in {repo_worktree}: {add_result.stderr.strip()}"
        )


def extract_unified_diff(text: str) -> str:
    fenced = re.search(r"```(?:diff|patch)?\s*(diff --git .*?)```", text, flags=re.DOTALL)
    if fenced:
        return fenced.group(1).strip() + "\n"
    index = text.find("diff --git ")
    if index >= 0:
        return text[index:].strip() + "\n"
    return text.strip() + ("\n" if text.strip() else "")


def write_prediction_jsonl(path: Path, rows: list[dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, sort_keys=True, ensure_ascii=True))
            handle.write("\n")


def status_from_condition_reports(reports: dict[str, Any], instance_count: int) -> str:
    for condition in CONDITIONS:
        if reports[condition]["prediction_count"] != instance_count:
            return "incomplete_predictions"
    return "predictions_ready_for_official_harness"


def build_next_gate_command(args: argparse.Namespace, output_paths: dict[str, Path]) -> str:
    return " ".join(
        [
            "python3 scripts/prepare_real_repo_issue_gate.py",
            f"--instances-jsonl {args.instances_jsonl}",
            f"--base-predictions {output_paths['base_agent']}",
            f"--planner-predictions {output_paths['base_agent_tml_planner']}",
            "--output benchmarks/real-repo-issue-gate-preflight.json",
        ]
    )


def tokenize(text: str) -> set[str]:
    return {token for token in re.findall(r"[a-zA-Z_][a-zA-Z0-9_]{2,}", text.lower())}


def safe_name(value: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_.-]+", "_", value)


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2, sort_keys=True, ensure_ascii=True)
        handle.write("\n")


if __name__ == "__main__":
    raise SystemExit(main())
