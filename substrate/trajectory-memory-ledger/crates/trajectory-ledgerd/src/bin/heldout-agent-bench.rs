use anyhow::{bail, Context, Result};
use clap::Parser;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;

#[derive(Debug, Parser)]
#[command(name = "heldout-agent-bench")]
#[command(about = "Aggregate real held-out coding-agent benchmark score rows")]
struct Args {
    /// JSONL file with one aggregate benchmark row per condition/model.
    #[arg(long)]
    input: PathBuf,

    /// Optional output path for the aggregate JSON report.
    #[arg(long)]
    output: Option<PathBuf>,
}

#[derive(Debug, Deserialize)]
struct BenchRow {
    benchmark_kind: String,
    task_set: String,
    condition: String,
    #[serde(default)]
    model_id: Option<String>,
    n_tasks: usize,
    passes: usize,
    mean_score: f64,
    #[serde(default)]
    mean_latency_s: Option<f64>,
    #[serde(default)]
    min_score: Option<f64>,
    #[serde(default)]
    max_score: Option<f64>,
    #[serde(default)]
    pass_threshold: Option<f64>,
    #[serde(default)]
    score_metric: Option<String>,
    #[serde(default)]
    source_artifact: Option<String>,
    #[serde(default)]
    source_generator: Option<String>,
    #[serde(default)]
    raw_generations_included: Option<bool>,
}

#[derive(Debug, Default)]
struct Accumulator {
    n_tasks: usize,
    passes: usize,
    weighted_score_sum: f64,
    weighted_latency_sum: f64,
    latency_n: usize,
    min_score: Option<f64>,
    max_score: Option<f64>,
    model_ids: BTreeSet<String>,
}

#[derive(Debug, Serialize)]
struct ConditionReport {
    n_tasks: usize,
    passes: usize,
    quality_pass_rate: f64,
    mean_score: f64,
    mean_latency_s: Option<f64>,
    min_score: Option<f64>,
    max_score: Option<f64>,
    model_ids: Vec<String>,
}

#[derive(Debug, Serialize)]
struct HeldoutBenchReport {
    input_rows: usize,
    total_tasks: usize,
    benchmark_kinds: Vec<String>,
    task_sets: Vec<String>,
    score_metrics: Vec<String>,
    pass_thresholds: Vec<f64>,
    source_artifacts: Vec<String>,
    source_generators: Vec<String>,
    raw_generations_included: bool,
    measures_executed_task_completion: bool,
    boundary: String,
    best_condition_by_mean_score: Option<String>,
    conditions: BTreeMap<String, ConditionReport>,
}

fn main() -> Result<()> {
    let args = Args::parse();
    let report = evaluate(&args.input)?;
    let rendered = serde_json::to_string_pretty(&report)?;
    println!("{rendered}");
    if let Some(output) = args.output {
        if let Some(parent) = output.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(output, rendered + "\n")?;
    }
    Ok(())
}

fn evaluate(path: &PathBuf) -> Result<HeldoutBenchReport> {
    let file =
        File::open(path).with_context(|| format!("open benchmark input {}", path.display()))?;
    let mut input_rows = 0usize;
    let mut total_tasks = 0usize;
    let mut by_condition: BTreeMap<String, Accumulator> = BTreeMap::new();
    let mut benchmark_kinds = BTreeSet::new();
    let mut task_sets = BTreeSet::new();
    let mut score_metrics = BTreeSet::new();
    let mut pass_thresholds = Vec::new();
    let mut source_artifacts = BTreeSet::new();
    let mut source_generators = BTreeSet::new();
    let mut raw_generations_included = false;

    for (idx, line) in BufReader::new(file).lines().enumerate() {
        let line = line.with_context(|| format!("read benchmark input line {}", idx + 1))?;
        if line.trim().is_empty() {
            continue;
        }
        let row: BenchRow = serde_json::from_str(&line)
            .with_context(|| format!("parse benchmark input line {}", idx + 1))?;
        validate_row(&row, idx + 1)?;

        input_rows += 1;
        total_tasks += row.n_tasks;
        benchmark_kinds.insert(row.benchmark_kind.clone());
        task_sets.insert(row.task_set.clone());
        if let Some(score_metric) = &row.score_metric {
            score_metrics.insert(score_metric.clone());
        }
        if let Some(threshold) = row.pass_threshold {
            if !pass_thresholds
                .iter()
                .any(|seen| float_eq(*seen, threshold))
            {
                pass_thresholds.push(threshold);
            }
        }
        if let Some(source) = &row.source_artifact {
            source_artifacts.insert(source.clone());
        }
        if let Some(generator) = &row.source_generator {
            source_generators.insert(generator.clone());
        }
        raw_generations_included |= row.raw_generations_included.unwrap_or(false);

        let acc = by_condition.entry(row.condition.clone()).or_default();
        acc.n_tasks += row.n_tasks;
        acc.passes += row.passes;
        acc.weighted_score_sum += row.mean_score * row.n_tasks as f64;
        if let Some(latency) = row.mean_latency_s {
            acc.weighted_latency_sum += latency * row.n_tasks as f64;
            acc.latency_n += row.n_tasks;
        }
        acc.min_score = merge_min(acc.min_score, row.min_score.or(Some(row.mean_score)));
        acc.max_score = merge_max(acc.max_score, row.max_score.or(Some(row.mean_score)));
        if let Some(model_id) = row.model_id {
            acc.model_ids.insert(model_id);
        }
    }

    if input_rows == 0 {
        bail!("benchmark input contained no rows");
    }

    let conditions: BTreeMap<String, ConditionReport> = by_condition
        .into_iter()
        .map(|(condition, acc)| {
            let n = acc.n_tasks.max(1) as f64;
            let latency = if acc.latency_n > 0 {
                Some(round4(acc.weighted_latency_sum / acc.latency_n as f64))
            } else {
                None
            };
            (
                condition,
                ConditionReport {
                    n_tasks: acc.n_tasks,
                    passes: acc.passes,
                    quality_pass_rate: round4(acc.passes as f64 / n),
                    mean_score: round4(acc.weighted_score_sum / n),
                    mean_latency_s: latency,
                    min_score: acc.min_score.map(round4),
                    max_score: acc.max_score.map(round4),
                    model_ids: acc.model_ids.into_iter().collect(),
                },
            )
        })
        .collect();

    let best_condition_by_mean_score = conditions
        .iter()
        .max_by(|(_, a), (_, b)| {
            a.mean_score
                .partial_cmp(&b.mean_score)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| {
                    b.mean_latency_s
                        .unwrap_or(f64::INFINITY)
                        .partial_cmp(&a.mean_latency_s.unwrap_or(f64::INFINITY))
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
        })
        .map(|(condition, _)| condition.clone());

    Ok(HeldoutBenchReport {
        input_rows,
        total_tasks,
        benchmark_kinds: benchmark_kinds.into_iter().collect(),
        task_sets: task_sets.into_iter().collect(),
        score_metrics: score_metrics.into_iter().collect(),
        pass_thresholds: sorted_thresholds(pass_thresholds),
        source_artifacts: source_artifacts.into_iter().collect(),
        source_generators: source_generators.into_iter().collect(),
        raw_generations_included,
        measures_executed_task_completion: false,
        boundary: "Measures held-out model response quality on coding-agent session contexts; it does not execute repository tasks or measure SWE-style task completion."
            .to_string(),
        best_condition_by_mean_score,
        conditions,
    })
}

fn validate_row(row: &BenchRow, line: usize) -> Result<()> {
    if row.benchmark_kind.trim().is_empty() {
        bail!("line {line}: benchmark_kind is empty");
    }
    if row.task_set.trim().is_empty() {
        bail!("line {line}: task_set is empty");
    }
    if row.condition.trim().is_empty() {
        bail!("line {line}: condition is empty");
    }
    if row.n_tasks == 0 {
        bail!("line {line}: n_tasks must be positive");
    }
    if row.passes > row.n_tasks {
        bail!("line {line}: passes cannot exceed n_tasks");
    }
    if !row.mean_score.is_finite() || !(0.0..=1.0).contains(&row.mean_score) {
        bail!("line {line}: mean_score must be finite and in [0, 1]");
    }
    if let Some(latency) = row.mean_latency_s {
        if !latency.is_finite() || latency < 0.0 {
            bail!("line {line}: mean_latency_s must be finite and non-negative");
        }
    }
    if let Some(threshold) = row.pass_threshold {
        if !threshold.is_finite() || !(0.0..=1.0).contains(&threshold) {
            bail!("line {line}: pass_threshold must be finite and in [0, 1]");
        }
    }
    Ok(())
}

fn merge_min(left: Option<f64>, right: Option<f64>) -> Option<f64> {
    match (left, right) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (Some(a), None) => Some(a),
        (None, Some(b)) => Some(b),
        (None, None) => None,
    }
}

fn merge_max(left: Option<f64>, right: Option<f64>) -> Option<f64> {
    match (left, right) {
        (Some(a), Some(b)) => Some(a.max(b)),
        (Some(a), None) => Some(a),
        (None, Some(b)) => Some(b),
        (None, None) => None,
    }
}

fn round4(value: f64) -> f64 {
    let value = if value.is_finite() { value } else { 0.0 };
    (value * 10000.0).round() / 10000.0
}

fn sorted_thresholds(mut thresholds: Vec<f64>) -> Vec<f64> {
    thresholds.sort_by(|left, right| left.total_cmp(right));
    thresholds.into_iter().map(round4).collect()
}

fn float_eq(left: f64, right: f64) -> bool {
    (left - right).abs() <= f64::EPSILON
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_pass_count_above_task_count() {
        let row = BenchRow {
            benchmark_kind: "kind".to_string(),
            task_set: "tasks".to_string(),
            condition: "condition".to_string(),
            model_id: None,
            n_tasks: 2,
            passes: 3,
            mean_score: 0.5,
            mean_latency_s: None,
            min_score: None,
            max_score: None,
            pass_threshold: Some(0.4),
            score_metric: None,
            source_artifact: None,
            source_generator: None,
            raw_generations_included: None,
        };
        assert!(validate_row(&row, 1).is_err());
    }

    #[test]
    fn rounds_finite_values() {
        assert_eq!(round4(0.12345), 0.1235);
    }

    #[test]
    fn sorts_thresholds() {
        assert_eq!(sorted_thresholds(vec![0.7, 0.4]), vec![0.4, 0.7]);
    }
}
