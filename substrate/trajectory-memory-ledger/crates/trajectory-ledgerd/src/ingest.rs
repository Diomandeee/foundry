use crate::cursor::{cursor_consumed, read_cursor, write_cursor, CursorState};
use crate::metrics::Metrics;
use crate::reward::score_record;
use crate::schema::normalize_record;
use crate::store::{append_jsonl_locked, load_existing_ids};
use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use sha1::{Digest, Sha1};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::Duration;

#[derive(Clone, Debug)]
pub struct LedgerConfig {
    pub events_dir: PathBuf,
    pub cursor_path: PathBuf,
    pub store_path: PathBuf,
    pub metrics_path: Option<PathBuf>,
    pub date: Option<String>,
    pub poll_ms: u64,
    pub once: bool,
}

impl LedgerConfig {
    pub fn current_date(&self) -> String {
        self.date
            .clone()
            .unwrap_or_else(|| Utc::now().format("%Y-%m-%d").to_string())
    }

    pub fn events_path_for(&self, date: &str) -> PathBuf {
        self.events_dir.join(format!("events-{date}.jsonl"))
    }
}

#[derive(Default)]
pub struct FlowState {
    in_flight: BTreeMap<String, Vec<Value>>,
}

pub fn run_once(config: &LedgerConfig) -> Result<Metrics> {
    let date = config.current_date();
    let cursor = read_cursor(&config.cursor_path)?;
    let events_path = config.events_path_for(&date);
    let mut existing_ids = load_existing_ids(&config.store_path)?;
    let mut state = FlowState::default();
    let metrics = process_event_file(
        &date,
        &events_path,
        &cursor,
        &mut existing_ids,
        &mut state,
        &config.store_path,
    )?;
    if metrics.cursor_seq > 0 {
        write_cursor(&config.cursor_path, &date, metrics.cursor_seq)?;
    }
    if let Some(path) = &config.metrics_path {
        metrics.write_prometheus(path)?;
    }
    Ok(metrics)
}

pub fn run_loop(config: LedgerConfig) -> Result<()> {
    loop {
        let metrics = run_once(&config)?;
        if let Some(path) = &config.metrics_path {
            metrics.write_prometheus(path)?;
        }
        if config.once {
            break;
        }
        thread::sleep(Duration::from_millis(config.poll_ms.max(100)));
    }
    Ok(())
}

pub fn process_event_file(
    date: &str,
    path: &Path,
    cursor: &CursorState,
    existing_ids: &mut BTreeSet<String>,
    state: &mut FlowState,
    store_path: &Path,
) -> Result<Metrics> {
    let mut metrics = Metrics {
        last_date: Some(date.to_string()),
        cursor_seq: cursor.seq,
        ..Metrics::default()
    };
    if !path.exists() {
        return Ok(metrics);
    }
    let file = File::open(path).with_context(|| format!("open event file {}", path.display()))?;
    for line in BufReader::new(file).lines() {
        let line = line.with_context(|| format!("read event line {}", path.display()))?;
        if line.trim().is_empty() {
            continue;
        }
        metrics.lines_read += 1;
        let envelope: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(_) => {
                metrics.malformed_json += 1;
                continue;
            }
        };
        let Some(seq) = envelope.get("seq").and_then(Value::as_u64) else {
            metrics.envelopes_without_seq += 1;
            continue;
        };
        if cursor_consumed(cursor, date, seq) {
            metrics.envelopes_skipped_cursor += 1;
            continue;
        }
        metrics.cursor_seq = metrics.cursor_seq.max(seq);
        metrics.envelopes_consumed += 1;
        consume_envelope(envelope, existing_ids, state, store_path, &mut metrics)?;
    }
    Ok(metrics)
}

fn consume_envelope(
    envelope: Value,
    existing_ids: &mut BTreeSet<String>,
    state: &mut FlowState,
    store_path: &Path,
    metrics: &mut Metrics,
) -> Result<()> {
    let Some(flow_id) = envelope
        .get("flow_id")
        .and_then(Value::as_str)
        .map(str::to_string)
    else {
        return Ok(());
    };
    let etype = envelope
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if etype == "flow:start" {
        state.in_flight.insert(flow_id.clone(), vec![envelope]);
        return Ok(());
    }
    let Some(batch) = state.in_flight.get_mut(&flow_id) else {
        return Ok(());
    };
    batch.push(envelope);
    if etype == "flow:complete" {
        let batch = state.in_flight.remove(&flow_id).unwrap_or_default();
        if let Some(card) = build_card(&flow_id, &batch) {
            metrics.flow_cards_built += 1;
            let id = card
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if !id.is_empty() && existing_ids.contains(&id) {
                metrics.flow_cards_skipped_existing += 1;
            } else {
                append_jsonl_locked(store_path, &card)?;
                if !id.is_empty() {
                    existing_ids.insert(id);
                }
                metrics.flow_cards_written += 1;
            }
        }
    }
    Ok(())
}

fn step_kind_to_tool(step_kind: &str) -> String {
    match step_kind {
        "captain_ask" => "CaptainAsk".to_string(),
        "captain_dispatch" => "CaptainDispatch".to_string(),
        "autopilot_enable" => "AutopilotEnable".to_string(),
        "autopilot_disable" => "AutopilotDisable".to_string(),
        "autopilot_list" => "AutopilotList".to_string(),
        "inject" => "Inject".to_string(),
        "ntfy_push" => "NtfyPush".to_string(),
        "mesh_wake" => "MeshWake".to_string(),
        "spawn_session" => "SpawnSession".to_string(),
        "delay" => "Delay".to_string(),
        "" => "Unknown".to_string(),
        other => other
            .split('_')
            .filter(|part| !part.is_empty())
            .map(|part| {
                let mut chars = part.chars();
                match chars.next() {
                    Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                    None => String::new(),
                }
            })
            .collect::<String>(),
    }
}

fn envelope_payload(envelope: &Value) -> Value {
    envelope
        .get("payload")
        .cloned()
        .unwrap_or_else(|| json!({}))
}

fn timestamp_epoch(ts: &str) -> f64 {
    DateTime::parse_from_rfc3339(ts)
        .map(|dt| dt.timestamp_millis() as f64 / 1000.0)
        .unwrap_or_else(|_| Utc::now().timestamp_millis() as f64 / 1000.0)
}

pub fn build_card(flow_id: &str, envelopes: &[Value]) -> Option<Value> {
    let mut flow_start: Option<&Value> = None;
    let mut flow_complete: Option<&Value> = None;
    let mut step_starts: BTreeMap<i64, &Value> = BTreeMap::new();
    let mut step_completes: BTreeMap<i64, &Value> = BTreeMap::new();

    for envelope in envelopes {
        match envelope.get("type").and_then(Value::as_str).unwrap_or("") {
            "flow:start" => flow_start = Some(envelope),
            "flow:complete" => flow_complete = Some(envelope),
            "step:start" => {
                if let Some(idx) = envelope.get("step_idx").and_then(Value::as_i64) {
                    step_starts.insert(idx, envelope);
                }
            }
            "step:complete" => {
                if let Some(idx) = envelope.get("step_idx").and_then(Value::as_i64) {
                    step_completes.insert(idx, envelope);
                }
            }
            _ => {}
        }
    }
    let flow_start = flow_start?;
    let flow_complete = flow_complete?;
    let started_at = flow_start.get("ts").and_then(Value::as_str).unwrap_or("");
    let completed_at = flow_complete
        .get("ts")
        .and_then(Value::as_str)
        .unwrap_or(started_at);
    let started_at = if started_at.is_empty() {
        Utc::now().to_rfc3339()
    } else {
        started_at.to_string()
    };
    let completed_at = if completed_at.is_empty() {
        started_at.clone()
    } else {
        completed_at.to_string()
    };

    let mut indices: BTreeSet<i64> = step_starts.keys().cloned().collect();
    indices.extend(step_completes.keys().cloned());

    let mut tool_calls = Vec::new();
    let mut step_lines = Vec::new();
    let mut step_kinds = Vec::new();
    let mut errors = Vec::new();
    let mut ok_count = 0;
    let mut total_steps = 0;

    for idx in indices {
        let start_payload = step_starts
            .get(&idx)
            .map(|env| envelope_payload(env))
            .unwrap_or_else(|| json!({}));
        let complete_payload = step_completes
            .get(&idx)
            .map(|env| envelope_payload(env))
            .unwrap_or_else(|| json!({}));
        let step_kind = complete_payload
            .get("step_kind")
            .or_else(|| start_payload.get("step_kind"))
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string();
        step_kinds.push(step_kind.clone());
        let ok = complete_payload
            .get("ok")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if ok {
            ok_count += 1;
        }
        total_steps += 1;
        let error = complete_payload.get("error").and_then(Value::as_str);
        if let Some(error) = error {
            errors.push(error.to_string());
            step_lines.push(format!(
                "[fail] {step_kind}: {}",
                error.chars().take(160).collect::<String>()
            ));
        } else {
            step_lines.push(format!("[ok] {step_kind}: {step_kind}"));
        }
        tool_calls.push(json!({
            "tool": step_kind_to_tool(&step_kind),
            "input_preview": serde_json::to_string(&start_payload).unwrap_or_default().chars().take(200).collect::<String>(),
            "success": ok,
            "duration_ms": complete_payload.get("duration_ms").cloned().unwrap_or(Value::Null),
        }));
    }

    let flow_start_payload = envelope_payload(flow_start);
    let trigger_kind = flow_start_payload
        .get("trigger_kind")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let flow_complete_payload = envelope_payload(flow_complete);
    let first_error = flow_complete_payload
        .get("first_error")
        .cloned()
        .unwrap_or(Value::Null);
    let duration_ms = flow_complete_payload
        .get("duration_ms")
        .cloned()
        .unwrap_or(Value::Null);
    let mut hasher = Sha1::new();
    hasher.update(format!("{flow_id}|{started_at}").as_bytes());
    let card_id = format!("{:x}", hasher.finalize())
        .chars()
        .take(16)
        .collect::<String>();
    let tool_diversity = step_kinds.iter().collect::<BTreeSet<_>>().len();
    let tool_success_rate = if total_steps > 0 {
        ok_count as f64 / total_steps as f64
    } else {
        1.0
    };

    let card = json!({
        "id": card_id,
        "session_id": started_at,
        "skill": format!("flow:{flow_id}"),
        "domain": "mesh-orchestration",
        "trajectory": {
            "prompt": format!("{trigger_kind}:{flow_id}"),
            "response": step_lines.join("\n"),
            "tool_calls": tool_calls,
            "tool_count": total_steps,
            "tool_types": step_kinds.iter().cloned().collect::<BTreeSet<_>>().into_iter().collect::<Vec<_>>(),
        },
        "context": {
            "source": "aura-gateway-flow",
            "domain": "mesh-orchestration",
            "extracted_at": timestamp_epoch(&completed_at),
            "complexity": null,
            "total_tokens": {},
        },
        "timing": {
            "tool_count": total_steps,
            "duration_ms": duration_ms,
        },
        "outcome": {
            "has_error": !first_error.is_null(),
            "completed": true,
            "tool_diversity": tool_diversity,
            "files_modified": 0,
            "files_created": 0,
            "has_diffs": false,
            "errors": errors,
            "tool_success_rate": tool_success_rate,
        }
    });
    Some(score_record(normalize_record(card)))
}
