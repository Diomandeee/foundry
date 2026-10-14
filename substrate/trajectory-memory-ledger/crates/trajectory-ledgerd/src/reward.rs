use crate::schema::normalize_record;
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};

const W_OUTCOME: f64 = 0.25;
const W_PROCESS: f64 = 0.22;
const W_EFFICIENCY: f64 = 0.13;
const W_VERIFICATION: f64 = 0.13;
const W_CONSISTENCY: f64 = 0.13;
const W_MOTION: f64 = 0.14;

#[derive(Clone, Debug, Serialize)]
pub struct RewardScores {
    pub reward_score: f64,
    pub outcome_score: f64,
    pub process_score: f64,
    pub efficiency_score: f64,
    pub verification_score: f64,
    pub consistency_score: f64,
    pub motion_score: f64,
    pub components: Map<String, Value>,
}

fn clamp01(value: f64) -> f64 {
    value.clamp(0.0, 1.0)
}

fn round4(value: f64) -> f64 {
    (value * 10000.0).round() / 10000.0
}

fn as_i64(value: Option<&Value>) -> i64 {
    match value {
        Some(Value::Number(n)) => n
            .as_i64()
            .or_else(|| n.as_u64().map(|v| v as i64))
            .unwrap_or(0),
        Some(Value::String(s)) => s.parse::<i64>().unwrap_or(0),
        Some(Value::Bool(b)) => i64::from(*b),
        _ => 0,
    }
}

fn as_f64(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) => s.parse::<f64>().ok(),
        Some(Value::Bool(b)) => Some(if *b { 1.0 } else { 0.0 }),
        _ => None,
    }
}

fn as_bool(value: Option<&Value>) -> Option<bool> {
    match value {
        Some(Value::Bool(b)) => Some(*b),
        Some(Value::Number(n)) => Some(n.as_i64().unwrap_or(0) != 0),
        Some(Value::String(s)) => match s.as_str() {
            "true" | "True" | "1" => Some(true),
            "false" | "False" | "0" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

fn as_str(value: Option<&Value>) -> &str {
    value.and_then(Value::as_str).unwrap_or("")
}

fn events(trajectory: &Value) -> Vec<&Value> {
    trajectory
        .get("events")
        .and_then(Value::as_array)
        .map(|v| v.iter().collect())
        .unwrap_or_default()
}

fn key_param<'a>(event: &'a Value, key: &str) -> &'a str {
    as_str(event.get("key_params").and_then(|v| v.get(key)))
}

pub fn compute_reward(record: &Value) -> RewardScores {
    let record = normalize_record(record.clone());
    let outcome = record.get("outcome").unwrap_or(&Value::Null);
    let trajectory = record.get("trajectory").unwrap_or(&Value::Null);
    let timing = record.get("timing").unwrap_or(&Value::Null);

    let (outcome_score, mut components) = compute_outcome(outcome);
    let (process_score, process_components) = compute_process(trajectory);
    let (efficiency_score, efficiency_components) = compute_efficiency(trajectory, timing);
    let (verification_score, verification_components) = compute_verification(trajectory);
    let (consistency_score, consistency_components) = compute_consistency(trajectory);
    let (motion_score, motion_components) = compute_wasted_motion(trajectory);

    components.extend(process_components);
    components.extend(efficiency_components);
    components.extend(verification_components);
    components.extend(consistency_components);
    components.extend(motion_components);

    let mut composite = W_OUTCOME * outcome_score
        + W_PROCESS * process_score
        + W_EFFICIENCY * efficiency_score
        + W_VERIFICATION * verification_score
        + W_CONSISTENCY * consistency_score
        + W_MOTION * motion_score;

    let total_tools = as_i64(trajectory.get("total_tools"));
    let failures = as_i64(trajectory.get("failures"));
    if total_tools > 0 && failures >= total_tools && outcome_score <= 0.25 {
        composite = composite.min(0.29);
        components.insert("r_hard_failure_cap".to_string(), json!(0.29));
    }

    RewardScores {
        reward_score: round4(composite),
        outcome_score: round4(outcome_score),
        process_score: round4(process_score),
        efficiency_score: round4(efficiency_score),
        verification_score: round4(verification_score),
        consistency_score: round4(consistency_score),
        motion_score: round4(motion_score),
        components,
    }
}

pub fn score_record(record: Value) -> Value {
    let mut record = normalize_record(record);
    let scores = compute_reward(&record);
    let outcome = record
        .get_mut("outcome")
        .and_then(Value::as_object_mut)
        .expect("normalized record has outcome object");

    outcome.insert("reward_score".to_string(), json!(scores.reward_score));
    outcome.insert("outcome_score".to_string(), json!(scores.outcome_score));
    outcome.insert("process_score".to_string(), json!(scores.process_score));
    outcome.insert(
        "efficiency_score".to_string(),
        json!(scores.efficiency_score),
    );
    outcome.insert(
        "verification_score".to_string(),
        json!(scores.verification_score),
    );
    outcome.insert(
        "consistency_score".to_string(),
        json!(scores.consistency_score),
    );
    outcome.insert("motion_score".to_string(), json!(scores.motion_score));
    outcome.insert(
        "reward_components".to_string(),
        Value::Object(scores.components),
    );
    outcome.insert(
        "annotation_status".to_string(),
        Value::String("scored".to_string()),
    );

    let obj = record.as_object_mut().expect("normalized record is object");
    obj.insert("reward_score".to_string(), json!(scores.reward_score));
    obj.insert("outcome_score".to_string(), json!(scores.outcome_score));
    obj.insert("process_score".to_string(), json!(scores.process_score));
    obj.insert(
        "efficiency_score".to_string(),
        json!(scores.efficiency_score),
    );
    record
}

fn compute_outcome(outcome: &Value) -> (f64, Map<String, Value>) {
    let mut score = 0.5;
    let mut available = 0;
    let mut components = Map::new();

    if let Some(correction) = as_bool(outcome.get("correction_detected")) {
        available += 1;
        score += if correction { -0.35 } else { 0.35 };
        components.insert(
            "r_no_correction".to_string(),
            json!(if correction { 0.0 } else { 1.0 }),
        );
    }
    if let Some(redo) = as_bool(outcome.get("redo_detected")) {
        available += 1;
        score += if redo { -0.25 } else { 0.25 };
        components.insert("r_no_redo".to_string(), json!(if redo { 0.0 } else { 1.0 }));
    }
    if let Some(build) = as_bool(outcome.get("build_success")) {
        available += 1;
        score += if build { 0.20 } else { -0.10 };
        components.insert(
            "r_build_pass".to_string(),
            json!(if build { 1.0 } else { 0.0 }),
        );
    }
    if let Some(continued) = as_bool(outcome.get("session_continued")) {
        available += 1;
        score += if continued { 0.20 } else { 0.0 };
        components.insert(
            "r_session_continued".to_string(),
            json!(if continued { 1.0 } else { 0.0 }),
        );
    }
    components.insert("outcome_signals_available".to_string(), json!(available));
    (clamp01(score), components)
}

fn max_consecutive_failures(events: &[&Value]) -> i64 {
    let mut max_run = 0;
    let mut current_run = 0;
    for event in events {
        if as_bool(event.get("success")) == Some(false) {
            current_run += 1;
            max_run = max_run.max(current_run);
        } else {
            current_run = 0;
        }
    }
    max_run
}

fn compute_process(trajectory: &Value) -> (f64, Map<String, Value>) {
    let total = as_i64(trajectory.get("total_tools"));
    let failures = as_i64(trajectory.get("failures"));
    let bash_errors = as_i64(trajectory.get("bash_errors"));
    let mut components = Map::new();
    if total == 0 {
        components.insert("r_success_rate".to_string(), json!(0.5));
        components.insert("r_bash_clean".to_string(), json!(1.0));
        components.insert("r_error_density".to_string(), json!(1.0));
        components.insert("r_temporal_weight".to_string(), json!(0.5));
        return (0.5, components);
    }
    let events = events(trajectory);
    let mut weighted_success = 0.0;
    let mut weight_sum = 0.0;
    let denom = (events.len() as f64 - 1.0).max(1.0);
    for (i, event) in events.iter().enumerate() {
        let w = 0.5 + (i as f64 / denom);
        weight_sum += w;
        if as_bool(event.get("success")) != Some(false) {
            weighted_success += w;
        }
    }
    let success_rate = if weight_sum > 0.0 {
        weighted_success / weight_sum
    } else {
        0.5
    };
    let bash_count = events
        .iter()
        .filter(|event| as_str(event.get("tool_name")) == "Bash")
        .count() as f64;
    let bash_clean = if bash_count > 0.0 {
        1.0 - (bash_errors as f64 / bash_count)
    } else {
        1.0
    };
    let mut error_density = 1.0;
    if failures > 0 {
        let max_consecutive = max_consecutive_failures(&events);
        if max_consecutive >= 3 {
            error_density = (1.0 - (max_consecutive - 2) as f64 * 0.15).max(0.0);
        }
    }
    let late_start = events
        .len()
        .saturating_sub(std::cmp::max(1, events.len() / 4));
    let late_events = &events[late_start..];
    let late_failures = late_events
        .iter()
        .filter(|event| as_bool(event.get("success")) == Some(false))
        .count() as f64;
    let late_penalty = if late_events.is_empty() {
        1.0
    } else {
        (1.0 - late_failures * 0.15).max(0.0)
    };
    let process =
        success_rate * 0.40 + bash_clean * 0.25 + error_density * 0.20 + late_penalty * 0.15;
    components.insert("r_success_rate".to_string(), json!(round4(success_rate)));
    components.insert("r_bash_clean".to_string(), json!(round4(bash_clean)));
    components.insert("r_error_density".to_string(), json!(round4(error_density)));
    components.insert("r_temporal_weight".to_string(), json!(round4(late_penalty)));
    (clamp01(process), components)
}

fn compute_efficiency(trajectory: &Value, timing: &Value) -> (f64, Map<String, Value>) {
    let total = as_i64(trajectory.get("total_tools"));
    let mut components = Map::new();
    if total == 0 {
        components.insert("r_diversity".to_string(), json!(0.5));
        components.insert("r_duration_eff".to_string(), json!(0.5));
        components.insert("r_file_touch".to_string(), json!(0.5));
        components.insert("r_sustained".to_string(), json!(0.5));
        return (0.5, components);
    }
    let tool_counts = trajectory
        .get("tool_counts")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let unique_tools = tool_counts.len();
    let diversity = if unique_tools <= 1 {
        0.3
    } else {
        let mut entropy = 0.0;
        for count in tool_counts.values() {
            let p = as_i64(Some(count)) as f64 / total as f64;
            if p > 0.0 {
                entropy -= p * p.log2();
            }
        }
        let max_entropy = (unique_tools as f64).log2();
        if max_entropy > 0.0 {
            entropy / max_entropy
        } else {
            0.5
        }
    };
    let duration_eff = match as_f64(timing.get("duration_s")) {
        Some(duration) if duration > 0.0 => {
            let tools_per_min = (total as f64 / duration) * 60.0;
            if (2.0..=8.0).contains(&tools_per_min) {
                1.0
            } else if tools_per_min > 8.0 {
                0.8
            } else if tools_per_min >= 1.0 {
                0.6
            } else {
                (0.5 - (1.0 - tools_per_min) * 0.3).max(0.2)
            }
        }
        _ => 0.5,
    };
    let mutation_count: i64 = ["Write", "Edit", "NotebookEdit"]
        .iter()
        .map(|tool| as_i64(tool_counts.get(*tool)))
        .sum();
    let file_touch = (mutation_count as f64 / (total as f64 * 0.3).max(1.0)).min(1.0);
    let successes = as_i64(trajectory.get("successes"));
    let failures = as_i64(trajectory.get("failures"));
    let obs = successes + failures;
    let success_rate = if obs > 0 {
        successes as f64 / obs as f64
    } else {
        1.0
    };
    let sustained = if total >= 20 {
        if success_rate >= 0.85 {
            let length_factor = ((total - 20) as f64 / 40.0).min(1.0);
            0.5 + 0.5 * length_factor
        } else {
            0.4
        }
    } else if total >= 8 {
        0.6
    } else {
        0.5
    };
    let efficiency = diversity * 0.25 + duration_eff * 0.25 + file_touch * 0.20 + sustained * 0.30;
    components.insert("r_diversity".to_string(), json!(round4(diversity)));
    components.insert("r_duration_eff".to_string(), json!(round4(duration_eff)));
    components.insert("r_file_touch".to_string(), json!(round4(file_touch)));
    components.insert("r_sustained".to_string(), json!(round4(sustained)));
    (clamp01(efficiency), components)
}

fn compute_verification(trajectory: &Value) -> (f64, Map<String, Value>) {
    let total = as_i64(trajectory.get("total_tools"));
    let mut components = Map::new();
    if total == 0 {
        components.insert("r_has_test".to_string(), json!(0.0));
        components.insert("r_has_build".to_string(), json!(0.0));
        components.insert("r_read_after_write".to_string(), json!(0.0));
        return (0.5, components);
    }
    let tool_counts = trajectory
        .get("tool_counts")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let has_mutation = ["Write", "Edit", "NotebookEdit"]
        .iter()
        .any(|tool| tool_counts.contains_key(*tool));
    let mut has_test = false;
    let mut has_build = false;
    let mut wrote_files = BTreeSet::new();
    let mut read_after_write = false;
    for event in events(trajectory) {
        let tool = as_str(event.get("tool_name"));
        let cmd = key_param(event, "command").to_lowercase();
        if tool == "Bash" {
            if [
                "pytest",
                "npm test",
                "bun test",
                "cargo test",
                "go test",
                "make test",
            ]
            .iter()
            .any(|kw| cmd.contains(kw))
            {
                has_test = true;
            }
            if [
                "xcodebuild",
                "cargo build",
                "make ",
                "npm run build",
                "bun build",
            ]
            .iter()
            .any(|kw| cmd.contains(kw))
            {
                has_build = true;
            }
        }
        if matches!(tool, "Write" | "Edit") {
            let fp = key_param(event, "file_path");
            if !fp.is_empty() {
                wrote_files.insert(fp.to_string());
            }
        }
        if tool == "Read" && !wrote_files.is_empty() {
            let fp = key_param(event, "file_path");
            if wrote_files.contains(fp) {
                read_after_write = true;
            }
        }
    }
    if !has_mutation {
        components.insert("r_has_test".to_string(), json!(0.0));
        components.insert("r_has_build".to_string(), json!(0.0));
        components.insert("r_read_after_write".to_string(), json!(0.0));
        components.insert("r_no_mutation".to_string(), json!(1.0));
        return (0.6, components);
    }
    let test_score = if has_test { 1.0 } else { 0.0 };
    let build_score = if has_build { 1.0 } else { 0.0 };
    let raw_score = if read_after_write { 0.3 } else { 0.0 };
    let verification = test_score * 0.4 + build_score * 0.3 + raw_score * 0.3;
    components.insert("r_has_test".to_string(), json!(test_score));
    components.insert("r_has_build".to_string(), json!(build_score));
    components.insert(
        "r_read_after_write".to_string(),
        json!(if read_after_write { 1.0 } else { 0.0 }),
    );
    (clamp01(verification), components)
}

fn compute_consistency(trajectory: &Value) -> (f64, Map<String, Value>) {
    let total = as_i64(trajectory.get("total_tools"));
    let mut components = Map::new();
    if total < 3 {
        components.insert("r_read_before_write".to_string(), json!(0.5));
        components.insert("r_no_thrashing".to_string(), json!(1.0));
        return (0.6, components);
    }
    let mut read_files = BTreeSet::new();
    let mut writes_with_read = 0;
    let mut writes_total = 0;
    let mut edit_counts: BTreeMap<String, i64> = BTreeMap::new();
    for event in events(trajectory) {
        let tool = as_str(event.get("tool_name"));
        let fp = key_param(event, "file_path");
        if tool == "Read" && !fp.is_empty() {
            read_files.insert(fp.to_string());
        } else if matches!(tool, "Edit" | "Write") && !fp.is_empty() {
            writes_total += 1;
            if read_files.contains(fp) {
                writes_with_read += 1;
            }
            *edit_counts.entry(fp.to_string()).or_insert(0) += 1;
        }
    }
    let rbw_score = if writes_total > 0 {
        writes_with_read as f64 / writes_total as f64
    } else {
        0.5
    };
    let thrash_files = edit_counts.values().filter(|count| **count >= 3).count() as f64;
    let no_thrash = if thrash_files == 0.0 {
        1.0
    } else {
        (1.0 - thrash_files * 0.2).max(0.0)
    };
    let consistency = rbw_score * 0.6 + no_thrash * 0.4;
    components.insert("r_read_before_write".to_string(), json!(round4(rbw_score)));
    components.insert("r_no_thrashing".to_string(), json!(round4(no_thrash)));
    (clamp01(consistency), components)
}

fn compute_wasted_motion(trajectory: &Value) -> (f64, Map<String, Value>) {
    let total = as_i64(trajectory.get("total_tools"));
    let mut components = Map::new();
    if total < 3 {
        components.insert("r_retry_loops".to_string(), json!(0));
        components.insert("r_read_waste".to_string(), json!(0.0));
        components.insert("r_error_loops".to_string(), json!(0));
        components.insert("r_undo".to_string(), json!(0));
        return (0.8, components);
    }
    let events = events(trajectory);
    let mut retry_loops = 0;
    let mut i = 0;
    while i < events.len() {
        let tool_i = as_str(events[i].get("tool_name"));
        let mut j = i;
        while j < events.len() && as_str(events[j].get("tool_name")) == tool_i && !tool_i.is_empty()
        {
            j += 1;
        }
        if j - i >= 3 {
            let run_failures = events[i..j]
                .iter()
                .filter(|event| as_bool(event.get("success")) == Some(false))
                .count();
            if run_failures > 0 {
                retry_loops += 1;
            }
        }
        i = if j > i { j } else { i + 1 };
    }
    let mut read_files = Vec::new();
    let mut written_files = BTreeSet::new();
    for event in &events {
        let tool = as_str(event.get("tool_name"));
        let fp = key_param(event, "file_path");
        if tool == "Read" && !fp.is_empty() {
            read_files.push(fp.to_string());
        } else if matches!(tool, "Write" | "Edit") && !fp.is_empty() {
            written_files.insert(fp.to_string());
        }
    }
    let reads_without_write = read_files
        .iter()
        .filter(|fp| !written_files.contains(*fp))
        .count();
    let read_waste = if read_files.is_empty() {
        0.0
    } else {
        reads_without_write as f64 / read_files.len() as f64
    };
    let mut error_loops = 0;
    let mut bash_fail_streak = 0;
    for event in &events {
        if as_str(event.get("tool_name")) == "Bash" && as_bool(event.get("success")) == Some(false)
        {
            bash_fail_streak += 1;
            if bash_fail_streak >= 2 {
                error_loops += 1;
            }
        } else {
            bash_fail_streak = 0;
        }
    }
    let mut undo_count = 0;
    for idx in 1..events.len() {
        let curr = events[idx];
        let prev = events[idx - 1];
        if matches!(as_str(curr.get("tool_name")), "Edit" | "Write")
            && matches!(as_str(prev.get("tool_name")), "Edit" | "Write")
        {
            let curr_fp = key_param(curr, "file_path");
            let prev_fp = key_param(prev, "file_path");
            if !curr_fp.is_empty() && curr_fp == prev_fp {
                undo_count += 1;
            }
        }
    }
    let waste =
        retry_loops as f64 * 2.0 + error_loops as f64 * 1.5 + undo_count as f64 + read_waste * 3.0;
    let score = (-0.15 * waste).exp();
    components.insert("r_retry_loops".to_string(), json!(retry_loops));
    components.insert("r_read_waste".to_string(), json!(round4(read_waste)));
    components.insert("r_error_loops".to_string(), json!(error_loops));
    components.insert("r_undo".to_string(), json!(undo_count));
    (clamp01(score), components)
}
