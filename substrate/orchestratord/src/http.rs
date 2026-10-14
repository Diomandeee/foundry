//! HTTP status API — health, status, autopilot endpoints.
//!
//! Provides observability into the orchestrator daemon:
//! - GET /health       — uptime, heartbeat count (for LaunchAgent monitoring)
//! - GET /status       — full state: backlog size, autopilot progress, slot states
//! - GET /autopilot    — autopilot plan details
//! - POST /autopilot/step/:id/complete — mark a step completed (external callers)

use axum::{
    extract::{Path, Request, State},
    http::StatusCode,
    middleware::{self, Next},
    response::{Json, Response},
    routing::{get, post},
    Router,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::RwLock;

use crate::autopilot;
use crate::backlog;
use crate::config::Config;
use crate::state::OrchestratorState;

/// Shared state for HTTP handlers.
#[derive(Clone)]
pub struct AppState {
    pub orchestrator: Arc<RwLock<OrchestratorState>>,
    pub config: Config,
}

/// Bearer token auth middleware — rejects requests without valid Authorization header.
async fn require_auth(
    State(state): State<AppState>,
    req: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    // Health endpoint is always public (for LaunchAgent monitoring)
    if req.uri().path() == "/health" {
        return Ok(next.run(req).await);
    }
    let expected = format!("Bearer {}", state.config.meshd_token);
    match req.headers().get("authorization").and_then(|v| v.to_str().ok()) {
        Some(v) if v == expected => Ok(next.run(req).await),
        _ => Err(StatusCode::UNAUTHORIZED),
    }
}

/// Build the axum router with all endpoints.
pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/status", get(status))
        .route("/autopilot", get(autopilot_status))
        .route("/autopilot/step/{id}/complete", post(complete_step))
        .layer(middleware::from_fn_with_state(state.clone(), require_auth))
        .with_state(state)
}

// --- Health ---

#[derive(Serialize)]
struct HealthResponse {
    status: &'static str,
    cycle_count: u64,
    uptime_seconds: f64,
    interval_seconds: f64,
}

async fn health(State(state): State<AppState>) -> Json<HealthResponse> {
    let st = state.orchestrator.read().await;
    Json(HealthResponse {
        status: "healthy",
        cycle_count: st.heartbeat_count,
        uptime_seconds: st.uptime_secs(),
        interval_seconds: st.interval_secs,
    })
}

// --- Full Status ---

#[derive(Serialize)]
struct StatusResponse {
    status: &'static str,
    cycle_count: u64,
    uptime_seconds: f64,
    interval_seconds: f64,
    last_heartbeat_at: Option<String>,
    backlog_pending: usize,
    backlog_total: usize,
    all_idle_cycles: u64,
    last_novelty: f64,
    slots: Vec<SlotInfo>,
    autopilot_active: bool,
    autopilot_completed: usize,
    autopilot_total: usize,
}

#[derive(Serialize)]
struct SlotInfo {
    machine: String,
    name: String,
    state: String,
}

async fn status(State(state): State<AppState>) -> Json<StatusResponse> {
    let st = state.orchestrator.read().await;

    let tasks = backlog::load_backlog(&state.config.backlog_path());
    let pending = backlog::count_pending(&tasks);

    let slots: Vec<SlotInfo> = st
        .slot_states
        .iter()
        .map(|s| SlotInfo {
            machine: s.machine.clone(),
            name: s.name.clone(),
            state: s.state.clone(),
        })
        .collect();

    // Autopilot summary
    let (ap_active, ap_completed, ap_total) =
        match autopilot::get_plan(&state.config.autopilot_path()) {
            Ok(Some(plan)) => (
                plan.status == "active",
                plan.completed_count,
                plan.steps.len(),
            ),
            _ => (false, 0, 0),
        };

    Json(StatusResponse {
        status: "healthy",
        cycle_count: st.heartbeat_count,
        uptime_seconds: st.uptime_secs(),
        interval_seconds: st.interval_secs,
        last_heartbeat_at: st.last_heartbeat_at.map(|t| t.to_rfc3339()),
        backlog_pending: pending,
        backlog_total: tasks.len(),
        all_idle_cycles: st.all_idle_cycles,
        last_novelty: st.last_novelty,
        slots,
        autopilot_active: ap_active,
        autopilot_completed: ap_completed,
        autopilot_total: ap_total,
    })
}

// --- Autopilot ---

async fn autopilot_status(State(state): State<AppState>) -> Result<Json<serde_json::Value>, StatusCode> {
    match autopilot::get_plan(&state.config.autopilot_path()) {
        Ok(Some(plan)) => Ok(Json(serde_json::to_value(plan).unwrap_or_default())),
        Ok(None) => Ok(Json(serde_json::json!({
            "status": "no_plan",
            "message": "No autopilot.json found"
        }))),
        Err(_) => Err(StatusCode::INTERNAL_SERVER_ERROR),
    }
}

// --- Complete Step ---

#[derive(Deserialize)]
struct CompleteStepBody {
    #[serde(default)]
    summary: String,
    #[serde(default = "default_status")]
    status: String,
}

fn default_status() -> String {
    "completed".to_string()
}

async fn complete_step(
    State(state): State<AppState>,
    Path(id): Path<u32>,
    Json(body): Json<CompleteStepBody>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    // Validate status is a known terminal state
    match body.status.as_str() {
        "completed" | "skipped" | "error" => {}
        other => {
            return Ok(Json(serde_json::json!({
                "ok": false,
                "error": format!("invalid status '{}', must be completed/skipped/error", other),
            })));
        }
    }
    match autopilot::mark_step_completed(
        &state.config.autopilot_path(),
        id,
        &body.status,
        &body.summary,
    ) {
        Ok(()) => Ok(Json(serde_json::json!({
            "ok": true,
            "step_id": id,
            "status": body.status,
        }))),
        Err(_) => Err(StatusCode::INTERNAL_SERVER_ERROR),
    }
}
