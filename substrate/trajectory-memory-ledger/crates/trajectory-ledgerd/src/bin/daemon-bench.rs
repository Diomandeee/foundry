use anyhow::{bail, Context, Result};
use clap::Parser;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Barrier};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use trajectory_ledgerd::cursor::CursorState;
use trajectory_ledgerd::ingest::{process_event_file, FlowState};
use trajectory_ledgerd::store::{append_jsonl_locked, load_existing_ids};

#[derive(Debug, Parser)]
#[command(name = "daemon-bench")]
#[command(about = "Synthetic benchmark for trajectory-ledgerd")]
struct Args {
    /// Number of synthetic completed flows.
    #[arg(long, default_value_t = 1000)]
    flows: usize,

    /// Number of synthetic steps per flow.
    #[arg(long, default_value_t = 3)]
    steps: usize,

    /// Concurrent append writer threads.
    #[arg(long, default_value_t = 8)]
    concurrent_writers: usize,

    /// Records appended by each concurrent writer.
    #[arg(long, default_value_t = 100)]
    records_per_writer: usize,

    /// Optional output path for the benchmark JSON.
    #[arg(long)]
    output: Option<PathBuf>,

    /// Keep the temporary working directory and include its path in output.
    #[arg(long)]
    keep_dir: bool,
}

#[derive(Debug, Serialize)]
struct BenchReport {
    benchmark: &'static str,
    flows: usize,
    steps_per_flow: usize,
    events: usize,
    ingest_ms: f64,
    events_per_sec: f64,
    records_per_sec: f64,
    append_latency_mean_ms: f64,
    append_latency_p95_ms: f64,
    duplicate_first_written: u64,
    duplicate_second_skipped: u64,
    cursor_rollover_consumed: u64,
    cursor_rollover_ok: bool,
    concurrent_writers: usize,
    concurrent_records_expected: usize,
    concurrent_records_written: usize,
    concurrent_unique_ids: usize,
    concurrent_append_ok: bool,
    temp_dir: Option<String>,
}

fn main() -> Result<()> {
    let args = Args::parse();
    if args.flows == 0 || args.steps == 0 {
        bail!("--flows and --steps must be > 0");
    }

    let bench_dir = make_temp_dir()?;
    fs::create_dir_all(bench_dir.join("events"))?;
    let date = "2026-06-03";
    let events_path = bench_dir
        .join("events")
        .join(format!("events-{date}.jsonl"));
    let store_path = bench_dir.join("trajectories.jsonl");
    write_synthetic_events(&events_path, date, args.flows, args.steps)?;
    let total_events = args.flows * (2 + args.steps * 2);

    let mut existing_ids = BTreeSet::new();
    let mut state = FlowState::default();
    let start = Instant::now();
    let ingest_metrics = process_event_file(
        date,
        &events_path,
        &CursorState::default(),
        &mut existing_ids,
        &mut state,
        &store_path,
    )?;
    let ingest_elapsed = start.elapsed();
    assert_eq!(ingest_metrics.flow_cards_written as usize, args.flows);

    let append_latencies = measure_append_latency(&bench_dir.join("append-latency.jsonl"), 200)?;
    let duplicate_metrics = measure_duplicate_skip(date, &events_path, &store_path)?;
    let rollover_metrics = measure_cursor_rollover(&bench_dir)?;
    let concurrent = measure_concurrent_append(
        &bench_dir.join("concurrent.jsonl"),
        args.concurrent_writers,
        args.records_per_writer,
    )?;

    let ingest_secs = ingest_elapsed.as_secs_f64().max(0.000_001);
    let mut report = BenchReport {
        benchmark: "trajectory-ledgerd-daemon-synthetic",
        flows: args.flows,
        steps_per_flow: args.steps,
        events: total_events,
        ingest_ms: round3(ms(ingest_elapsed)),
        events_per_sec: round3(total_events as f64 / ingest_secs),
        records_per_sec: round3(args.flows as f64 / ingest_secs),
        append_latency_mean_ms: round3(mean(&append_latencies)),
        append_latency_p95_ms: round3(percentile(&append_latencies, 0.95)),
        duplicate_first_written: duplicate_metrics.0,
        duplicate_second_skipped: duplicate_metrics.1,
        cursor_rollover_consumed: rollover_metrics.0,
        cursor_rollover_ok: rollover_metrics.1,
        concurrent_writers: args.concurrent_writers,
        concurrent_records_expected: args.concurrent_writers * args.records_per_writer,
        concurrent_records_written: concurrent.0,
        concurrent_unique_ids: concurrent.1,
        concurrent_append_ok: concurrent.0 == args.concurrent_writers * args.records_per_writer
            && concurrent.1 == args.concurrent_writers * args.records_per_writer,
        temp_dir: args.keep_dir.then(|| bench_dir.display().to_string()),
    };
    if !args.keep_dir {
        fs::remove_dir_all(&bench_dir).ok();
        report.temp_dir = None;
    }

    let output = serde_json::to_string_pretty(&report)?;
    println!("{output}");
    if let Some(path) = args.output {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(path, output + "\n")?;
    }
    Ok(())
}

fn make_temp_dir() -> Result<PathBuf> {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
    let path = std::env::temp_dir().join(format!(
        "trajectory-ledgerd-bench-{}-{nanos}",
        std::process::id()
    ));
    fs::create_dir_all(&path)?;
    Ok(path)
}

fn write_synthetic_events(path: &Path, date: &str, flows: usize, steps: usize) -> Result<()> {
    let mut file = File::create(path)?;
    let mut seq = 1usize;
    for flow_idx in 0..flows {
        let flow_id = format!("bench_flow_{flow_idx:06}");
        writeln!(
            file,
            "{}",
            json!({
                "seq": seq,
                "ts": format!("{date}T00:00:00Z"),
                "type": "flow:start",
                "flow_id": flow_id,
                "payload": {"trigger_kind": "bench"}
            })
        )?;
        seq += 1;
        for step_idx in 0..steps {
            let step_kind = if step_idx % 3 == 0 {
                "captain_ask"
            } else if step_idx % 3 == 1 {
                "inject"
            } else {
                "ntfy_push"
            };
            writeln!(
                file,
                "{}",
                json!({
                    "seq": seq,
                    "ts": format!("{date}T00:00:01Z"),
                    "type": "step:start",
                    "flow_id": flow_id,
                    "step_idx": step_idx,
                    "payload": {"step_kind": step_kind, "prompt": "synthetic benchmark"}
                })
            )?;
            seq += 1;
            writeln!(
                file,
                "{}",
                json!({
                    "seq": seq,
                    "ts": format!("{date}T00:00:02Z"),
                    "type": "step:complete",
                    "flow_id": flow_id,
                    "step_idx": step_idx,
                    "payload": {"step_kind": step_kind, "ok": true, "duration_ms": 50 + step_idx}
                })
            )?;
            seq += 1;
        }
        writeln!(
            file,
            "{}",
            json!({
                "seq": seq,
                "ts": format!("{date}T00:00:03Z"),
                "type": "flow:complete",
                "flow_id": flow_id,
                "payload": {"duration_ms": 1000, "first_error": null}
            })
        )?;
        seq += 1;
    }
    Ok(())
}

fn measure_append_latency(path: &Path, records: usize) -> Result<Vec<f64>> {
    let mut latencies = Vec::with_capacity(records);
    for idx in 0..records {
        let record = json!({"id": format!("append_latency_{idx}"), "schema_version": 2});
        let start = Instant::now();
        append_jsonl_locked(path, &record)?;
        latencies.push(ms(start.elapsed()));
    }
    Ok(latencies)
}

fn measure_duplicate_skip(date: &str, events_path: &Path, store_path: &Path) -> Result<(u64, u64)> {
    let mut existing_ids = load_existing_ids(store_path)?;
    let mut state = FlowState::default();
    let metrics = process_event_file(
        date,
        events_path,
        &CursorState::default(),
        &mut existing_ids,
        &mut state,
        store_path,
    )?;
    Ok((
        metrics.flow_cards_written,
        metrics.flow_cards_skipped_existing,
    ))
}

fn measure_cursor_rollover(dir: &Path) -> Result<(u64, bool)> {
    let date = "2026-06-04";
    let events_path = dir.join("events").join(format!("events-{date}.jsonl"));
    write_synthetic_events(&events_path, date, 1, 1)?;
    let mut existing_ids = BTreeSet::new();
    let mut state = FlowState::default();
    let store = dir.join("rollover.jsonl");
    let metrics = process_event_file(
        date,
        &events_path,
        &CursorState {
            date: Some("2026-06-03".to_string()),
            seq: 999_999,
        },
        &mut existing_ids,
        &mut state,
        &store,
    )?;
    let ok = metrics.envelopes_consumed > 0 && metrics.envelopes_skipped_cursor == 0;
    Ok((metrics.envelopes_consumed, ok))
}

fn measure_concurrent_append(
    path: &Path,
    writers: usize,
    records_per_writer: usize,
) -> Result<(usize, usize)> {
    let barrier = Arc::new(Barrier::new(writers.max(1)));
    let mut handles = Vec::with_capacity(writers);
    for writer_idx in 0..writers {
        let path = path.to_path_buf();
        let barrier = Arc::clone(&barrier);
        handles.push(thread::spawn(move || -> Result<()> {
            barrier.wait();
            for record_idx in 0..records_per_writer {
                let id = format!("writer_{writer_idx:03}_{record_idx:05}");
                append_jsonl_locked(&path, &json!({"id": id, "schema_version": 2}))?;
            }
            Ok(())
        }));
    }
    for handle in handles {
        handle
            .join()
            .map_err(|_| anyhow::anyhow!("writer thread panicked"))??;
    }
    let file =
        File::open(path).with_context(|| format!("open concurrent output {}", path.display()))?;
    let mut count = 0usize;
    let mut ids = BTreeSet::new();
    for line in BufReader::new(file).lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        count += 1;
        let value: Value = serde_json::from_str(&line)?;
        if let Some(id) = value.get("id").and_then(Value::as_str) {
            ids.insert(id.to_string());
        }
    }
    Ok((count, ids.len()))
}

fn ms(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1000.0
}

fn mean(values: &[f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    values.iter().sum::<f64>() / values.len() as f64
}

fn percentile(values: &[f64], p: f64) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let idx = ((sorted.len() - 1) as f64 * p).round() as usize;
    sorted[idx]
}

fn round3(value: f64) -> f64 {
    (value * 1000.0).round() / 1000.0
}
