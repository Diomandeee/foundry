use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::fs;
use tempfile::tempdir;
use trajectory_ledgerd::cursor::{cursor_consumed, CursorState};
use trajectory_ledgerd::ingest::{process_event_file, run_once, FlowState, LedgerConfig};
use trajectory_ledgerd::{normalize_record, score_record};

#[test]
fn normalizes_legacy_record_to_schema_v2_with_placeholders() {
    let record = json!({
        "id": "legacy-1",
        "skill": "verbose-all",
        "domain": "MotionMix",
        "trajectory": {
            "prompt": "fix camera tiles",
            "tool_calls": [
                {"tool": "read_file", "input_preview": "{\"file_path\":\"App.swift\"}", "success": true}
            ],
            "tool_count": 3
        },
        "outcome": {"tool_success_rate": 1.0}
    });

    let normalized = normalize_record(record);
    let trajectory = normalized.get("trajectory").unwrap();
    assert_eq!(
        normalized.get("schema_version").and_then(Value::as_i64),
        Some(2)
    );
    assert_eq!(
        normalized.get("source").and_then(Value::as_str),
        Some("verbose-all")
    );
    assert_eq!(
        normalized.get("channel").and_then(Value::as_str),
        Some("backfill")
    );
    assert_eq!(
        trajectory.get("total_tools").and_then(Value::as_i64),
        Some(3)
    );
    assert_eq!(
        trajectory
            .get("events")
            .and_then(Value::as_array)
            .unwrap()
            .len(),
        3
    );
    assert_eq!(
        trajectory
            .get("placeholder_event_count")
            .and_then(Value::as_i64),
        Some(2)
    );
    assert_eq!(
        trajectory.get("events").and_then(Value::as_array).unwrap()[0]
            .get("tool_name")
            .and_then(Value::as_str),
        Some("Read")
    );
}

#[test]
fn scores_normalized_records_with_six_signal_fields() {
    let record = json!({
        "id": "score-1",
        "source": "test",
        "channel": "backfill",
        "domain": "test",
        "context": {"prompt_text": "edit and test"},
        "trajectory": {
            "events": [
                {"tool_name": "Read", "key_params": {"file_path": "src/lib.rs"}, "success": true},
                {"tool_name": "Edit", "key_params": {"file_path": "src/lib.rs"}, "success": true},
                {"tool_name": "Read", "key_params": {"file_path": "src/lib.rs"}, "success": true},
                {"tool_name": "Bash", "key_params": {"command": "cargo test"}, "success": true, "exit_code": 0}
            ]
        },
        "outcome": {"build_success": true}
    });

    let scored = score_record(record);
    let outcome = scored.get("outcome").unwrap();
    assert_eq!(
        outcome.get("annotation_status").and_then(Value::as_str),
        Some("scored")
    );
    assert!(outcome.get("reward_score").and_then(Value::as_f64).unwrap() > 0.0);
    assert!(
        outcome
            .get("verification_score")
            .and_then(Value::as_f64)
            .unwrap()
            > 0.0
    );
    assert!(outcome
        .get("consistency_score")
        .and_then(Value::as_f64)
        .is_some());
    assert!(outcome
        .get("motion_score")
        .and_then(Value::as_f64)
        .is_some());
}

#[test]
fn cursor_consumption_is_date_scoped() {
    let cursor = CursorState {
        date: Some("2026-06-02".to_string()),
        seq: 94,
    };
    assert!(cursor_consumed(&cursor, "2026-06-02", 12));
    assert!(!cursor_consumed(&cursor, "2026-06-03", 12));

    let legacy_cursor = CursorState {
        date: None,
        seq: 94,
    };
    assert!(!cursor_consumed(&legacy_cursor, "2026-06-03", 12));
}

#[test]
fn ingests_gateway_flow_into_scored_ledger_record() {
    let dir = tempdir().unwrap();
    let events_dir = dir.path().join("events");
    fs::create_dir_all(&events_dir).unwrap();
    let events_path = events_dir.join("events-2026-06-03.jsonl");
    let store_path = dir.path().join("trajectories.jsonl");
    let metrics_path = dir.path().join("metrics.prom");
    let cursor_path = dir.path().join("cursor.json");

    let lines = [
        json!({"seq": 1, "ts": "2026-06-03T00:00:00Z", "type": "flow:start", "flow_id": "morning_brief", "payload": {"trigger_kind": "cron"}}),
        json!({"seq": 2, "ts": "2026-06-03T00:00:01Z", "type": "step:start", "flow_id": "morning_brief", "step_idx": 0, "payload": {"step_kind": "captain_ask", "prompt": "brief"}}),
        json!({"seq": 3, "ts": "2026-06-03T00:00:02Z", "type": "step:complete", "flow_id": "morning_brief", "step_idx": 0, "payload": {"step_kind": "captain_ask", "ok": true, "duration_ms": 120}}),
        json!({"seq": 4, "ts": "2026-06-03T00:00:03Z", "type": "flow:complete", "flow_id": "morning_brief", "payload": {"duration_ms": 3000, "first_error": null}}),
    ];
    let body = lines
        .iter()
        .map(|value| serde_json::to_string(value).unwrap())
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    fs::write(&events_path, body).unwrap();

    let config = LedgerConfig {
        events_dir,
        cursor_path,
        store_path: store_path.clone(),
        metrics_path: Some(metrics_path.clone()),
        date: Some("2026-06-03".to_string()),
        poll_ms: 1000,
        once: true,
    };
    let metrics = run_once(&config).unwrap();
    assert_eq!(metrics.envelopes_consumed, 4);
    assert_eq!(metrics.flow_cards_written, 1);
    assert_eq!(metrics.cursor_seq, 4);

    let ledger = fs::read_to_string(&store_path).unwrap();
    let rows = ledger.lines().collect::<Vec<_>>();
    assert_eq!(rows.len(), 1);
    let record: Value = serde_json::from_str(rows[0]).unwrap();
    assert_eq!(
        record.get("schema_version").and_then(Value::as_i64),
        Some(2)
    );
    assert_eq!(
        record.get("source").and_then(Value::as_str),
        Some("aura-gateway-flow")
    );
    assert_eq!(record.get("channel").and_then(Value::as_str), Some("flow"));
    assert!(record
        .get("outcome")
        .unwrap()
        .get("reward_score")
        .and_then(Value::as_f64)
        .is_some());
    assert_eq!(
        record
            .get("trajectory")
            .unwrap()
            .get("events")
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(fs::read_to_string(metrics_path)
        .unwrap()
        .contains("trajectory_ledgerd_flow_cards_written_total 1"));
}

#[test]
fn process_event_file_skips_already_consumed_date_seq() {
    let dir = tempdir().unwrap();
    let events_path = dir.path().join("events-2026-06-03.jsonl");
    fs::write(
        &events_path,
        serde_json::to_string(&json!({"seq": 1, "type": "flow:start", "flow_id": "x"})).unwrap()
            + "\n",
    )
    .unwrap();
    let mut existing = BTreeSet::new();
    let mut state = FlowState::default();
    let metrics = process_event_file(
        "2026-06-03",
        &events_path,
        &CursorState {
            date: Some("2026-06-03".to_string()),
            seq: 1,
        },
        &mut existing,
        &mut state,
        &dir.path().join("store.jsonl"),
    )
    .unwrap();
    assert_eq!(metrics.envelopes_skipped_cursor, 1);
    assert_eq!(metrics.envelopes_consumed, 0);
}
