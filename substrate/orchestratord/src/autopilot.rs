//! Autopilot step resolver.
//!
//! Reads autopilot.json, checks which steps have all dependencies met,
//! injects newly-unblocked steps into the backlog, and marks completed steps.
//!
//! Mirrors the Python controller's resolve_autopilot_steps and _mark_autopilot_step.

use anyhow::{Context, Result};
use chrono::Utc;
use std::collections::HashSet;
use std::io::Write;
use std::path::Path;
use tracing::{info, warn};

use crate::state::{AutopilotPlan, BacklogTask};

/// Resolve autopilot steps: find pending steps with all dependencies met,
/// inject them into the backlog. Returns the count of newly injected steps.
pub fn resolve_steps(
    autopilot_path: &Path,
    backlog: &mut Vec<BacklogTask>,
) -> Result<usize> {
    if !autopilot_path.exists() {
        return Ok(0);
    }

    let content = std::fs::read_to_string(autopilot_path)
        .context("reading autopilot.json")?;
    let mut plan: AutopilotPlan =
        serde_json::from_str(&content).context("parsing autopilot.json")?;

    if plan.status != "active" {
        return Ok(0);
    }

    // Gather completed/skipped step IDs
    let completed_ids: HashSet<u32> = plan
        .steps
        .iter()
        .filter(|s| s.status == "completed" || s.status == "skipped")
        .map(|s| s.id)
        .collect();

    // Gather step IDs already in the backlog from autopilot source
    let backlog_ids: HashSet<u32> = backlog
        .iter()
        .filter(|t| t.source == "autopilot")
        .filter_map(|t| t.autopilot_step_id)
        .collect();

    let mut injected = 0;

    for step in plan.steps.iter_mut() {
        if step.status != "pending" {
            continue;
        }
        // Skip if already queued in backlog
        if backlog_ids.contains(&step.id) {
            continue;
        }
        // Check all dependencies resolved
        if !step.depends_on.is_empty()
            && !step.depends_on.iter().all(|d| completed_ids.contains(d))
        {
            continue;
        }

        // Dependencies met -- create backlog task and prepend (high priority)
        let task = BacklogTask {
            id: format!("autopilot-{}", step.id),
            name: if step.name.is_empty() {
                format!("Autopilot step {}", step.id)
            } else {
                step.name.clone()
            },
            prompt: step.prompt.clone(),
            project: step.project.clone(),
            priority: step.priority,
            status: "pending".to_string(),
            source: "autopilot".to_string(),
            skill: step.skill.clone(),
            autopilot_step_id: Some(step.id),
            dispatched_at: None,
            injected_to: None,
            inject_failures: 0,
            autopilot: Some(true),
        };

        backlog.insert(0, task);
        step.status = "running".to_string();
        injected += 1;
        info!(
            step_id = step.id,
            name = %step.name,
            "autopilot: unblocked step"
        );
    }

    if injected > 0 {
        // Update completed_count and persist
        plan.completed_count = plan
            .steps
            .iter()
            .filter(|s| s.status == "completed" || s.status == "skipped")
            .count();
        atomic_write_json(autopilot_path, &plan)?;
    }

    Ok(injected)
}

/// Mark an autopilot step as completed (or skipped/error).
pub fn mark_step_completed(
    autopilot_path: &Path,
    step_id: u32,
    status: &str,
    summary: &str,
) -> Result<()> {
    if !autopilot_path.exists() {
        anyhow::bail!("autopilot.json not found at {}", autopilot_path.display());
    }

    let content = std::fs::read_to_string(autopilot_path)?;
    let mut plan: AutopilotPlan = serde_json::from_str(&content)?;

    let mut found = false;
    for step in plan.steps.iter_mut() {
        if step.id == step_id {
            step.status = status.to_string();
            step.result_summary = Some(summary.to_string());
            step.completed_at = Some(Utc::now().to_rfc3339());
            found = true;
            break;
        }
    }

    if !found {
        warn!(step_id, "autopilot step not found");
        return Ok(());
    }

    plan.completed_count = plan
        .steps
        .iter()
        .filter(|s| s.status == "completed" || s.status == "skipped")
        .count();

    atomic_write_json(autopilot_path, &plan)?;
    info!(step_id, status, "autopilot step marked");
    Ok(())
}

/// Get autopilot plan status (for API).
pub fn get_plan(autopilot_path: &Path) -> Result<Option<AutopilotPlan>> {
    if !autopilot_path.exists() {
        return Ok(None);
    }
    let content = std::fs::read_to_string(autopilot_path)?;
    let plan: AutopilotPlan = serde_json::from_str(&content)?;
    Ok(Some(plan))
}

/// Atomic JSON write: unique tmp file + rename (no collision on concurrent writes).
fn atomic_write_json<T: serde::Serialize>(path: &Path, data: &T) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let pid = std::process::id();
    let tmp = path.with_extension(format!("tmp.{}.{}", pid, nonce));
    let json = serde_json::to_string_pretty(data)?;
    let mut f = std::fs::File::create(&tmp)?;
    f.write_all(json.as_bytes())?;
    f.sync_all()?;
    drop(f);
    std::fs::rename(&tmp, path)?;
    Ok(())
}
