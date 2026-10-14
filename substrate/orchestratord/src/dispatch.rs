//! meshd dispatch — inject prompts into agent slots across the mesh.
//!
//! Reuses the proven pattern from evolution-world-rs/src/dispatch.rs:
//! - Try slots in preference order (claude-max first)
//! - Rate-limit aware: skip recently-errored slots
//! - All injection goes through meshd HTTP /inject endpoint (no AppleScript)

use anyhow::{Context, Result};
use reqwest::Client;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;
use tracing::{debug, info, warn};

use crate::config::Config;
use crate::state::{InjectResponse, MeshdStatusResponse, SlotState};

/// Slot tiers by task complexity (from "Complexity of Reasoning Traces" paper).
/// FIXME: these keywords are compiled-in. New skills (e.g., /meta:amr, /vid:cinematic)
/// must be added here manually. Future: move to [complexity_keywords] TOML section.
/// Simple tasks → cheap slots (fewer wasted reasoning tokens).
/// Complex tasks → premium slots (fewer total tokens, better accuracy).
const TIER_SIMPLE: &[&str] = &["codex", "opencode", "gemini"];
const TIER_MEDIUM: &[&str] = &["claude-pro1", "claude-pro2", "codex", "gemini", "opencode"];
const TIER_COMPLEX: &[&str] = &["claude-max", "claude-pro1", "claude-pro2"];
const TIER_CREATIVE: &[&str] = &["gemini", "claude-max", "claude-pro1"];

/// Default fallback order (legacy).
const SLOT_PREFERENCE: &[&str] = &[
    "claude-max",
    "claude-pro1",
    "claude-pro2",
    "codex",
    "gemini",
    "opencode",
];

/// Classify task complexity from prompt text.
fn classify_complexity(prompt: &str) -> &'static str {
    let p = prompt.to_lowercase();
    // Simple: health checks, git ops, file reads, status checks
    if p.contains("health") || p.contains("status") || p.contains("curl ")
        || p.contains("git status") || p.contains("git log") || p.contains("ls ")
        || p.contains("cat ") || p.contains("echo ") || p.contains("rtk gain")
        || p.len() < 100
    {
        return "simple";
    }
    // Creative: concepts, names, design, content
    if p.contains("creative") || p.contains("design") || p.contains("concept")
        || p.contains("name") || p.contains("brand") || p.contains("copy")
        || p.contains("evo-cubed") || p.contains("creative:forge")
    {
        return "creative";
    }
    // Complex: architecture, refactor, multi-file, rewrite, debug
    if p.contains("architect") || p.contains("refactor") || p.contains("rewrite")
        || p.contains("debug") || p.contains("investigate") || p.contains("multi-file")
        || p.contains("divergent-rail") || p.contains("meta:omega")
        || p.len() > 1000
    {
        return "complex";
    }
    // Default: medium
    "medium"
}

/// Get slot preference order based on task complexity.
fn slot_order_for(complexity: &str) -> &'static [&'static str] {
    match complexity {
        "simple" => TIER_SIMPLE,
        "creative" => TIER_CREATIVE,
        "complex" => TIER_COMPLEX,
        "medium" => TIER_MEDIUM,
        other => {
            tracing::warn!(complexity = other, "unknown complexity tier, falling back to default");
            SLOT_PREFERENCE
        }
    }
}

/// How long to skip a slot after an error (seconds).
const ERROR_COOLDOWN_SECS: u64 = 120;

pub struct Dispatcher {
    client: Client,
    config: Config,
    /// Track recent errors per "machine:slot" key -> last error time.
    error_cache: Mutex<HashMap<String, Instant>>,
}

impl Dispatcher {
    pub fn new(config: Config) -> Self {
        Self {
            client: Client::builder()
                .timeout(std::time::Duration::from_secs(15))
                .build()
                .expect("failed to build reqwest client"),
            config,
            error_cache: Mutex::new(HashMap::new()),
        }
    }

    /// Poll meshd /status on a single machine. Returns slot states.
    pub async fn poll_status(&self, machine: &str) -> Result<Vec<SlotState>> {
        let ip = self
            .config
            .node_ip(machine)
            .ok_or_else(|| anyhow::anyhow!("unknown machine: {}", machine))?;
        let url = format!("http://{}:{}/status", ip, self.config.meshd_port);

        let resp = self
            .client
            .get(&url)
            .header(
                "Authorization",
                format!("Bearer {}", self.config.meshd_token),
            )
            .send()
            .await
            .with_context(|| format!("GET meshd status on {}", machine))?;

        if !resp.status().is_success() {
            return Ok(Vec::new());
        }

        let status: MeshdStatusResponse = resp
            .json()
            .await
            .unwrap_or(MeshdStatusResponse {
                machine_id: machine.to_string(),
                slots: vec![],
            });

        // Tag each slot with the machine name
        let mut slots = status.slots;
        for s in &mut slots {
            s.machine = machine.to_string();
        }
        Ok(slots)
    }

    /// Poll all mesh nodes in parallel and return combined slot states.
    pub async fn poll_all_nodes(&self) -> Vec<SlotState> {
        let machines: Vec<String> = self.config.mesh_nodes.keys().cloned().collect();
        let futs: Vec<_> = machines.iter().map(|m| self.poll_status(m)).collect();
        let results = futures::future::join_all(futs).await;

        let mut all_slots = Vec::new();
        for (result, machine) in results.into_iter().zip(machines.iter()) {
            match result {
                Ok(slots) => {
                    debug!(machine = %machine, count = slots.len(), "polled meshd");
                    all_slots.extend(slots);
                }
                Err(e) => {
                    debug!(machine = %machine, err = %e, "meshd poll failed");
                }
            }
        }
        all_slots
    }

    /// Dispatch a prompt to a specific slot on a specific machine.
    pub async fn dispatch_to_slot(
        &self,
        machine: &str,
        slot: &str,
        prompt: &str,
    ) -> Result<u64> {
        let ip = self
            .config
            .node_ip(machine)
            .ok_or_else(|| anyhow::anyhow!("unknown machine: {}", machine))?;
        let url = format!("http://{}:{}/inject/{}", ip, self.config.meshd_port, slot);

        let resp = self
            .client
            .post(&url)
            .header(
                "Authorization",
                format!("Bearer {}", self.config.meshd_token),
            )
            .json(&serde_json::json!({"prompt": prompt}))
            .send()
            .await
            .with_context(|| format!("POST meshd {}:{}/{}", machine, self.config.meshd_port, slot))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            self.record_error(machine, slot);
            anyhow::bail!(
                "meshd inject failed {}:{} HTTP {}: {}",
                machine,
                slot,
                status,
                body
            );
        }

        let inject_resp: InjectResponse =
            resp.json().await.context("parse inject response")?;

        if inject_resp.status != "ok" {
            if let Some(err) = inject_resp.error {
                self.record_error(machine, slot);
                anyhow::bail!("meshd inject error {}:{}: {}", machine, slot, err);
            }
        }

        let bytes = inject_resp.bytes_written.unwrap_or(0);
        info!(
            machine = %machine,
            slot = %slot,
            bytes = bytes,
            "injected to meshd"
        );
        Ok(bytes)
    }

    /// Find the best available slot across all machines and dispatch.
    /// Dispatch to the best slot based on task complexity classification.
    /// Simple tasks → cheap slots. Complex tasks → premium slots.
    pub async fn dispatch_best(
        &self,
        prompt: &str,
        all_slots: &[SlotState],
    ) -> Result<(String, String, u64)> {
        let complexity = classify_complexity(prompt);
        let order = slot_order_for(complexity);
        info!(complexity = complexity, "task classified");

        // Build a map of machine -> idle slot names
        let mut machine_idle: HashMap<String, Vec<String>> = HashMap::new();
        for s in all_slots {
            if s.state == "idle" || s.state == "ready" || s.state == "unborn" {
                machine_idle
                    .entry(s.machine.clone())
                    .or_default()
                    .push(s.name.clone());
            }
        }

        // Try in complexity-appropriate slot order across all machines
        for preferred in order {
            for (machine, idle_slots) in &machine_idle {
                if !idle_slots.iter().any(|n| n == preferred) {
                    continue;
                }
                if self.is_cooling_down(machine, preferred) {
                    debug!(
                        machine = %machine,
                        slot = %preferred,
                        "skipping (error cooldown)"
                    );
                    continue;
                }
                match self.dispatch_to_slot(machine, preferred, prompt).await {
                    Ok(bytes) => {
                        return Ok((machine.clone(), preferred.to_string(), bytes));
                    }
                    Err(e) => {
                        warn!(
                            machine = %machine,
                            slot = %preferred,
                            err = %e,
                            "dispatch failed, trying next"
                        );
                    }
                }
            }
        }

        anyhow::bail!("no available meshd slot across all machines")
    }

    /// Record an error for a machine:slot pair.
    fn record_error(&self, machine: &str, slot: &str) {
        let key = format!("{}:{}", machine, slot);
        if let Ok(mut cache) = self.error_cache.lock() {
            cache.insert(key, Instant::now());
        }
    }

    /// Check if a machine:slot is in error cooldown.
    /// Fail-safe: if mutex is poisoned, treat all slots as cooling down (don't dispatch).
    fn is_cooling_down(&self, machine: &str, slot: &str) -> bool {
        let key = format!("{}:{}", machine, slot);
        match self.error_cache.lock() {
            Ok(cache) => cache
                .get(&key)
                .map_or(false, |t| t.elapsed().as_secs() < ERROR_COOLDOWN_SECS),
            Err(_) => {
                warn!("error_cache mutex poisoned — treating all slots as cooling down");
                true // fail-safe
            }
        }
    }
}
