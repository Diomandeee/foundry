#!/usr/bin/env python3
"""
Generate executable benchmark candidate rows from local MLX LoRA adapters.

The script sends only public task prompts to the local model. Hidden verifier
tests remain in the task-spec JSONL and are introduced later by
materialize-executable-bench.
"""

from __future__ import annotations

import argparse
import ast
import json
import os
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


CONDITIONS = ("random", "reward_selected", "full_ledger")
DEFAULT_EXTRA_EOS_TOKENS = ("<end_of_turn>", "<start_of_turn>")


def main() -> int:
    args = parse_args()
    public_tasks = read_jsonl(args.public_tasks)
    task_ids = [task["task_id"] for task in public_tasks]
    args.raw_dir.mkdir(parents=True, exist_ok=True)

    rows: list[dict[str, Any]] = []
    report: dict[str, Any] = {
        "generator": "generate_executable_candidates_mlx_adapter.py",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "backend": "python -m mlx_lm generate",
        "model": args.model,
        "public_tasks": str(args.public_tasks),
        "adapter_root_recorded": False,
        "raw_dir": str(args.raw_dir),
        "synthetic_rows": 0,
        "hidden_tests_sent_to_model": False,
        "conditions": {},
        "generation": {
            "max_tokens": args.max_tokens,
            "temp": args.temp,
            "top_p": args.top_p,
            "timeout_s": args.timeout_s,
            "seed": args.seed,
            "prompt_format": args.prompt_format,
            "extra_eos_token": args.extra_eos_token,
            "env": {"KMP_DUPLICATE_LIB_OK": "TRUE"} if args.openmp_workaround else {},
        },
    }

    for condition in args.conditions:
        adapter_path = args.adapter_root / condition
        validate_adapter(condition, adapter_path)
        condition_rows: list[dict[str, Any]] = []
        condition_report = {
            "rows": 0,
            "tasks": {},
            "adapter_path_recorded": False,
            "repair_attempts": args.repair_attempts,
        }
        for task_index, task in enumerate(public_tasks):
            prompt = build_initial_prompt(task, args.prompt_format)
            task_report: dict[str, Any] = {"attempts": []}
            candidate_files: dict[str, str] | None = None
            parse_mode = "unparsed"
            public_check = public_check_failure("no candidate generated")

            for attempt in range(args.repair_attempts + 1):
                raw_path = args.raw_dir / condition / task["task_id"] / f"attempt-{attempt}.raw.txt"
                raw_path.parent.mkdir(parents=True, exist_ok=True)
                response = call_mlx_generate(
                    args,
                    prompt,
                    adapter_path,
                    seed=args.seed + task_index + (attempt * 10_000),
                )
                raw_path.write_text(response, encoding="utf-8")
                try:
                    candidate_files, parse_mode = parse_model_response(
                        response,
                        task,
                        prefer_raw_python=args.prompt_format == "raw-python",
                    )
                except ValueError as exc:
                    candidate_files = fallback_model_output(response, task)
                    parse_mode = "unparsed_model_output"
                    public_check = public_check_failure(str(exc))
                else:
                    public_check = public_check_candidate(candidate_files, task)

                task_report["attempts"].append(
                    {
                        "attempt": attempt,
                        "raw_response": str(raw_path),
                        "parse_mode": parse_mode,
                        "public_check": public_check,
                    }
                )
                if public_check["ok"]:
                    break
                if attempt < args.repair_attempts:
                    prompt = build_repair_prompt(task, candidate_files, public_check, response)

            if candidate_files is None:
                raise SystemExit(f"{condition}/{task['task_id']}: no candidate was generated")

            row = normalize_candidate_row(
                condition=condition,
                task=task,
                candidate_files=candidate_files,
                source_artifact=f"mlx:{args.model}:adapter={condition}",
            )
            condition_rows.append(row)
            task_report["final_parse_mode"] = parse_mode
            task_report["final_public_check"] = public_check
            condition_report["tasks"][task["task_id"]] = task_report
        validate_condition_coverage(condition, condition_rows, task_ids)
        rows.extend(condition_rows)
        condition_report["rows"] = len(condition_rows)
        report["conditions"][condition] = condition_report

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
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--raw-dir", type=Path, required=True)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--model", default="mlx-community/gemma-3-1b-it-4bit")
    parser.add_argument("--adapter-root", type=Path, default=Path("output/private-adapters"))
    parser.add_argument("--conditions", nargs="+", choices=CONDITIONS, default=list(CONDITIONS))
    parser.add_argument("--python", default="python3")
    parser.add_argument("--max-tokens", type=int, default=2048)
    parser.add_argument("--temp", type=float, default=0.0)
    parser.add_argument("--top-p", type=float, default=1.0)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--timeout-s", type=int, default=360)
    parser.add_argument("--extra-eos-token", nargs="*", default=list(DEFAULT_EXTRA_EOS_TOKENS))
    parser.add_argument("--openmp-workaround", action=argparse.BooleanOptionalAction, default=False)
    parser.add_argument("--repair-attempts", type=int, default=2)
    parser.add_argument("--prompt-format", choices=("json", "raw-python"), default="json")
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
        raise SystemExit(f"{line_no}: MLX generator expects one candidate path per task")


def validate_adapter(condition: str, adapter_path: Path) -> None:
    if not adapter_path.exists():
        raise SystemExit(f"{condition}: adapter path does not exist: {adapter_path}")
    expected = (adapter_path / "adapters.safetensors", adapter_path / "adapter_config.json")
    if not any(path.exists() for path in expected):
        files = sorted(path.name for path in adapter_path.glob("*"))
        raise SystemExit(f"{condition}: adapter path lacks expected MLX adapter files; found {files}")


def build_json_prompt(task: dict[str, Any]) -> str:
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

Return ONLY valid JSON with this exact shape:
{{
  "candidate_files": {{
    "{candidate_path}": "complete Python source code"
  }}
}}

Rules:
- Use only Python standard library.
- Do not include markdown fences, tests, explanations, or extra keys.
- The file content must be complete source code for {candidate_path}.
"""


def build_initial_prompt(task: dict[str, Any], prompt_format: str) -> str:
    if prompt_format == "raw-python":
        return build_raw_python_prompt(task)
    if prompt_format == "json":
        return build_json_prompt(task)
    raise ValueError(f"unsupported prompt format {prompt_format!r}")


def build_raw_python_prompt(task: dict[str, Any]) -> str:
    candidate_path = task["candidate_paths"][0]
    starter = task["starter_files"][candidate_path]
    return f"""Implement this Python file for an executable benchmark.

Path: {candidate_path}
Public prompt:
{task["public_prompt"]}

Starter file:
{starter}

Return only the complete Python source code for {candidate_path}.
Begin immediately with a Python import, class, or def line.
Do not include markdown, JSON, file paths, tests, explanations, analysis, or reasoning-channel text.
"""


def build_repair_prompt(
    task: dict[str, Any],
    candidate_files: dict[str, str] | None,
    check: dict[str, Any],
    raw_response: str,
) -> str:
    candidate_path = task["candidate_paths"][0]
    previous = raw_response
    if candidate_files and candidate_path in candidate_files:
        previous = candidate_files[candidate_path]
    errors = "\n".join(f"- {error}" for error in check.get("errors", []))
    return f"""Repair this Python candidate using only public compatibility feedback.

Path: {candidate_path}
Public prompt: {task["public_prompt"]}
Starter file:
{task["starter_files"][candidate_path]}

Previous candidate:
{clip(previous, 6000)}

Public compatibility errors:
{errors}

Return only the complete corrected Python source code for {candidate_path}.
Begin immediately with a Python import, class, or def line.
Do not include markdown, JSON, file paths, tests, explanations, analysis, or reasoning-channel text.
"""


def call_mlx_generate(args: argparse.Namespace, prompt: str, adapter_path: Path, seed: int) -> str:
    command = [
        args.python,
        "-m",
        "mlx_lm",
        "generate",
        "--model",
        args.model,
        "--adapter-path",
        str(adapter_path),
        "--prompt",
        "-",
        "--max-tokens",
        str(args.max_tokens),
        "--temp",
        str(args.temp),
        "--top-p",
        str(args.top_p),
        "--seed",
        str(seed),
        "--verbose",
        "False",
    ]
    if args.extra_eos_token:
        command.extend(["--extra-eos-token", *args.extra_eos_token])
    env = os.environ.copy()
    if args.openmp_workaround:
        env["KMP_DUPLICATE_LIB_OK"] = "TRUE"
    completed = subprocess.run(
        command,
        input=prompt,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
        timeout=args.timeout_s,
        env=env,
    )
    response = completed.stdout.strip()
    if completed.returncode != 0:
        raise SystemExit(
            "mlx_lm generate exited "
            f"{completed.returncode}\nSTDERR:\n{completed.stderr[-2000:]}\nSTDOUT:\n{response[-1000:]}"
        )
    if not response:
        raise SystemExit("mlx_lm generate returned an empty response")
    return response


def parse_candidate_files(response: str, task: dict[str, Any]) -> tuple[dict[str, str], str]:
    response = clean_model_text(response)
    parsed = parse_response_json(response)
    if isinstance(parsed, dict) and "candidates" in parsed:
        candidates = parsed["candidates"]
        if isinstance(candidates, list) and candidates:
            parsed = candidates[0]
    if isinstance(parsed, dict) and "candidate" in parsed:
        parsed = parsed["candidate"]
    if not isinstance(parsed, dict):
        raise ValueError("response JSON was not an object")
    files = parsed.get("candidate_files")
    if not isinstance(files, dict):
        raise ValueError("response JSON did not contain candidate_files")
    return normalize_files(files, task), "json"


def parse_model_response(
    response: str,
    task: dict[str, Any],
    *,
    prefer_raw_python: bool,
) -> tuple[dict[str, str], str]:
    parsers = (
        (parse_raw_python_response, parse_candidate_files)
        if prefer_raw_python
        else (parse_candidate_files, parse_raw_python_response)
    )
    errors: list[str] = []
    for parser in parsers:
        try:
            return parser(response, task)
        except ValueError as exc:
            errors.append(str(exc))
    raise ValueError("; ".join(errors))


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


def parse_raw_python_response(response: str, task: dict[str, Any]) -> tuple[dict[str, str], str]:
    code = extract_python_code(clean_model_text(response))
    if not code.strip():
        raise ValueError(f"{task['task_id']}: response did not contain Python source")
    return normalize_files({task["candidate_paths"][0]: code}, task), "raw_python"


def fallback_model_output(response: str, task: dict[str, Any]) -> dict[str, str]:
    candidate_path = task["candidate_paths"][0]
    cleaned = clean_model_text(response).strip()
    if not cleaned:
        cleaned = "raise NotImplementedError('empty model output')"
    return normalize_files({candidate_path: cleaned + "\n"}, task)


def extract_python_code(response: str) -> str:
    cleaned = clean_model_text(response)
    stripped = cleaned.strip()
    candidates = [
        match.group(1).strip()
        for match in re.finditer(r"```(?:python|py)?\s*(.*?)```", stripped, flags=re.DOTALL)
    ]
    code_start = re.search(r"(?m)^\s*(def|class|import|from)\s+", stripped)
    if code_start:
        candidates.append(stripped[code_start.start() :].strip())
    for candidate in reversed(candidates):
        if not candidate:
            continue
        try:
            compile(candidate, "<model-response>", "exec")
        except SyntaxError:
            continue
        return candidate.strip() + "\n"
    if candidates:
        return candidates[-1].strip() + "\n"
    return ""


def clean_model_text(response: str) -> str:
    lines = []
    for line in response.splitlines():
        if line.startswith("Calling `python -m mlx_lm.generate...` directly is deprecated."):
            continue
        lines.append(line)
    cleaned = "\n".join(lines)
    cleaned = re.sub(r"<\|turn\>\s*model\s*", "", cleaned)
    cleaned = re.sub(r"<\|?channel\|?>\s*(?:thought|analysis|final)?\s*", "", cleaned)
    marker_positions = [
        idx for marker in DEFAULT_EXTRA_EOS_TOKENS if (idx := cleaned.find(marker)) != -1
    ]
    if marker_positions:
        cleaned = cleaned[: min(marker_positions)]
    return cleaned.strip()


def normalize_files(files: dict[str, Any], task: dict[str, Any]) -> dict[str, str]:
    allowed_paths = set(task["candidate_paths"])
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
        "generated_tools": ["MLXGenerate"],
        "tests_included": False,
        "build_included": False,
        "source_artifact": source_artifact,
        "synthetic": False,
    }


def public_check_candidate(candidate_files: dict[str, str], task: dict[str, Any]) -> dict[str, Any]:
    errors: list[str] = []
    for path, content in candidate_files.items():
        if "```" in content:
            errors.append(f"{path}: markdown fence appears in candidate source")
        for marker in DEFAULT_EXTRA_EOS_TOKENS:
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
