//! Backlog management — load, save, pop tasks from the task queue.
//!
//! Mirrors the Python controller's load_backlog / save_backlog / pop_next_task
//! functions. Uses atomic writes (write to tmp + rename) to prevent corruption.

use anyhow::{Context, Result};
use chrono::Utc;
use serde::Deserialize;
use std::io::Write;
use std::path::Path;
use tracing::warn;

use crate::state::BacklogTask;

/// Wrapper format: the Python controller sometimes uses {"items": [...]}
#[derive(Deserialize)]
struct BacklogWrapper {
    #[serde(default)]
    items: Vec<BacklogTask>,
}

/// Load the task backlog from a JSON file.
/// Handles both bare array `[...]` and wrapped `{"items": [...]}` formats.
/// Returns empty vec if file doesn't exist or is malformed.
pub fn load_backlog(path: &Path) -> Vec<BacklogTask> {
    if !path.exists() {
        return Vec::new();
    }
    match std::fs::read_to_string(path) {
        Ok(content) => {
            // Try bare array first
            if let Ok(tasks) = serde_json::from_str::<Vec<BacklogTask>>(&content) {
                return tasks;
            }
            // Try {"items": [...]} wrapper (Python controller format)
            if let Ok(wrapper) = serde_json::from_str::<BacklogWrapper>(&content) {
                return wrapper.items;
            }
            warn!(path = %path.display(), "backlog file format not recognized");
            Vec::new()
        }
        Err(e) => {
            warn!(path = %path.display(), err = %e, "failed to read backlog");
            Vec::new()
        }
    }
}

/// Save the task backlog to a JSON file (atomic write).
pub fn save_backlog(path: &Path, tasks: &[BacklogTask]) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let tmp_path = path.with_extension("tmp");
    let content = serde_json::to_string_pretty(tasks).context("serializing backlog")?;

    let mut file = std::fs::File::create(&tmp_path).context("creating backlog tmp file")?;
    file.write_all(content.as_bytes())
        .context("writing backlog")?;
    file.sync_all().context("syncing backlog")?;
    drop(file);

    std::fs::rename(&tmp_path, path).context("renaming backlog tmp to final")?;
    Ok(())
}

/// Dispatch the highest-priority pending task from the backlog.
/// Marks it as "dispatched" with a timestamp. Returns None if no pending tasks.
/// Note: does NOT remove the task — mutates `status` in place.
pub fn pop_next_task(tasks: &mut [BacklogTask]) -> Option<&mut BacklogTask> {
    // Find the pending task with highest priority (u8, higher = more urgent)
    let best_idx = tasks
        .iter()
        .enumerate()
        .filter(|(_, t)| t.status == "pending")
        .max_by_key(|(_, t)| t.priority)
        .map(|(i, _)| i)?;

    let task = &mut tasks[best_idx];
    task.status = "dispatched".to_string();
    task.dispatched_at = Some(Utc::now().to_rfc3339());
    Some(task)
}

/// Count pending tasks in the backlog.
pub fn count_pending(tasks: &[BacklogTask]) -> usize {
    tasks.iter().filter(|t| t.status == "pending").count()
}

/// Mark a task as injected (after successful meshd dispatch).
pub fn mark_injected(task: &mut BacklogTask, slot: &str, machine: &str) {
    task.status = "injected".to_string();
    task.injected_to = Some(format!("{}:{}", machine, slot));
}

/// Revert a task back to pending (after failed dispatch).
/// After 3 consecutive failures, quarantine the task to prevent live-lock.
pub fn mark_failed(task: &mut BacklogTask) {
    task.inject_failures += 1;
    if task.inject_failures >= 3 {
        task.status = "quarantined".to_string();
        tracing::warn!(
            task = %task.name,
            failures = task.inject_failures,
            "task quarantined after 3 inject failures"
        );
    } else {
        task.status = "pending".to_string();
    }
}
