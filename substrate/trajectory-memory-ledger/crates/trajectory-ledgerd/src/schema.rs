use serde_json::{json, Map, Value};
use std::collections::BTreeMap;

pub const CANONICAL_SCHEMA_VERSION: i64 = 2;

fn normalize_tool_name(name: &str) -> String {
    match name {
        "exec_command" | "shell_command" | "run_shell_command" => "Bash".to_string(),
        "apply_patch" | "apply_diff" | "replace" => "Edit".to_string(),
        "read_file" => "Read".to_string(),
        "list_files" | "list_directory" => "Glob".to_string(),
        "search_files" | "grep_search" => "Grep".to_string(),
        "write_file" | "create_file" => "Write".to_string(),
        "" => "unknown".to_string(),
        other => other.to_string(),
    }
}

fn as_object_mut_or_new(value: &mut Value) -> &mut Map<String, Value> {
    if !value.is_object() {
        *value = Value::Object(Map::new());
    }
    value.as_object_mut().expect("value was forced to object")
}

fn string_value(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
        Some(Value::Number(n)) => Some(n.to_string()),
        Some(Value::Bool(b)) => Some(b.to_string()),
        _ => None,
    }
}

fn safe_i64(value: Option<&Value>) -> i64 {
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

fn safe_f64(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) => s.parse::<f64>().ok(),
        Some(Value::Bool(b)) => Some(if *b { 1.0 } else { 0.0 }),
        _ => None,
    }
}

fn value_bool(value: Option<&Value>) -> Option<bool> {
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

fn parse_preview(value: Option<&Value>) -> Option<Map<String, Value>> {
    let text = value.and_then(Value::as_str)?.trim();
    if !(text.starts_with('{') && text.ends_with('}')) {
        return None;
    }
    serde_json::from_str::<Value>(text)
        .ok()?
        .as_object()
        .cloned()
}

fn compact_params(params: Option<&Value>) -> Map<String, Value> {
    let mut compact = Map::new();
    let Some(params) = params.and_then(Value::as_object) else {
        return compact;
    };
    for (idx, (key, value)) in params.iter().enumerate() {
        if idx >= 12 {
            break;
        }
        let out = match value {
            Value::Null => Value::Null,
            Value::String(s) => Value::String(s.chars().take(200).collect()),
            Value::Number(_) | Value::Bool(_) => value.clone(),
            other => Value::String(
                serde_json::to_string(other)
                    .unwrap_or_else(|_| other.to_string())
                    .chars()
                    .take(200)
                    .collect(),
            ),
        };
        compact.insert(key.clone(), out);
    }
    compact
}

fn event_success(event: &Map<String, Value>) -> Option<bool> {
    if let Some(v) = event.get("success") {
        return value_bool(Some(v));
    }
    if let Some(v) = event.get("is_error") {
        return value_bool(Some(v)).map(|b| !b);
    }
    if let Some(v) = event.get("exit_code") {
        return Some(safe_i64(Some(v)) == 0);
    }
    None
}

pub fn normalize_event(event: &Value) -> Value {
    let empty = Map::new();
    let event = event.as_object().unwrap_or(&empty);
    let raw_name = string_value(event.get("tool_name"))
        .or_else(|| string_value(event.get("tool")))
        .or_else(|| string_value(event.get("name")))
        .or_else(|| string_value(event.get("original_name")))
        .unwrap_or_else(|| "unknown".to_string());
    let tool_name = normalize_tool_name(&raw_name);

    let params_ref = event
        .get("key_params")
        .or_else(|| event.get("parameters"))
        .or_else(|| event.get("tool_input"))
        .or_else(|| event.get("input"));
    let parsed_preview = parse_preview(event.get("input_preview")).map(Value::Object);
    let key_params = compact_params(params_ref.or(parsed_preview.as_ref()));

    let mut out = Map::new();
    out.insert("tool_name".to_string(), Value::String(tool_name.clone()));
    out.insert("key_params".to_string(), Value::Object(key_params));
    match event_success(event) {
        Some(success) => out.insert("success".to_string(), Value::Bool(success)),
        None => out.insert("success".to_string(), Value::Null),
    };
    out.insert(
        "exit_code".to_string(),
        event.get("exit_code").cloned().unwrap_or(Value::Null),
    );
    out.insert(
        "duration_ms".to_string(),
        event.get("duration_ms").cloned().unwrap_or(Value::Null),
    );
    out.insert(
        "ts".to_string(),
        event
            .get("ts")
            .or_else(|| event.get("timestamp"))
            .cloned()
            .unwrap_or_else(|| Value::String(String::new())),
    );
    let original_name =
        string_value(event.get("original_name")).unwrap_or_else(|| raw_name.clone());
    if !original_name.is_empty() && original_name != tool_name {
        out.insert("original_name".to_string(), Value::String(original_name));
    }
    if value_bool(event.get("placeholder")).unwrap_or(false) {
        out.insert("placeholder".to_string(), Value::Bool(true));
    }
    Value::Object(out)
}

fn placeholder_event(tool_name: &str) -> Value {
    json!({
        "tool_name": normalize_tool_name(tool_name),
        "key_params": {},
        "success": null,
        "exit_code": null,
        "duration_ms": null,
        "ts": "",
        "placeholder": true
    })
}

fn count_tools(sequence: &[String]) -> Map<String, Value> {
    let mut counts: BTreeMap<String, i64> = BTreeMap::new();
    for tool in sequence {
        *counts.entry(tool.clone()).or_insert(0) += 1;
    }
    counts.into_iter().map(|(k, v)| (k, json!(v))).collect()
}

pub fn normalize_trajectory(trajectory: &Value, outcome: &Value) -> Value {
    let mut out = trajectory.as_object().cloned().unwrap_or_default();
    let raw_events = out
        .get("events")
        .or_else(|| out.get("tool_calls"))
        .or_else(|| out.get("tool_events"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut events: Vec<Value> = raw_events
        .iter()
        .filter(|v| v.is_object())
        .map(normalize_event)
        .collect();

    let observed_event_count = if out.get("observed_event_count").is_some() {
        safe_i64(out.get("observed_event_count"))
    } else {
        events
            .iter()
            .filter(|event| !value_bool(event.get("placeholder")).unwrap_or(false))
            .count() as i64
    };

    let mut tool_sequence: Vec<String> = out
        .get("tool_sequence")
        .and_then(Value::as_array)
        .filter(|items| !items.is_empty())
        .map(|items| {
            items
                .iter()
                .map(|v| {
                    normalize_tool_name(
                        &string_value(Some(v)).unwrap_or_else(|| "unknown".to_string()),
                    )
                })
                .collect()
        })
        .unwrap_or_else(|| {
            events
                .iter()
                .map(|event| {
                    string_value(event.get("tool_name")).unwrap_or_else(|| "unknown".to_string())
                })
                .collect()
        });

    let mut total_tools = safe_i64(out.get("total_tools"));
    if total_tools == 0 {
        total_tools = safe_i64(out.get("tool_count"));
    }
    if total_tools == 0 {
        total_tools = tool_sequence.len() as i64;
    }
    if total_tools == 0 {
        total_tools = events.len() as i64;
    }
    total_tools = total_tools
        .max(tool_sequence.len() as i64)
        .max(events.len() as i64);

    while tool_sequence.len() < total_tools as usize {
        tool_sequence.push("unknown".to_string());
    }
    if tool_sequence.len() > total_tools as usize {
        total_tools = tool_sequence.len() as i64;
    }
    while events.len() < total_tools as usize {
        let tool = tool_sequence
            .get(events.len())
            .cloned()
            .unwrap_or_else(|| "unknown".to_string());
        events.push(placeholder_event(&tool));
    }
    if events.len() > total_tools as usize {
        total_tools = events.len() as i64;
        while tool_sequence.len() < total_tools as usize {
            let tool = string_value(events[tool_sequence.len()].get("tool_name"))
                .unwrap_or_else(|| "unknown".to_string());
            tool_sequence.push(tool);
        }
    }

    let placeholder_count = events
        .iter()
        .filter(|event| value_bool(event.get("placeholder")).unwrap_or(false))
        .count() as i64;
    let success_rate = safe_f64(outcome.get("tool_success_rate"));
    let successes = if out.get("successes").is_some() {
        safe_i64(out.get("successes"))
    } else if let Some(rate) = success_rate {
        (rate * total_tools as f64).round() as i64
    } else {
        events
            .iter()
            .filter(|event| value_bool(event.get("success")) == Some(true))
            .count() as i64
    };
    let failures = if out.get("failures").is_some() {
        safe_i64(out.get("failures"))
    } else if success_rate.is_some() {
        (total_tools - successes).max(0)
    } else {
        events
            .iter()
            .filter(|event| value_bool(event.get("success")) == Some(false))
            .count() as i64
    };
    let bash_errors = if out.get("bash_errors").is_some() {
        safe_i64(out.get("bash_errors"))
    } else {
        events
            .iter()
            .filter(|event| {
                let exit_ok = match event.get("exit_code") {
                    None | Some(Value::Null) => true,
                    Some(Value::Number(n)) => n.as_i64() == Some(0),
                    _ => false,
                };
                string_value(event.get("tool_name")).as_deref() == Some("Bash")
                    && (value_bool(event.get("success")) == Some(false) || !exit_ok)
            })
            .count() as i64
    };

    out.insert("events".to_string(), Value::Array(events));
    out.insert(
        "tool_sequence".to_string(),
        Value::Array(tool_sequence.iter().cloned().map(Value::String).collect()),
    );
    out.insert(
        "tool_counts".to_string(),
        Value::Object(count_tools(&tool_sequence)),
    );
    out.insert("total_tools".to_string(), json!(total_tools));
    out.insert("successes".to_string(), json!(successes));
    out.insert("failures".to_string(), json!(failures));
    out.insert("bash_errors".to_string(), json!(bash_errors));
    out.insert(
        "observed_event_count".to_string(),
        json!(observed_event_count),
    );
    out.insert(
        "placeholder_event_count".to_string(),
        json!(placeholder_count),
    );
    out.insert("events_truncated".to_string(), json!(placeholder_count > 0));
    Value::Object(out)
}

fn infer_source(record: &Map<String, Value>, context: &Map<String, Value>) -> String {
    if let Some(source) =
        string_value(record.get("source")).or_else(|| string_value(context.get("source")))
    {
        return source;
    }
    if let Some(skill) = string_value(record.get("skill")) {
        if skill == "verbose-all" || skill == "aura-gateway-flow" || skill.starts_with("archive-") {
            return skill;
        }
    }
    string_value(record.get("channel")).unwrap_or_else(|| "unknown".to_string())
}

fn infer_channel(record: &Map<String, Value>, source: &str) -> String {
    if let Some(channel) = string_value(record.get("channel")) {
        return channel;
    }
    if source == "aura-gateway-flow" {
        "flow".to_string()
    } else if source == "verbose-all" || source.starts_with("archive-") {
        "backfill".to_string()
    } else {
        "unknown".to_string()
    }
}

fn normalize_skill(skill: Option<&Value>, domain: &str, source: &str) -> Value {
    if let Some(skill_obj) = skill.and_then(Value::as_object) {
        let name = string_value(skill_obj.get("name"));
        let skill_domain =
            string_value(skill_obj.get("domain")).unwrap_or_else(|| domain.to_string());
        return json!({"name": name, "domain": if skill_domain.is_empty() { Value::Null } else { Value::String(skill_domain) }});
    }
    if let Some(skill_name) = string_value(skill) {
        if skill_name == "verbose-all"
            || skill_name == "aura-gateway-flow"
            || skill_name.starts_with("archive-")
            || skill_name == source
        {
            return json!({"name": null, "domain": domain});
        }
        return json!({"name": skill_name, "domain": domain});
    }
    json!({"name": null, "domain": domain})
}

pub fn normalize_record(record: Value) -> Value {
    let mut out = if record.is_object() {
        record
    } else {
        json!({})
    };
    let obj_snapshot = out.as_object().cloned().unwrap_or_default();
    let mut context = obj_snapshot
        .get("context")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let source = infer_source(&obj_snapshot, &context);
    let skill_domain = obj_snapshot
        .get("skill")
        .and_then(Value::as_object)
        .and_then(|skill| string_value(skill.get("domain")));
    let domain = string_value(obj_snapshot.get("domain"))
        .or_else(|| string_value(context.get("domain")))
        .or(skill_domain)
        .unwrap_or_else(|| "unknown".to_string());

    context
        .entry("source".to_string())
        .or_insert_with(|| Value::String(source.clone()));
    context
        .entry("domain".to_string())
        .or_insert_with(|| Value::String(domain.clone()));
    let prompt_missing = context
        .get("prompt_text")
        .and_then(Value::as_str)
        .unwrap_or("")
        .is_empty();
    if prompt_missing {
        if let Some(prompt) = obj_snapshot
            .get("trajectory")
            .and_then(Value::as_object)
            .and_then(|trajectory| string_value(trajectory.get("prompt")))
        {
            context.insert(
                "prompt_text".to_string(),
                Value::String(prompt.chars().take(500).collect()),
            );
        }
    }

    let mut outcome = obj_snapshot
        .get("outcome")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if !outcome.contains_key("reward_score") {
        if let Some(score) = obj_snapshot.get("reward_score") {
            outcome.insert("reward_score".to_string(), score.clone());
        }
    }
    if !outcome.contains_key("annotation_status") {
        let status = if outcome.get("reward_score").is_some() {
            "scored"
        } else {
            "pending"
        };
        outcome.insert(
            "annotation_status".to_string(),
            Value::String(status.to_string()),
        );
    }

    let mut timing = obj_snapshot
        .get("timing")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if !timing.contains_key("duration_s") {
        if let Some(duration_ms) = safe_f64(timing.get("duration_ms")) {
            timing.insert("duration_s".to_string(), json!(duration_ms / 1000.0));
        }
    }

    let trajectory = normalize_trajectory(
        obj_snapshot.get("trajectory").unwrap_or(&Value::Null),
        &Value::Object(outcome.clone()),
    );

    let out_obj = as_object_mut_or_new(&mut out);
    out_obj.insert(
        "schema_version".to_string(),
        json!(CANONICAL_SCHEMA_VERSION),
    );
    out_obj.insert("source".to_string(), Value::String(source.clone()));
    out_obj.insert(
        "channel".to_string(),
        Value::String(infer_channel(&obj_snapshot, &source)),
    );
    out_obj.insert("domain".to_string(), Value::String(domain.clone()));
    out_obj.insert(
        "skill".to_string(),
        normalize_skill(obj_snapshot.get("skill"), &domain, &source),
    );
    out_obj.insert("context".to_string(), Value::Object(context));
    out_obj.insert("outcome".to_string(), Value::Object(outcome));
    out_obj.insert("timing".to_string(), Value::Object(timing));
    out_obj.insert("trajectory".to_string(), trajectory);
    out
}
