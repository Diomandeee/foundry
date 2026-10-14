use anyhow::{bail, Context, Result};
use clap::Parser;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Parser)]
#[command(name = "materialize-executable-bench")]
#[command(about = "Join canonical executable task specs with candidate/model output rows")]
struct Args {
    /// JSONL file with one canonical task spec per line.
    #[arg(long)]
    tasks: PathBuf,

    /// JSONL file with one candidate/model output per line.
    #[arg(long)]
    candidates: PathBuf,

    /// Output JSONL path for executable-task-bench rows.
    #[arg(long)]
    output: PathBuf,
}

#[derive(Debug, Clone, Deserialize)]
struct TaskSpec {
    task_id: String,
    setup_files: BTreeMap<String, String>,
    verifier_command: String,
    #[serde(default = "default_expected_exit_code")]
    expected_exit_code: i32,
    #[serde(default = "default_timeout_ms")]
    timeout_ms: u64,
    #[serde(default)]
    benchmark_kind: Option<String>,
    #[serde(default)]
    task_set: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CandidateSpec {
    condition: String,
    task_id: String,
    candidate_files: BTreeMap<String, String>,
    #[serde(default)]
    generated_tools: Vec<String>,
    #[serde(default)]
    tests_included: bool,
    #[serde(default)]
    build_included: bool,
    #[serde(default)]
    source_artifact: Option<String>,
    #[serde(default)]
    synthetic: bool,
}

#[derive(Debug, Serialize)]
struct ExecutableTaskRow {
    condition: String,
    task_id: String,
    verifier_command: String,
    setup_files: BTreeMap<String, String>,
    candidate_files: BTreeMap<String, String>,
    expected_exit_code: i32,
    timeout_ms: u64,
    generated_tools: Vec<String>,
    tests_included: bool,
    build_included: bool,
    benchmark_kind: Option<String>,
    task_set: Option<String>,
    source_artifact: Option<String>,
    synthetic: bool,
}

#[derive(Debug, Serialize)]
struct MaterializeReport {
    task_specs: usize,
    candidate_rows: usize,
    output_rows: usize,
    output: String,
}

fn main() -> Result<()> {
    let args = Args::parse();
    let report = materialize(&args.tasks, &args.candidates, &args.output)?;
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

fn materialize(tasks: &Path, candidates: &Path, output: &Path) -> Result<MaterializeReport> {
    let task_specs = read_tasks(tasks)?;
    let candidate_rows = read_candidates(candidates)?;
    if candidate_rows.is_empty() {
        bail!("candidate input contained no rows");
    }

    let mut rendered = String::new();
    for (idx, candidate) in candidate_rows.iter().enumerate() {
        validate_candidate(candidate, idx + 1)?;
        let task = task_specs.get(&candidate.task_id).with_context(|| {
            format!("candidate references unknown task_id {}", candidate.task_id)
        })?;
        let row = ExecutableTaskRow {
            condition: candidate.condition.clone(),
            task_id: candidate.task_id.clone(),
            verifier_command: task.verifier_command.clone(),
            setup_files: task.setup_files.clone(),
            candidate_files: candidate.candidate_files.clone(),
            expected_exit_code: task.expected_exit_code,
            timeout_ms: task.timeout_ms,
            generated_tools: candidate.generated_tools.clone(),
            tests_included: candidate.tests_included,
            build_included: candidate.build_included,
            benchmark_kind: task.benchmark_kind.clone(),
            task_set: task.task_set.clone(),
            source_artifact: candidate.source_artifact.clone(),
            synthetic: candidate.synthetic,
        };
        rendered.push_str(&serde_json::to_string(&row)?);
        rendered.push('\n');
    }

    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(output, rendered).with_context(|| format!("write {}", output.display()))?;
    Ok(MaterializeReport {
        task_specs: task_specs.len(),
        candidate_rows: candidate_rows.len(),
        output_rows: candidate_rows.len(),
        output: output.display().to_string(),
    })
}

fn read_tasks(path: &Path) -> Result<BTreeMap<String, TaskSpec>> {
    let file =
        fs::File::open(path).with_context(|| format!("open task specs {}", path.display()))?;
    let mut specs = BTreeMap::new();
    for (idx, line) in BufReader::new(file).lines().enumerate() {
        let line = line.with_context(|| format!("read task spec line {}", idx + 1))?;
        if line.trim().is_empty() {
            continue;
        }
        let spec: TaskSpec = serde_json::from_str(&line)
            .with_context(|| format!("parse task spec line {}", idx + 1))?;
        validate_task(&spec, idx + 1)?;
        if specs.insert(spec.task_id.clone(), spec).is_some() {
            bail!("duplicate task_id on task spec line {}", idx + 1);
        }
    }
    if specs.is_empty() {
        bail!("task spec input contained no rows");
    }
    Ok(specs)
}

fn read_candidates(path: &Path) -> Result<Vec<CandidateSpec>> {
    let file =
        fs::File::open(path).with_context(|| format!("open candidates {}", path.display()))?;
    let mut rows = Vec::new();
    for (idx, line) in BufReader::new(file).lines().enumerate() {
        let line = line.with_context(|| format!("read candidate line {}", idx + 1))?;
        if line.trim().is_empty() {
            continue;
        }
        let row: CandidateSpec = serde_json::from_str(&line)
            .with_context(|| format!("parse candidate line {}", idx + 1))?;
        rows.push(row);
    }
    Ok(rows)
}

fn validate_task(spec: &TaskSpec, line: usize) -> Result<()> {
    if spec.task_id.trim().is_empty() {
        bail!("line {line}: task_id is empty");
    }
    if spec.setup_files.is_empty() {
        bail!("line {line}: setup_files must not be empty");
    }
    if spec.verifier_command.trim().is_empty() {
        bail!("line {line}: verifier_command is empty");
    }
    if spec.timeout_ms == 0 {
        bail!("line {line}: timeout_ms must be positive");
    }
    for path in spec.setup_files.keys() {
        validate_relative_path(path)
            .with_context(|| format!("line {line}: invalid path {path}"))?;
    }
    Ok(())
}

fn validate_candidate(candidate: &CandidateSpec, line: usize) -> Result<()> {
    if candidate.condition.trim().is_empty() {
        bail!("candidate line {line}: condition is empty");
    }
    if candidate.task_id.trim().is_empty() {
        bail!("candidate line {line}: task_id is empty");
    }
    if candidate.candidate_files.is_empty() {
        bail!("candidate line {line}: candidate_files must not be empty");
    }
    for path in candidate.candidate_files.keys() {
        validate_relative_path(path)
            .with_context(|| format!("candidate line {line}: invalid path {path}"))?;
    }
    Ok(())
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
    fn rejects_unsafe_task_paths() {
        assert!(validate_relative_path("/tmp/escape.py").is_err());
        assert!(validate_relative_path("../escape.py").is_err());
    }

    #[test]
    fn accepts_normal_nested_paths() {
        assert!(validate_relative_path("tests/test_example.py").is_ok());
    }
}
