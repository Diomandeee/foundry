//! State types for the orchestrator daemon.
//!
//! Mirrors the Python controller's data structures:
//! - AutopilotPlan / AutopilotStep (from autopilot.json)
//! - BacklogTask (from backlog.json)
//! - OrchestratorState (runtime state persisted to state.json)
//! - SlotState (meshd slot status)

use chrono::{DateTime, Utc};
use serde::{Deserialize, Deserializer, Serialize};

/// Coalesce JSON `null` to `T::default()` — needed because Python writes `null`
/// for optional string fields but our struct uses plain `String` (not `Option<String>`).
/// `#[serde(default)]` only fires on *absent* keys, not on explicit `null`.
fn deserialize_null_default<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Default + Deserialize<'de>,
{
    Ok(Option::deserialize(deserializer)?.unwrap_or_default())
}

// --- Autopilot ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutopilotPlan {
    #[serde(default, alias = "origin_prompt")]
    pub name: String,
    #[serde(default)]
    pub status: String, // "active", "paused", "completed"
    #[serde(default)]
    pub steps: Vec<AutopilotStep>,
    #[serde(default)]
    pub completed_count: usize,
    #[serde(default)]
    pub total_steps: usize,
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub origin_session: Option<String>,
    #[serde(default)]
    pub depth: u32,
    #[serde(default)]
    pub max_steps: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutopilotStep {
    pub id: u32,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub project: String,
    #[serde(default)]
    pub skill: Option<String>,
    #[serde(default)]
    pub sub_steps: Option<Vec<String>>,
    #[serde(default)]
    pub priority: u8,
    #[serde(default)]
    pub status: String, // "pending", "running", "completed", "skipped", "error"
    #[serde(default)]
    pub depends_on: Vec<u32>,
    #[serde(default)]
    pub result_summary: Option<String>,
    #[serde(default)]
    pub completed_at: Option<String>,
    #[serde(default)]
    pub started_at: Option<String>,
    #[serde(default)]
    pub generation: u32,
}

// --- Backlog ---

/// Backlog task. Uses `deny_unknown_fields` OFF so it tolerates extra fields
/// from the Python controller (e.g., `autopilot: true`, `autopilot_step`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BacklogTask {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub prompt: String,
    #[serde(default, deserialize_with = "deserialize_null_default")]
    pub project: String,
    #[serde(default)]
    pub priority: u8,
    #[serde(default = "default_pending")]
    pub status: String, // "pending", "dispatched", "injected", "completed", "failed"
    #[serde(default, deserialize_with = "deserialize_null_default")]
    pub source: String, // "autopilot", "manual", "escalation"
    #[serde(default)]
    pub skill: Option<String>,
    /// Accepts both "autopilot_step_id" and "autopilot_step" from legacy files.
    #[serde(default, alias = "autopilot_step")]
    pub autopilot_step_id: Option<u32>,
    #[serde(default)]
    pub dispatched_at: Option<String>,
    #[serde(default)]
    pub injected_to: Option<String>,
    #[serde(default)]
    pub inject_failures: u32,
    /// Legacy Python field -- tolerated but not used.
    #[serde(default, skip_serializing)]
    #[allow(dead_code)]
    pub autopilot: Option<bool>,
}

fn default_pending() -> String {
    "pending".to_string()
}

// --- Slot state (from meshd /status) ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlotState {
    pub name: String,
    #[serde(default)]
    pub state: String, // "idle", "busy", "spawning", "dead"
    #[serde(default)]
    pub pid: Option<u32>,
    #[serde(default)]
    pub machine: String,
}

// --- meshd status response ---

#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code)]
pub struct MeshdStatusResponse {
    #[serde(default)]
    pub machine_id: String,
    #[serde(default)]
    pub slots: Vec<SlotState>,
}

// --- meshd inject response ---

#[derive(Debug, Deserialize)]
pub struct InjectResponse {
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub bytes_written: Option<u64>,
    #[serde(default)]
    pub error: Option<String>,
}

// --- Runtime orchestrator state ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrchestratorState {
    pub heartbeat_count: u64,
    pub interval_secs: f64,
    pub injection_window: Vec<f64>, // timestamps of recent injections
    pub all_idle_cycles: u64,
    pub last_novelty: f64,
    pub slot_states: Vec<SlotState>,
    pub started_at: DateTime<Utc>,
    pub last_heartbeat_at: Option<DateTime<Utc>>,
}

impl OrchestratorState {
    pub fn new(interval: f64) -> Self {
        Self {
            heartbeat_count: 0,
            interval_secs: interval,
            injection_window: Vec::new(),
            all_idle_cycles: 0,
            last_novelty: 0.0,
            slot_states: Vec::new(),
            started_at: Utc::now(),
            last_heartbeat_at: None,
        }
    }

    /// Uptime in seconds since daemon start.
    pub fn uptime_secs(&self) -> f64 {
        (Utc::now() - self.started_at).num_milliseconds() as f64 / 1000.0
    }
}

// --- Heartbeat result (for logging / API) ---

#[derive(Debug, Clone, Serialize)]
pub struct HeartbeatResult {
    pub cycle: u64,
    pub timestamp: DateTime<Utc>,
    pub phase: String,
    pub slots_polled: usize,
    pub idle_slots: usize,
    pub tasks_dispatched: usize,
    pub invariant_violations: usize,
    pub interval_secs: f64,
    pub autopilot_injected: usize,
    pub elapsed_ms: u64,
}
