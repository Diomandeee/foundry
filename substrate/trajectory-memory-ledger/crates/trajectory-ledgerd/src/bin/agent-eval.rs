use anyhow::{Context, Result};
use clap::Parser;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;

#[derive(Debug, Parser)]
#[command(name = "agent-eval")]
#[command(about = "Evaluate held-out tool-plan generations by condition")]
struct Args {
    /// JSONL file with one evaluated generation per line.
    #[arg(long)]
    input: PathBuf,

    /// Optional output path for the aggregate JSON report.
    #[arg(long)]
    output: Option<PathBuf>,
}

#[derive(Debug, Deserialize)]
struct EvalRow {
    condition: String,
    task_id: String,
    generated_tools: Vec<String>,
    task_passed: bool,
    #[serde(default)]
    tests_included: bool,
    #[serde(default)]
    build_included: bool,
    #[serde(default)]
    reward_score: Option<f64>,
}

#[derive(Debug, Default)]
struct Accumulator {
    n: usize,
    passed: usize,
    valid_tool_plans: usize,
    tests_included: usize,
    build_included: usize,
    retry_loops: usize,
    reward_sum: f64,
    reward_n: usize,
}

#[derive(Debug, Serialize)]
struct ConditionReport {
    n: usize,
    task_pass_rate: f64,
    valid_tool_plan_rate: f64,
    test_inclusion_rate: f64,
    build_inclusion_rate: f64,
    retry_loop_rate: f64,
    mean_reward_score: Option<f64>,
}

#[derive(Debug, Serialize)]
struct EvalReport {
    input_rows: usize,
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

fn evaluate(path: &PathBuf) -> Result<EvalReport> {
    let file = File::open(path).with_context(|| format!("open eval input {}", path.display()))?;
    let mut input_rows = 0usize;
    let mut by_condition: BTreeMap<String, Accumulator> = BTreeMap::new();
    for (idx, line) in BufReader::new(file).lines().enumerate() {
        let line = line.with_context(|| format!("read eval input line {}", idx + 1))?;
        if line.trim().is_empty() {
            continue;
        }
        let row: EvalRow = serde_json::from_str(&line)
            .with_context(|| format!("parse eval input line {}", idx + 1))?;
        input_rows += 1;
        let acc = by_condition.entry(row.condition.clone()).or_default();
        acc.n += 1;
        if row.task_passed {
            acc.passed += 1;
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
        if has_retry_loop(&row.generated_tools) {
            acc.retry_loops += 1;
        }
        if let Some(score) = row.reward_score {
            acc.reward_sum += score;
            acc.reward_n += 1;
        }
        let _ = &row.task_id;
    }

    let conditions = by_condition
        .into_iter()
        .map(|(condition, acc)| {
            let n = acc.n.max(1) as f64;
            (
                condition,
                ConditionReport {
                    n: acc.n,
                    task_pass_rate: round4(acc.passed as f64 / n),
                    valid_tool_plan_rate: round4(acc.valid_tool_plans as f64 / n),
                    test_inclusion_rate: round4(acc.tests_included as f64 / n),
                    build_inclusion_rate: round4(acc.build_included as f64 / n),
                    retry_loop_rate: round4(acc.retry_loops as f64 / n),
                    mean_reward_score: if acc.reward_n > 0 {
                        Some(round4(acc.reward_sum / acc.reward_n as f64))
                    } else {
                        None
                    },
                },
            )
        })
        .collect();
    Ok(EvalReport {
        input_rows,
        conditions,
    })
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

fn has_retry_loop(tools: &[String]) -> bool {
    if tools.len() < 3 {
        return false;
    }
    tools
        .windows(3)
        .any(|window| window[0] == window[1] && window[1] == window[2])
}

fn round4(value: f64) -> f64 {
    let value = if value.is_finite() { value } else { 0.0 };
    (value * 10000.0).round() / 10000.0
}

#[allow(dead_code)]
fn parse_json_value(line: &str) -> Result<Value> {
    Ok(serde_json::from_str(line)?)
}
