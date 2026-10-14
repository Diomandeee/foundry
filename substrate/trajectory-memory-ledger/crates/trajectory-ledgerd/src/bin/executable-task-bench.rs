use anyhow::{bail, Context, Result};
use clap::Parser;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[derive(Debug, Parser)]
#[command(name = "executable-task-bench")]
#[command(about = "Run executable held-out coding task candidates in isolated temp workspaces")]
struct Args {
    /// JSONL file with one executable task candidate per line.
    #[arg(long)]
    input: PathBuf,

    /// Optional output path for the aggregate JSON report.
    #[arg(long)]
    output: Option<PathBuf>,

    /// Keep per-row workspaces instead of deleting them.
    #[arg(long)]
    keep_workspaces: bool,

    /// Fail if any input row is marked synthetic.
    #[arg(long)]
    require_real: bool,
}

#[derive(Debug, Deserialize)]
struct TaskRow {
    condition: String,
    task_id: String,
    verifier_command: String,
    setup_files: BTreeMap<String, String>,
    candidate_files: BTreeMap<String, String>,
    #[serde(default = "default_expected_exit_code")]
    expected_exit_code: i32,
    #[serde(default = "default_timeout_ms")]
    timeout_ms: u64,
    #[serde(default)]
    generated_tools: Vec<String>,
    #[serde(default)]
    tests_included: bool,
    #[serde(default)]
    build_included: bool,
    #[serde(default)]
    benchmark_kind: Option<String>,
    #[serde(default)]
    task_set: Option<String>,
    #[serde(default)]
    source_artifact: Option<String>,
    #[serde(default)]
    synthetic: bool,
}

#[derive(Debug, Default)]
struct Accumulator {
    n: usize,
    passed: usize,
    timed_out: usize,
    valid_tool_plans: usize,
    tests_included: usize,
    build_included: usize,
    duration_sum_ms: u128,
    failed_task_ids: Vec<String>,
}

#[derive(Debug, Serialize)]
struct RowResult {
    condition: String,
    task_id: String,
    passed: bool,
    exit_code: Option<i32>,
    timed_out: bool,
    duration_ms: u128,
    stdout_preview: String,
    stderr_preview: String,
    workspace: Option<String>,
}

#[derive(Debug, Serialize)]
struct ConditionReport {
    n: usize,
    passed: usize,
    task_pass_rate: f64,
    timeout_rate: f64,
    valid_tool_plan_rate: f64,
    test_inclusion_rate: f64,
    build_inclusion_rate: f64,
    mean_duration_ms: f64,
    failed_task_ids: Vec<String>,
}

#[derive(Debug, Serialize)]
struct ExecutableBenchReport {
    input_rows: usize,
    benchmark_kinds: Vec<String>,
    task_sets: Vec<String>,
    source_artifacts: Vec<String>,
    synthetic_rows: usize,
    measures_executed_task_completion: bool,
    boundary: String,
    conditions: BTreeMap<String, ConditionReport>,
    row_results: Vec<RowResult>,
}

fn main() -> Result<()> {
    let args = Args::parse();
    let report = run_benchmark(&args.input, args.keep_workspaces, args.require_real)?;
    let rendered = serde_json::to_string_pretty(&report)?;
    println!("{rendered}");
    if let Some(output) = args.output {
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(output, rendered + "\n")?;
    }
    Ok(())
}

fn run_benchmark(
    input: &Path,
    keep_workspaces: bool,
    require_real: bool,
) -> Result<ExecutableBenchReport> {
    let file = fs::File::open(input)
        .with_context(|| format!("open executable benchmark input {}", input.display()))?;
    let mut by_condition: BTreeMap<String, Accumulator> = BTreeMap::new();
    let mut row_results = Vec::new();
    let mut benchmark_kinds = Vec::new();
    let mut task_sets = Vec::new();
    let mut source_artifacts = Vec::new();
    let mut synthetic_rows = 0usize;

    for (idx, line) in BufReader::new(file).lines().enumerate() {
        let line = line.with_context(|| format!("read input line {}", idx + 1))?;
        if line.trim().is_empty() {
            continue;
        }
        let row: TaskRow =
            serde_json::from_str(&line).with_context(|| format!("parse input line {}", idx + 1))?;
        validate_row(&row, idx + 1)?;
        push_unique_opt(&mut benchmark_kinds, &row.benchmark_kind);
        push_unique_opt(&mut task_sets, &row.task_set);
        push_unique_opt(&mut source_artifacts, &row.source_artifact);
        if row.synthetic {
            synthetic_rows += 1;
        }

        let workspace = create_workspace(&row, idx + 1)?;
        write_files(&workspace, &row.setup_files)?;
        write_files(&workspace, &row.candidate_files)?;
        let run = run_verifier(&workspace, &row.verifier_command, row.timeout_ms)?;
        let passed = !run.timed_out && run.exit_code == Some(row.expected_exit_code);

        let acc = by_condition.entry(row.condition.clone()).or_default();
        acc.n += 1;
        if passed {
            acc.passed += 1;
        } else {
            acc.failed_task_ids.push(row.task_id.clone());
        }
        if run.timed_out {
            acc.timed_out += 1;
        }
        if valid_tool_plan(&row.generated_tools) {
            acc.valid_tool_plans += 1;
        }
        if row.tests_included {
            acc.tests_included += 1;
        }
        if row.build_included {
            acc.build_included += 1;
        }
        acc.duration_sum_ms += run.duration_ms;

        let workspace_out = if keep_workspaces {
            Some(workspace.display().to_string())
        } else {
            fs::remove_dir_all(&workspace)
                .with_context(|| format!("remove workspace {}", workspace.display()))?;
            None
        };

        row_results.push(RowResult {
            condition: row.condition,
            task_id: row.task_id,
            passed,
            exit_code: run.exit_code,
            timed_out: run.timed_out,
            duration_ms: run.duration_ms,
            stdout_preview: preview(&run.stdout),
            stderr_preview: preview(&run.stderr),
            workspace: workspace_out,
        });
    }

    if row_results.is_empty() {
        bail!("executable benchmark input contained no rows");
    }
    if require_real && synthetic_rows > 0 {
        bail!("--require-real was set but input contained {synthetic_rows} synthetic row(s)");
    }

    let conditions = by_condition
        .into_iter()
        .map(|(condition, acc)| {
            let n = acc.n.max(1) as f64;
            (
                condition,
                ConditionReport {
                    n: acc.n,
                    passed: acc.passed,
                    task_pass_rate: round4(acc.passed as f64 / n),
                    timeout_rate: round4(acc.timed_out as f64 / n),
                    valid_tool_plan_rate: round4(acc.valid_tool_plans as f64 / n),
                    test_inclusion_rate: round4(acc.tests_included as f64 / n),
                    build_inclusion_rate: round4(acc.build_included as f64 / n),
                    mean_duration_ms: round4(acc.duration_sum_ms as f64 / n),
                    failed_task_ids: acc.failed_task_ids,
                },
            )
        })
        .collect();

    let boundary = if synthetic_rows == 0 {
        "Runs verifier commands in isolated temp workspaces and measures executable pass/fail. This report has synthetic_rows=0, so task pass rates are executable results for the supplied candidate/model-output rows."
    } else {
        "Runs verifier commands in isolated temp workspaces and measures executable pass/fail. Synthetic smoke rows validate the harness only and must not be cited as model-lift evidence."
    };

    Ok(ExecutableBenchReport {
        input_rows: row_results.len(),
        benchmark_kinds,
        task_sets,
        source_artifacts,
        synthetic_rows,
        measures_executed_task_completion: true,
        boundary: boundary.to_string(),
        conditions,
        row_results,
    })
}

#[derive(Debug)]
struct VerifierRun {
    exit_code: Option<i32>,
    timed_out: bool,
    duration_ms: u128,
    stdout: String,
    stderr: String,
}

fn run_verifier(workspace: &Path, command: &str, timeout_ms: u64) -> Result<VerifierRun> {
    let start = Instant::now();
    let mut child = Command::new("/bin/sh")
        .arg("-lc")
        .arg(command)
        .current_dir(workspace)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("spawn verifier command {command:?}"))?;
    let timeout = Duration::from_millis(timeout_ms);
    let mut timed_out = false;
    loop {
        if child.try_wait()?.is_some() {
            break;
        }
        if start.elapsed() >= timeout {
            timed_out = true;
            let _ = child.kill();
            break;
        }
        thread::sleep(Duration::from_millis(10));
    }
    let output = child
        .wait_with_output()
        .context("collect verifier output")?;
    Ok(VerifierRun {
        exit_code: output.status.code(),
        timed_out,
        duration_ms: start.elapsed().as_millis(),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    })
}

fn validate_row(row: &TaskRow, line: usize) -> Result<()> {
    if row.condition.trim().is_empty() {
        bail!("line {line}: condition is empty");
    }
    if row.task_id.trim().is_empty() {
        bail!("line {line}: task_id is empty");
    }
    if row.verifier_command.trim().is_empty() {
        bail!("line {line}: verifier_command is empty");
    }
    if row.setup_files.is_empty() {
        bail!("line {line}: setup_files must not be empty");
    }
    if row.candidate_files.is_empty() {
        bail!("line {line}: candidate_files must not be empty");
    }
    if row.timeout_ms == 0 {
        bail!("line {line}: timeout_ms must be positive");
    }
    for path in row.setup_files.keys().chain(row.candidate_files.keys()) {
        validate_relative_path(path)
            .with_context(|| format!("line {line}: invalid path {path}"))?;
    }
    Ok(())
}

fn write_files(workspace: &Path, files: &BTreeMap<String, String>) -> Result<()> {
    for (relative, content) in files {
        let path = workspace.join(relative);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&path, content).with_context(|| format!("write {}", path.display()))?;
    }
    Ok(())
}

fn create_workspace(row: &TaskRow, line: usize) -> Result<PathBuf> {
    let mut base = std::env::temp_dir();
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    base.push(format!(
        "tml-exec-bench-{}-{}-{}",
        std::process::id(),
        line,
        nanos
    ));
    fs::create_dir_all(&base).with_context(|| format!("create workspace for {}", row.task_id))?;
    Ok(base)
}

fn validate_relative_path(path: &str) -> Result<()> {
    let path = Path::new(path);
    if path.as_os_str().is_empty() {
        bail!("path is empty");
    }
    for component in path.components() {
        match component {
            Component::Normal(_) => {}
            _ => bail!("path must be a normal relative path"),
        }
    }
    Ok(())
}

fn valid_tool_plan(tools: &[String]) -> bool {
    if tools.is_empty() {
        return false;
    }
    tools.iter().all(|tool| {
        !tool.trim().is_empty()
            && tool != "unknown"
            && tool
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' || ch == ':')
    })
}

fn push_unique_opt(values: &mut Vec<String>, value: &Option<String>) {
    if let Some(value) = value {
        if !values.contains(value) {
            values.push(value.clone());
        }
    }
}

fn preview(value: &str) -> String {
    const MAX_PREVIEW: usize = 240;
    value.chars().take(MAX_PREVIEW).collect()
}

fn round4(value: f64) -> f64 {
    let value = if value.is_finite() { value } else { 0.0 };
    (value * 10000.0).round() / 10000.0
}

fn default_expected_exit_code() -> i32 {
    0
}

fn default_timeout_ms() -> u64 {
    5_000
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_parent_directory_paths() {
        assert!(validate_relative_path("../escape.rs").is_err());
    }

    #[test]
    fn accepts_nested_relative_paths() {
        assert!(validate_relative_path("src/lib.rs").is_ok());
    }

    #[test]
    fn detects_valid_tool_plan() {
        assert!(valid_tool_plan(&["Read".to_string(), "Bash".to_string()]));
        assert!(!valid_tool_plan(&["unknown".to_string()]));
    }
}
