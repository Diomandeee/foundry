#!/usr/bin/env python3
"""Run a public-only anticipatory repair planner for executable candidates.

The planner sits before hidden executable scoring:

1. Classify public task prompts into skill/failure families.
2. Retrieve only matching skillgraph package memory.
3. Generate bounded repair candidates from public prompt recipes.
4. Admit a repair only if syntax/import/signature/probe checks pass.
5. Overlay admitted repairs onto a trusted base candidate file.

This script intentionally has no task-spec input and does not read verifier
tests. The hidden benchmark remains the final scoring gate.
"""

from __future__ import annotations

import argparse
import ast
import copy
import json
import re
import subprocess
import sys
import tempfile
import textwrap
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable


@dataclass(frozen=True)
class Recipe:
    recipe_id: str
    family: str
    failure_family: str
    source: str
    public_probe: str


@dataclass(frozen=True)
class Classification:
    task_id: str
    candidate_path: str
    module_name: str
    function_name: str
    family: str
    failure_family: str


RecipeBuilder = Callable[[dict[str, Any], Classification], Recipe]


def main() -> int:
    args = parse_args()
    public_tasks = read_public_tasks(args.public_tasks)
    base_rows = read_jsonl(args.base_candidates)
    public_by_task = rows_by_task(public_tasks, "public tasks")
    base_by_task = rows_by_task(base_rows, "base candidates")
    validate_base_coverage(base_rows, public_by_task)

    target_task_ids = set(args.target_task_id or public_by_task.keys())
    skill_memory = load_skill_memory(args.skill_dir)
    admitted_rows: list[dict[str, Any]] = []
    admitted_task_ids: list[str] = []
    rejected_task_ids: list[str] = []
    task_reports: dict[str, Any] = {}
    overlay_rows: list[dict[str, Any]] = []

    for base_row in base_rows:
        task_id = str(base_row["task_id"])
        task = public_by_task[task_id]
        classification = classify_task(task)
        memory = retrieve_memory(skill_memory, classification)
        task_report: dict[str, Any] = {
            "classification": classification.__dict__,
            "retrieved_memory": memory,
            "targeted": task_id in target_task_ids,
            "eligible": False,
            "admitted": False,
            "recipe": None,
            "public_check": None,
            "decision": "preserve_base",
        }

        row = copy.deepcopy(base_row)
        if task_id in target_task_ids:
            eligible = memory_is_eligible(task_id, memory, args.require_shared_failure_memory)
            task_report["eligible"] = eligible
            builder = RECIPE_BUILDERS.get(classification.function_name)
            if eligible and builder is not None:
                recipe = builder(task, classification)
                candidate_files = {classification.candidate_path: recipe.source}
                public_check = public_check_candidate(
                    candidate_files=candidate_files,
                    task=task,
                    classification=classification,
                    recipe=recipe,
                    timeout_s=args.public_check_timeout_s,
                )
                task_report["recipe"] = {
                    "recipe_id": recipe.recipe_id,
                    "family": recipe.family,
                    "failure_family": recipe.failure_family,
                }
                task_report["public_check"] = public_check
                if public_check["ok"]:
                    row = make_overlay_row(
                        base_row=base_row,
                        candidate_files=candidate_files,
                        condition=args.condition,
                        classification=classification,
                        recipe=recipe,
                        memory=memory,
                    )
                    admitted_rows.append(copy.deepcopy(row))
                    admitted_task_ids.append(task_id)
                    task_report["admitted"] = True
                    task_report["decision"] = "admit_public_checked_repair"
                else:
                    rejected_task_ids.append(task_id)
                    task_report["decision"] = "reject_public_check_failed"
            elif eligible:
                rejected_task_ids.append(task_id)
                task_report["decision"] = "reject_no_recipe"
            else:
                task_report["decision"] = "preserve_base_not_shared_failure_memory"

        if task_report["decision"].startswith("preserve"):
            row = make_preserve_row(base_row, args.condition)
        overlay_rows.append(row)
        task_reports[task_id] = task_report

    validate_overlay_coverage(base_rows, overlay_rows)
    write_jsonl(args.output, overlay_rows)
    if args.admitted_candidates_output:
        write_jsonl(args.admitted_candidates_output, admitted_rows)

    report = {
        "generator": "run_anticipatory_repair_planner.py",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "public_tasks": str(args.public_tasks),
        "base_candidates": str(args.base_candidates),
        "skill_dir": str(args.skill_dir),
        "output": str(args.output),
        "admitted_candidates_output": str(args.admitted_candidates_output)
        if args.admitted_candidates_output
        else None,
        "condition": args.condition,
        "base_condition": single_condition(base_rows, "base"),
        "hidden_tests_sent_to_model": False,
        "read_hidden_task_specs": False,
        "synthetic_rows": sum(1 for row in overlay_rows if row.get("synthetic")),
        "total_rows": len(overlay_rows),
        "target_task_ids": sorted(target_task_ids),
        "admitted_task_ids": admitted_task_ids,
        "admitted_row_count": len(admitted_task_ids),
        "rejected_task_ids": rejected_task_ids,
        "preserved_base_row_count": len(overlay_rows) - len(admitted_task_ids),
        "recipe_generated_rows": len(admitted_task_ids),
        "model_generated_rows": 0,
        "skill_memory_package_count": len(skill_memory["skills"]),
        "tasks": task_reports,
    }
    if args.report:
        write_json(args.report, report)
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--public-tasks", type=Path, required=True)
    parser.add_argument("--base-candidates", type=Path, required=True)
    parser.add_argument("--skill-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--admitted-candidates-output", type=Path)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--condition", default="skillgraph_anticipatory_public_repair_planner")
    parser.add_argument("--target-task-id", nargs="*", default=[])
    parser.add_argument(
        "--require-shared-failure-memory",
        action=argparse.BooleanOptionalAction,
        default=True,
    )
    parser.add_argument("--public-check-timeout-s", type=int, default=5)
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
        raise SystemExit(f"{path} contained no rows")
    return rows


def read_public_tasks(path: Path) -> list[dict[str, Any]]:
    rows = read_jsonl(path)
    for line_no, task in enumerate(rows, 1):
        for key in ("task_id", "candidate_paths", "public_prompt", "starter_files"):
            if key not in task:
                raise SystemExit(f"{path}:{line_no}: public task missing {key}")
        if len(task["candidate_paths"]) != 1:
            raise SystemExit(f"{path}:{line_no}: expected exactly one candidate path")
        candidate_path = str(task["candidate_paths"][0])
        validate_relative_path(candidate_path)
        if candidate_path not in task["starter_files"]:
            raise SystemExit(f"{path}:{line_no}: starter missing {candidate_path}")
    return rows


def rows_by_task(rows: list[dict[str, Any]], label: str) -> dict[str, dict[str, Any]]:
    by_task: dict[str, dict[str, Any]] = {}
    for row in rows:
        task_id = str(row.get("task_id", "")).strip()
        if not task_id:
            raise SystemExit(f"{label}: row missing task_id")
        if task_id in by_task:
            raise SystemExit(f"{label}: duplicate task_id {task_id}")
        by_task[task_id] = row
    return by_task


def validate_base_coverage(base_rows: list[dict[str, Any]], public_by_task: dict[str, Any]) -> None:
    base_ids = [str(row.get("task_id", "")) for row in base_rows]
    missing_public = sorted(set(base_ids) - set(public_by_task))
    if missing_public:
        raise SystemExit(f"base candidates reference public-missing tasks: {missing_public}")
    if len(base_ids) != len(set(base_ids)):
        raise SystemExit("base candidates contain duplicate task ids")


def validate_overlay_coverage(
    base_rows: list[dict[str, Any]], overlay_rows: list[dict[str, Any]]
) -> None:
    base_ids = [str(row.get("task_id", "")) for row in base_rows]
    overlay_ids = [str(row.get("task_id", "")) for row in overlay_rows]
    if base_ids != overlay_ids:
        raise SystemExit("overlay output changed base row order or coverage")


def single_condition(rows: list[dict[str, Any]], label: str) -> str:
    conditions = sorted({str(row.get("condition", "")).strip() for row in rows})
    if len(conditions) != 1 or not conditions[0]:
        raise SystemExit(f"{label}: expected exactly one non-empty condition, found {conditions}")
    return conditions[0]


def load_skill_memory(skill_dir: Path) -> dict[str, Any]:
    skills_path = skill_dir / "trajectory-skills.jsonl"
    router_path = skill_dir / "router-index.json"
    skills = read_jsonl(skills_path)
    router = json.loads(router_path.read_text(encoding="utf-8")) if router_path.exists() else {}
    enriched = []
    for skill in skills:
        package_dir = skill_dir / str(skill.get("package_dir", ""))
        memory_path = package_dir / "MEMORY.md"
        failure_path = package_dir / "failure_modes.json"
        skill = dict(skill)
        skill["memory_path"] = str(memory_path)
        skill["failure_modes_path"] = str(failure_path)
        skill["memory_excerpt"] = memory_path.read_text(encoding="utf-8") if memory_path.exists() else ""
        if failure_path.exists():
            skill["failure_modes"] = json.loads(failure_path.read_text(encoding="utf-8"))
        else:
            skill["failure_modes"] = {}
        enriched.append(skill)
    return {"skills": enriched, "router": router}


def classify_task(task: dict[str, Any]) -> Classification:
    candidate_path = str(task["candidate_paths"][0])
    starter = str(task["starter_files"][candidate_path])
    function_name = infer_function_name(starter)
    family = infer_family(candidate_path, task["task_id"])
    return Classification(
        task_id=str(task["task_id"]),
        candidate_path=candidate_path,
        module_name=module_name_from_path(candidate_path),
        function_name=function_name,
        family=family,
        failure_family=infer_failure_family(str(task["public_prompt"]), function_name),
    )


def infer_function_name(starter: str) -> str:
    try:
        tree = ast.parse(starter)
    except SyntaxError as exc:
        raise SystemExit(f"starter syntax failed: {exc}") from exc
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            return str(node.name)
    raise SystemExit("starter did not contain a top-level function")


def infer_family(candidate_path: str, task_id: str) -> str:
    stem = Path(candidate_path).stem
    if stem.endswith("_tools"):
        return stem[: -len("_tools")]
    parts = task_id.split("_")
    return parts[2] if len(parts) > 2 else "unknown"


def infer_failure_family(public_prompt: str, function_name: str) -> str:
    lowered = public_prompt.lower()
    if function_name == "parse_size_bytes" or "size string" in lowered:
        return "unit_suffix_parser"
    if function_name == "chunked_list" or "chunks" in lowered:
        return "sequence_chunking"
    if function_name == "split_filename_version" or "-v<number>" in lowered:
        return "filename_version_suffix"
    return "unclassified"


def module_name_from_path(path: str) -> str:
    without_suffix = path[:-3] if path.endswith(".py") else path
    return without_suffix.replace("/", ".")


def retrieve_memory(skill_memory: dict[str, Any], classification: Classification) -> dict[str, Any]:
    matches = []
    for skill in skill_memory["skills"]:
        if str(skill.get("family")) != classification.family:
            continue
        task_ids = set(str(task_id) for task_id in skill.get("shared_failure_task_ids", []))
        task_ids.update(str(task_id) for task_id in skill.get("repairs_task_ids", []))
        task_ids.update(str(task_id) for task_id in skill.get("preserved_pass_task_ids", []))
        if classification.task_id not in task_ids:
            continue
        matches.append(
            {
                "skill_id": skill.get("id"),
                "status": skill.get("status"),
                "family": skill.get("family"),
                "memory_path": skill.get("memory_path"),
                "failure_modes_path": skill.get("failure_modes_path"),
                "shared_failure_task_ids": skill.get("shared_failure_task_ids", []),
                "repairs_task_ids": skill.get("repairs_task_ids", []),
                "regression_task_ids": skill.get("regression_task_ids", []),
                "avoid_when": skill.get("avoid_when", []),
                "matched_memory_lines": matched_memory_lines(
                    str(skill.get("memory_excerpt", "")), classification.task_id
                ),
                "failure_modes": skill.get("failure_modes", {}),
            }
        )
    return {"matches": matches}


def matched_memory_lines(memory: str, task_id: str) -> list[str]:
    lines = []
    for line in memory.splitlines():
        if task_id in line:
            lines.append(line)
    return lines


def memory_is_eligible(task_id: str, memory: dict[str, Any], require_shared_failure: bool) -> bool:
    if not memory["matches"]:
        return False
    if not require_shared_failure:
        return True
    for match in memory["matches"]:
        shared = {str(item) for item in match.get("shared_failure_task_ids", [])}
        if task_id in shared:
            return True
    return False


def make_overlay_row(
    *,
    base_row: dict[str, Any],
    candidate_files: dict[str, str],
    condition: str,
    classification: Classification,
    recipe: Recipe,
    memory: dict[str, Any],
) -> dict[str, Any]:
    row = copy.deepcopy(base_row)
    row["condition"] = condition
    row["candidate_files"] = candidate_files
    row["synthetic"] = bool(base_row.get("synthetic", False))
    row["tests_included"] = False
    row["build_included"] = False
    tools = list(base_row.get("generated_tools") or [])
    tools.extend(["SkillGraphMemoryRetrieval", "AnticipatoryRepairPlanner", "PublicRecipeCheck"])
    row["generated_tools"] = tools
    skill_ids = [
        str(match.get("skill_id"))
        for match in memory.get("matches", [])
        if match.get("skill_id")
    ]
    row["source_artifact"] = (
        f"anticipatory-public-repair-planner:recipe={recipe.recipe_id}:"
        f"family={classification.family}:failure_family={classification.failure_family}:"
        f"skills={','.join(skill_ids)}:source={base_row.get('source_artifact', '')}"
    )
    return row


def make_preserve_row(base_row: dict[str, Any], condition: str) -> dict[str, Any]:
    row = copy.deepcopy(base_row)
    row["condition"] = condition
    row["generated_tools"] = list(base_row.get("generated_tools") or [])
    row["generated_tools"].append("AnticipatoryBasePreserve")
    row["source_artifact"] = (
        f"anticipatory-public-repair-planner:base-preserve:"
        f"source={base_row.get('source_artifact', '')}"
    )
    return row


def public_check_candidate(
    *,
    candidate_files: dict[str, str],
    task: dict[str, Any],
    classification: Classification,
    recipe: Recipe,
    timeout_s: int,
) -> dict[str, Any]:
    errors: list[str] = []
    candidate_path = classification.candidate_path
    source = candidate_files[candidate_path]
    if "```" in source:
        errors.append(f"{candidate_path}: markdown fence appears in source")
    try:
        compile(source, candidate_path, "exec")
    except SyntaxError as exc:
        errors.append(f"{candidate_path}: SyntaxError line {exc.lineno}: {exc.msg}")
    expected_defs = top_level_defs(str(task["starter_files"][candidate_path]))
    generated_defs = top_level_defs(source) if not errors else set()
    missing = sorted(expected_defs - generated_defs)
    if missing:
        errors.append(f"{candidate_path}: missing public starter definitions {missing}")
    if errors:
        return {"ok": False, "stage": "static", "errors": errors}

    with tempfile.TemporaryDirectory(prefix="tml-public-repair-check-") as tmp:
        workspace = Path(tmp)
        write_workspace_file(workspace, "src/__init__.py", "")
        write_workspace_file(workspace, candidate_path, source)
        probe = build_probe(classification, recipe)
        write_workspace_file(workspace, "public_check.py", probe)
        completed = subprocess.run(
            [sys.executable, "public_check.py"],
            cwd=workspace,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=timeout_s,
            check=False,
        )
    if completed.returncode != 0:
        return {
            "ok": False,
            "stage": "public_probe",
            "exit_code": completed.returncode,
            "errors": [completed.stderr[-1000:] or completed.stdout[-1000:]],
        }
    return {
        "ok": True,
        "stage": "public_probe",
        "exit_code": completed.returncode,
        "errors": [],
        "probe": recipe.recipe_id,
        "stdout_preview": completed.stdout[-500:],
    }


def top_level_defs(source: str) -> set[str]:
    tree = ast.parse(source)
    return {
        str(node.name)
        for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
    }


def build_probe(classification: Classification, recipe: Recipe) -> str:
    probe_body = textwrap.dedent(recipe.public_probe).strip()
    return (
        "import importlib\n\n"
        f"module = importlib.import_module({classification.module_name!r})\n"
        f"fn = getattr(module, {classification.function_name!r})\n\n"
        "def assert_raises(exc_type, thunk):\n"
        "    try:\n"
        "        thunk()\n"
        "    except exc_type:\n"
        "        return\n"
        "    raise AssertionError('expected ' + exc_type.__name__)\n\n"
        f"{probe_body}\n\n"
        "print('PUBLIC_CHECK_OK')\n"
    )


def write_workspace_file(workspace: Path, relative: str, content: str) -> None:
    validate_relative_path(relative)
    path = workspace / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def build_parse_size_bytes_recipe(
    task: dict[str, Any], classification: Classification
) -> Recipe:
    source = textwrap.dedent(
        """
        import re

        def parse_size_bytes(value):
            text = str(value).strip()
            match = re.fullmatch(r"(\\d+)\\s*(B|KB|MB|GB)?", text, re.IGNORECASE)
            if not match:
                raise ValueError("invalid size")
            number = int(match.group(1))
            unit = (match.group(2) or "B").upper()
            multipliers = {
                "B": 1,
                "KB": 1024,
                "MB": 1024 ** 2,
                "GB": 1024 ** 3,
            }
            return number * multipliers[unit]
        """
    ).strip() + "\n"
    public_probe = """
    assert fn("2KB") == 2048
    assert fn("3 mb") == 3 * 1024 * 1024
    assert fn("7") == 7
    assert fn("1 B") == 1
    assert_raises(ValueError, lambda: fn("1.5MB"))
    assert_raises(ValueError, lambda: fn("-1KB"))
    assert_raises(ValueError, lambda: fn("5XB"))
    """
    return Recipe(
        recipe_id="public_unit_suffix_parser_v1",
        family=classification.family,
        failure_family=classification.failure_family,
        source=source,
        public_probe=public_probe,
    )


def build_chunked_list_recipe(task: dict[str, Any], classification: Classification) -> Recipe:
    source = textwrap.dedent(
        """
        def chunked_list(items, size):
            if size <= 0:
                raise ValueError("size must be positive")
            seq = list(items)
            return [seq[index:index + size] for index in range(0, len(seq), size)]
        """
    ).strip() + "\n"
    public_probe = """
    assert fn([1, 2, 3, 4, 5], 2) == [[1, 2], [3, 4], [5]]
    assert fn([], 3) == []
    assert fn((item for item in [1, 2, 3]), 2) == [[1, 2], [3]]
    assert_raises(ValueError, lambda: fn([1], 0))
    assert_raises(ValueError, lambda: fn([1], -1))
    """
    return Recipe(
        recipe_id="public_sequence_chunking_v1",
        family=classification.family,
        failure_family=classification.failure_family,
        source=source,
        public_probe=public_probe,
    )


def build_split_filename_version_recipe(
    task: dict[str, Any], classification: Classification
) -> Recipe:
    source = textwrap.dedent(
        """
        import os
        import re

        def split_filename_version(name):
            stem, suffix = os.path.splitext(str(name))
            match = re.fullmatch(r"(.*)-v(\\d+)", stem)
            if not match:
                return (stem, None, suffix)
            return (match.group(1), int(match.group(2)), suffix)
        """
    ).strip() + "\n"
    public_probe = """
    assert fn("report-v12.txt") == ("report", 12, ".txt")
    assert fn("archive.tar") == ("archive", None, ".tar")
    assert fn("daily-report-v001.csv") == ("daily-report", 1, ".csv")
    assert fn("report-vx.txt") == ("report-vx", None, ".txt")
    assert fn("report-v12") == ("report", 12, "")
    """
    return Recipe(
        recipe_id="public_filename_version_suffix_v1",
        family=classification.family,
        failure_family=classification.failure_family,
        source=source,
        public_probe=public_probe,
    )


RECIPE_BUILDERS: dict[str, RecipeBuilder] = {
    "parse_size_bytes": build_parse_size_bytes_recipe,
    "chunked_list": build_chunked_list_recipe,
    "split_filename_version": build_split_filename_version_recipe,
}


def validate_relative_path(path: str) -> None:
    candidate = Path(path)
    if candidate.is_absolute() or not candidate.parts:
        raise ValueError(f"unsafe relative path {path!r}")
    if any(part in ("..", "") for part in candidate.parts):
        raise ValueError(f"unsafe relative path {path!r}")


def write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "".join(json.dumps(row, sort_keys=True) + "\n" for row in rows),
        encoding="utf-8",
    )


def write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")


if __name__ == "__main__":
    raise SystemExit(main())
