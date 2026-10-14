#!/usr/bin/env python3
"""
Generate executable benchmark candidate rows with a local MLX-VLM model.

The script sends only public task prompts and starter files to the model.
Hidden verifier tests remain in the canonical task-spec JSONL and are joined
later by materialize-executable-bench.
"""

from __future__ import annotations

import argparse
import ast
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


DEFAULT_EOS_TOKENS = ("<turn|>", "<end_of_turn>", "<start_of_turn>")


def main() -> int:
    args = parse_args()
    public_tasks = read_jsonl(args.public_tasks)
    task_ids = [task["task_id"] for task in public_tasks]
    args.raw_dir.mkdir(parents=True, exist_ok=True)

    from mlx_vlm import generate, load
    from mlx_vlm.prompt_utils import apply_chat_template
    from mlx_vlm.utils import load_config

    model, processor = load(str(args.model_path))
    config = load_config(str(args.model_path))

    rows: list[dict[str, Any]] = []
    report: dict[str, Any] = {
        "generator": "generate_executable_candidates_mlx_vlm.py",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "backend": "mlx_vlm.generate",
        "model_label": args.model_label,
        "model_path_recorded": False,
        "public_tasks": str(args.public_tasks),
        "raw_dir": str(args.raw_dir),
        "synthetic_rows": 0,
        "hidden_tests_sent_to_model": False,
        "condition": args.condition,
        "generation": {
            "max_tokens": args.max_tokens,
            "temperature": args.temperature,
            "eos_tokens": args.eos_tokens,
            "chat_template": args.chat_template,
            "repair_attempts": args.repair_attempts,
        },
        "tasks": {},
    }

    for task_index, task in enumerate(public_tasks):
        prompt = build_generation_prompt(task)
        task_report: dict[str, Any] = {
            "candidate_path": task["candidate_paths"][0],
            "attempts": [],
            "final_public_check": None,
            "final_parse_mode": None,
        }
        candidate_files: dict[str, str] | None = None
        parse_mode = "unparsed"
        check = public_check_failure("no candidate generated")

        for attempt in range(args.repair_attempts + 1):
            formatted_prompt = (
                apply_chat_template(processor, config, prompt)
                if args.chat_template
                else prompt
            )
            result = generate(
                model,
                processor,
                prompt=formatted_prompt,
                max_tokens=args.max_tokens,
                temperature=args.temperature,
                verbose=False,
                eos_tokens=args.eos_tokens,
            )
            response = extract_result_text(result)
            raw_path = args.raw_dir / args.condition / task["task_id"] / f"attempt-{attempt}.raw.txt"
            raw_path.parent.mkdir(parents=True, exist_ok=True)
            raw_path.write_text(response, encoding="utf-8")

            try:
                candidate_files, parse_mode = parse_candidate_files(response, task)
                check = public_check_candidate(candidate_files, task)
            except ValueError as exc:
                parse_mode = "unparsed_model_output"
                candidate_files = fallback_model_output(response, task)
                check = public_check_failure(str(exc))

            task_report["attempts"].append(
                {
                    "attempt": attempt,
                    "raw_response": str(raw_path),
                    "parse_mode": parse_mode,
                    "public_check": check,
                }
            )
            if check["ok"]:
                break
            if attempt < args.repair_attempts:
                prompt = build_repair_prompt(task, candidate_files, check, response)

        if candidate_files is None:
            raise SystemExit(f"{task['task_id']}: no candidate was generated")
        task_report["final_public_check"] = check
        task_report["final_parse_mode"] = parse_mode
        report["tasks"][task["task_id"]] = task_report
        rows.append(
            normalize_candidate_row(
                condition=args.condition,
                task=task,
                candidate_files=candidate_files,
                source_artifact=f"mlx-vlm:{args.model_label}:base",
            )
        )

    validate_condition_coverage(args.condition, rows, task_ids)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        "".join(json.dumps(row, sort_keys=True) + "\n" for row in rows),
        encoding="utf-8",
    )
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--public-tasks", type=Path, required=True)
    parser.add_argument("--model-path", type=Path, required=True)
    parser.add_argument("--model-label", required=True)
    parser.add_argument("--condition", default="gemma4_e2b_qat_base")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--raw-dir", type=Path, required=True)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--max-tokens", type=int, default=2048)
    parser.add_argument("--temperature", type=float, default=0.0)
    parser.add_argument("--repair-attempts", type=int, default=2)
    parser.add_argument("--eos-tokens", nargs="*", default=list(DEFAULT_EOS_TOKENS))
    parser.add_argument("--chat-template", action=argparse.BooleanOptionalAction, default=True)
    return parser.parse_args()


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows = []
    with path.open(encoding="utf-8") as handle:
        for line_no, line in enumerate(handle, 1):
            if not line.strip():
                continue
            row = json.loads(line)
            validate_public_task(row, line_no)
            rows.append(row)
    if not rows:
        raise SystemExit(f"{path} contained no rows")
    return rows


def validate_public_task(task: dict[str, Any], line_no: int) -> None:
    for key in ("task_id", "candidate_paths", "public_prompt", "starter_files"):
        if key not in task:
            raise SystemExit(f"{line_no}: public task missing {key}")
    if len(task["candidate_paths"]) != 1:
        raise SystemExit(f"{line_no}: MLX-VLM generator expects one candidate path per task")
    candidate_path = task["candidate_paths"][0]
    if candidate_path not in task["starter_files"]:
        raise SystemExit(f"{line_no}: starter_files missing candidate path {candidate_path}")
    validate_relative_path(candidate_path)


def build_generation_prompt(task: dict[str, Any]) -> str:
    candidate_path = task["candidate_paths"][0]
    task_block = json.dumps(
        {
            "task_id": task["task_id"],
            "candidate_path": candidate_path,
            "public_prompt": task["public_prompt"],
            "starter_file": task["starter_files"][candidate_path],
        },
        indent=2,
        sort_keys=True,
    )
    return f"""You are solving one public Python coding task for an executable benchmark.

Hidden tests are not shown. Implement only the requested candidate file.

Task:
{task_block}

Return only the complete Python source code for {candidate_path}.

Rules:
- Preserve the public starter signature.
- Use only the Python standard library.
- Do not include markdown fences, tests, explanations, or extra files.
- Do not mention hidden tests.
"""


def build_repair_prompt(
    task: dict[str, Any],
    candidate_files: dict[str, str] | None,
    check: dict[str, Any],
    raw_response: str,
) -> str:
    candidate_path = task["candidate_paths"][0]
    previous = ""
    if candidate_files and candidate_path in candidate_files:
        previous = candidate_files[candidate_path]
    else:
        previous = raw_response
    previous = clip(previous, 6000)
    errors = "\n".join(f"- {error}" for error in check.get("errors", []))
    return f"""Repair this Python candidate using only public compatibility feedback.

Path: {candidate_path}
Public prompt: {task["public_prompt"]}
Starter file:
{task["starter_files"][candidate_path]}

Previous candidate:
{previous}

Public compatibility errors:
{errors}

Return only the complete corrected Python source code for {candidate_path}. No markdown. No explanation. No tests.
"""


def extract_result_text(result: Any) -> str:
    text = result.text if hasattr(result, "text") else result
    if not isinstance(text, str):
        text = str(text)
    return clean_model_text(text)


def parse_candidate_files(response: str, task: dict[str, Any]) -> tuple[dict[str, str], str]:
    cleaned = clean_model_text(response)
    try:
        parsed = parse_response_json(cleaned)
    except ValueError:
        parsed = None
    if isinstance(parsed, dict):
        if "candidate_files" in parsed:
            return normalize_files(parsed["candidate_files"], task), "json_candidate_files"
        candidate_path = task["candidate_paths"][0]
        if candidate_path in parsed:
            return normalize_files({candidate_path: parsed[candidate_path]}, task), "json_path_map"
    code = extract_python_code(cleaned)
    if code.strip():
        return normalize_files({task["candidate_paths"][0]: code}, task), "raw_python"
    raise ValueError("response did not contain parseable Python source")


def parse_response_json(response: str) -> Any:
    response = clean_model_text(response)
    fenced = re.search(r"```(?:json)?\s*(.*?)```", response, flags=re.DOTALL)
    if fenced:
        response = fenced.group(1).strip()
    decoder = json.JSONDecoder()
    starts = [idx for idx, char in enumerate(response) if char in "[{"]
    for start in starts:
        try:
            parsed, _ = decoder.raw_decode(response[start:])
            return parsed
        except json.JSONDecodeError:
            continue
    raise ValueError("could not parse JSON from response")


def extract_python_code(response: str) -> str:
    cleaned = clean_model_text(response)
    fenced = re.search(r"```(?:python|py)?\s*(.*?)```", cleaned.strip(), flags=re.DOTALL)
    if fenced:
        return fenced.group(1).strip() + "\n"
    stripped = cleaned.strip()
    code_start = re.search(r"(?m)^\s*(def|class|import|from)\s+", stripped)
    if code_start:
        return stripped[code_start.start() :].strip() + "\n"
    return ""


def fallback_model_output(response: str, task: dict[str, Any]) -> dict[str, str]:
    candidate_path = task["candidate_paths"][0]
    cleaned = clean_model_text(response).strip()
    if not cleaned:
        cleaned = "raise NotImplementedError('empty model output')"
    return normalize_files({candidate_path: cleaned + "\n"}, task)


def clean_model_text(response: str) -> str:
    cleaned = response.strip()
    marker_positions = [
        idx for marker in DEFAULT_EOS_TOKENS if (idx := cleaned.find(marker)) != -1
    ]
    if marker_positions:
        cleaned = cleaned[: min(marker_positions)]
    return cleaned.strip()


def normalize_files(files: dict[str, Any], task: dict[str, Any]) -> dict[str, str]:
    allowed_paths = set(task["candidate_paths"])
    if not isinstance(files, dict):
        raise ValueError("candidate_files was not an object")
    normalized: dict[str, str] = {}
    for path, content in files.items():
        if path not in allowed_paths:
            raise ValueError(f"{task['task_id']}: path {path!r} not allowed")
        if not isinstance(content, str) or not content.strip():
            raise ValueError(f"{task['task_id']}: empty content for {path}")
        validate_relative_path(path)
        normalized[path] = content if content.endswith("\n") else content + "\n"
    if set(normalized) != allowed_paths:
        raise ValueError(f"{task['task_id']}: expected paths {sorted(allowed_paths)}, got {sorted(normalized)}")
    return normalized


def public_check_candidate(candidate_files: dict[str, str], task: dict[str, Any]) -> dict[str, Any]:
    errors: list[str] = []
    for path, content in candidate_files.items():
        if "```" in content:
            errors.append(f"{path}: markdown fence appears in candidate source")
        for marker in DEFAULT_EOS_TOKENS:
            if marker in content:
                errors.append(f"{path}: stop marker {marker!r} appears in candidate source")
        try:
            compile(content, path, "exec")
        except SyntaxError as exc:
            errors.append(f"{path}: SyntaxError line {exc.lineno}: {exc.msg}")
            continue
        except Exception as exc:  # pragma: no cover - compile rarely raises other exceptions.
            errors.append(f"{path}: compile failed: {exc}")
            continue
        try:
            generated_defs = top_level_defs(content)
            expected_defs = top_level_defs(task["starter_files"][path])
        except SyntaxError as exc:
            errors.append(f"{path}: AST parse failed line {exc.lineno}: {exc.msg}")
            continue
        missing = sorted(expected_defs - generated_defs)
        if missing:
            errors.append(f"{path}: missing public starter definitions: {missing}")
    return {"ok": not errors, "errors": errors}


def public_check_failure(error: str) -> dict[str, Any]:
    return {"ok": False, "errors": [error]}


def top_level_defs(source: str) -> set[str]:
    tree = ast.parse(source)
    return {
        node.name
        for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
    }


def normalize_candidate_row(
    condition: str,
    task: dict[str, Any],
    candidate_files: dict[str, str],
    source_artifact: str,
) -> dict[str, Any]:
    return {
        "condition": condition,
        "task_id": task["task_id"],
        "candidate_files": candidate_files,
        "generated_tools": ["MLXVLMGenerate"],
        "tests_included": False,
        "build_included": False,
        "source_artifact": source_artifact,
        "synthetic": False,
    }


def validate_relative_path(path: str) -> None:
    candidate = Path(path)
    if candidate.is_absolute() or ".." in candidate.parts or not candidate.parts:
        raise ValueError(f"unsafe relative path {path!r}")


def validate_condition_coverage(condition: str, rows: list[dict[str, Any]], task_ids: list[str]) -> None:
    observed = [row["task_id"] for row in rows]
    if sorted(observed) != sorted(task_ids):
        raise SystemExit(
            f"{condition}: expected task ids {sorted(task_ids)}, observed {sorted(observed)}"
        )
    if len(observed) != len(set(observed)):
        raise SystemExit(f"{condition}: duplicate task ids in generated rows")


def clip(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + "\n...<truncated public repair context>..."


if __name__ == "__main__":
    raise SystemExit(main())
