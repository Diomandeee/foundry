//! 5-phase heartbeat loop: sense -> select -> mutate -> check -> adapt.
//!
//! This is the core of orchestratord, translating the Python OrchestratorLoop
//! into a headless Rust daemon that dispatches work through meshd HTTP endpoints
//! instead of AppleScript clipboard injection.
//!
//! The 4 EW invariants adapted for orchestration:
//!   1. Min Entropy Production: every cycle must observe something or inject work
//!   2. Bounded Divergence: max M injections per sliding window
//!   3. Cross-Layer Forcing: if all slots idle for N cycles, escalate
//!   4. No Absorbing States: always have a valid next action (backlog not empty)

use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{debug, info, warn};
use chrono::Utc;

use crate::autopilot;
use crate::backlog;
use crate::config::Config;
use crate::dispatch::Dispatcher;
use crate::state::{HeartbeatResult, OrchestratorState};

pub struct HeartbeatLoop {
    config: Config,
    state: Arc<RwLock<OrchestratorState>>,
    dispatcher: Arc<Dispatcher>,
    cycle_count: u64,
}

impl HeartbeatLoop {
    pub fn new(
        config: Config,
        state: Arc<RwLock<OrchestratorState>>,
        dispatcher: Arc<Dispatcher>,
    ) -> Self {
        Self {
            config,
            state,
            dispatcher,
            cycle_count: 0,
        }
    }

    /// Run the heartbeat loop until shutdown signal.
    pub async fn run(&mut self, mut shutdown: tokio::sync::watch::Receiver<bool>) {
        info!(
            interval = self.config.interval_secs,
            "heartbeat loop starting"
        );

        loop {
            let interval = {
                self.state.read().await.interval_secs as u64
            };

            tokio::select! {
                _ = tokio::time::sleep(std::time::Duration::from_secs(interval)) => {
                    let result = self.tick().await;
                    info!(
                        cycle = result.cycle,
                        slots_polled = result.slots_polled,
                        idle = result.idle_slots,
                        dispatched = result.tasks_dispatched,
                        violations = result.invariant_violations,
                        interval = format!("{:.0}", result.interval_secs),
                        autopilot = result.autopilot_injected,
                        elapsed_ms = result.elapsed_ms,
                        "heartbeat"
                    );
                }
                _ = shutdown.changed() => {
                    if *shutdown.borrow() {
                        info!("heartbeat loop shutting down");
                        break;
                    }
                }
            }
        }
    }

    /// Execute one full 5-phase heartbeat cycle.
    async fn tick(&mut self) -> HeartbeatResult {
        self.cycle_count += 1;
        let t0 = std::time::Instant::now();
        let mut violations = 0;

        // ========================================
        // Phase 1: SENSE
        // ========================================
        // Poll meshd on all machines to discover slot states.
        // Run autopilot resolver to inject unblocked steps.
        let all_slots = self.dispatcher.poll_all_nodes().await;
        let slot_count = all_slots.len();
        let idle_count = all_slots
            .iter()
            .filter(|s| s.state == "idle" || s.state == "ready" || s.state == "unborn")
            .count();
        let busy_count = slot_count - idle_count;

        // Run autopilot resolver
        let autopilot_path = self.config.autopilot_path();
        let backlog_path = self.config.backlog_path();
        // Load backlog off the async executor (blocking I/O)
        let bp = backlog_path.clone();
        let mut tasks = tokio::task::spawn_blocking(move || backlog::load_backlog(&bp))
            .await
            .unwrap_or_default();
        let ap_injected = match autopilot::resolve_steps(&autopilot_path, &mut tasks) {
            Ok(n) => {
                if n > 0 {
                    let bp = backlog_path.clone();
                    let t = tasks.clone();
                    if let Err(e) = tokio::task::spawn_blocking(move || backlog::save_backlog(&bp, &t)).await {
                        warn!(err = %e, "failed to save backlog after autopilot resolve");
                    }
                    info!(count = n, "autopilot injected steps into backlog");
                }
                n
            }
            Err(e) => {
                debug!(err = %e, "autopilot resolver error");
                0
            }
        };

        // Update state with slot info
        {
            let mut st = self.state.write().await;
            st.slot_states = all_slots.clone();
            st.last_heartbeat_at = Some(Utc::now());
        }

        info!(
            total = slot_count,
            idle = idle_count,
            busy = busy_count,
            pending_tasks = backlog::count_pending(&tasks),
            "SENSE"
        );

        // ========================================
        // Phase 2: SELECT
        // ========================================
        // Find idle slots that can accept work. Check bounded divergence.
        let can_inject = self.check_bounded_divergence().await;
        let pending_count = backlog::count_pending(&tasks);
        let has_target = can_inject && pending_count > 0 && idle_count > 0;

        if !can_inject {
            info!("SELECT: bounded divergence limit reached");
        } else if pending_count == 0 {
            debug!("SELECT: no pending tasks");
        } else if idle_count == 0 {
            debug!("SELECT: no idle slots");
        }

        // ========================================
        // Phase 3: MUTATE
        // ========================================
        // Pop next task from backlog, dispatch via meshd.
        let mut dispatched = 0;
        if has_target {
            // Use the same tasks vec from Phase 1 (already includes autopilot-injected steps)
            if let Some(task) = backlog::pop_next_task(&mut tasks) {
                let prompt = task.prompt.clone();
                let task_name = task.name.clone();
                let task_source = task.source.clone();
                let task_step_id = task.autopilot_step_id;

                if !prompt.is_empty() {
                    info!(task = %task_name, "MUTATE: dispatching");
                    match self.dispatcher.dispatch_best(&prompt, &all_slots).await {
                        Ok((machine, slot, _bytes)) => {
                            backlog::mark_injected(task, &slot, &machine);
                            dispatched = 1;
                            info!(
                                task = %task_name,
                                machine = %machine,
                                slot = %slot,
                                "MUTATE: dispatched"
                            );

                            // Record injection timestamp
                            {
                                let mut st = self.state.write().await;
                                let now = Utc::now().timestamp() as f64;
                                st.injection_window.push(now);
                            }

                            // Mark autopilot step completed if this was an autopilot task
                            if task_source == "autopilot" {
                                if let Some(step_id) = task_step_id {
                                    let summary =
                                        format!("Dispatched to {}:{}", machine, slot);
                                    if let Err(e) = autopilot::mark_step_completed(
                                        &autopilot_path,
                                        step_id,
                                        "completed",
                                        &summary,
                                    ) {
                                        warn!(
                                            step_id,
                                            err = %e,
                                            "failed to mark autopilot step"
                                        );
                                    }
                                }
                            }
                        }
                        Err(e) => {
                            warn!(task = %task_name, err = %e, "MUTATE: dispatch failed");
                            backlog::mark_failed(task);
                        }
                    }
                }
                // Save backlog regardless of outcome (off executor — fsync can block)
                let bp = backlog_path.clone();
                let t = tasks.clone();
                if let Err(e) = tokio::task::spawn_blocking(move || backlog::save_backlog(&bp, &t)).await {
                    warn!(err = %e, "failed to save backlog after mutate");
                }
            }
        }

        // ========================================
        // Phase 4: CHECK
        // ========================================
        // Run 4 invariants.

        // Invariant 1: Min entropy production
        // We must have observed something (slots polled > 0) or injected work.
        if slot_count == 0 && dispatched == 0 {
            violations += 1;
            warn!("CHECK: min entropy violation (no slots observed, no dispatch)");
        }

        // Invariants 2-4 + Phase 5 ADAPT: single write lock for consistent state snapshot
        let all_idle = idle_count == slot_count && slot_count > 0;
        let interval = {
            let mut st = self.state.write().await;

            // Invariant 2: Bounded divergence — clean old injection timestamps
            let cutoff = Utc::now().timestamp() as f64
                - (self.config.interval_secs as f64 * 5.0);
            st.injection_window.retain(|&ts| ts > cutoff);

            // Invariant 3: Cross-layer forcing
            if all_idle {
                st.all_idle_cycles += 1;
                if st.all_idle_cycles >= self.config.idle_cycles_before_escalation {
                    violations += 1;
                    warn!(
                        cycles = st.all_idle_cycles,
                        "CHECK: cross-layer forcing (all slots idle too long)"
                    );
                }
            } else {
                st.all_idle_cycles = 0;
            }

            // Invariant 4: No absorbing states (advisory only)
            if pending_count == 0 && all_idle && ap_injected == 0 {
                debug!("CHECK: absorbing state advisory (empty backlog, all idle, no autopilot)");
            }

            // Phase 5: ADAPT — metabolism-based interval tuning
            let total = slot_count.max(1) as f64;
            let metabolism = busy_count as f64 / total;
            let min_i = self.config.min_interval_secs as f64;
            let max_i = self.config.max_interval_secs as f64;
            let target = min_i + (max_i - min_i) * metabolism;
            st.interval_secs = st.interval_secs * 0.7 + target * 0.3;
            st.interval_secs = st.interval_secs.max(min_i).min(max_i);
            st.heartbeat_count = self.cycle_count;

            st.interval_secs
            // write lock dropped here
        };

        // Persist state to file (off executor)
        self.save_state().await;

        let elapsed = t0.elapsed();

        HeartbeatResult {
            cycle: self.cycle_count,
            timestamp: Utc::now(),
            phase: "adapt".to_string(),
            slots_polled: slot_count,
            idle_slots: idle_count,
            tasks_dispatched: dispatched,
            invariant_violations: violations,
            interval_secs: interval,
            autopilot_injected: ap_injected,
            elapsed_ms: elapsed.as_millis() as u64,
        }
    }

    /// Invariant 2: Bounded divergence.
    /// Returns true if injection is allowed (under the limit).
    async fn check_bounded_divergence(&self) -> bool {
        let st = self.state.read().await;
        let now = Utc::now().timestamp() as f64;
        let cutoff = now - (self.config.interval_secs as f64 * 5.0);
        let recent = st
            .injection_window
            .iter()
            .filter(|&&ts| ts > cutoff)
            .count();
        recent < self.config.max_injections_per_window
    }

    /// Persist orchestrator state to JSON file.
    /// Serializes under read lock, then drops lock before filesystem I/O (off executor).
    async fn save_state(&self) {
        let json = {
            let st = self.state.read().await;
            match serde_json::to_string_pretty(&*st) {
                Ok(j) => j,
                Err(e) => {
                    debug!(err = %e, "state serialization failed");
                    return;
                }
            }
            // read lock dropped here
        };
        let path = self.config.state_path();
        let _ = tokio::task::spawn_blocking(move || {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).ok();
            }
            let tmp = path.with_extension("tmp");
            if std::fs::write(&tmp, &json).is_ok() {
                std::fs::rename(&tmp, &path).ok();
            }
        })
        .await;
    }
}
