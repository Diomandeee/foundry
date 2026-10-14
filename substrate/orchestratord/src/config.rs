//! Configuration for orchestratord.
//!
//! Loaded from ~/.orchestratord/orchestratord.toml (or CLI override).
//! Mirrors the Python controller's constants but makes them configurable.

use anyhow::{Context, Result};
use serde::Deserialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Top-level config.
#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code)]
pub struct Config {
    #[serde(default = "default_api_port")]
    pub api_port: u16,

    #[serde(default = "default_interval")]
    pub interval_secs: u64,

    #[serde(default = "default_token")]
    pub meshd_token: String,

    #[serde(default = "default_meshd_port")]
    pub meshd_port: u16,

    #[serde(default = "default_max_injections")]
    pub max_injections_per_window: usize,

    #[serde(default = "default_cooldown")]
    pub cooldown_secs: u64,

    #[serde(default = "default_idle_escalation")]
    pub idle_cycles_before_escalation: u64,

    #[serde(default = "default_min_interval")]
    pub min_interval_secs: u64,

    #[serde(default = "default_max_interval")]
    pub max_interval_secs: u64,

    #[serde(default = "default_autopilot_file")]
    pub autopilot_file: String,

    #[serde(default = "default_backlog_file")]
    pub backlog_file: String,

    #[serde(default = "default_state_file")]
    pub state_file: String,

    #[serde(default = "default_mesh_nodes")]
    pub mesh_nodes: HashMap<String, String>,
}

fn default_api_port() -> u16 {
    9470
}
fn default_interval() -> u64 {
    60
}
fn default_token() -> String {
    "claw-glasses-2026".to_string()
}
fn default_meshd_port() -> u16 {
    9451
}
fn default_max_injections() -> usize {
    2
}
fn default_cooldown() -> u64 {
    600
}
fn default_idle_escalation() -> u64 {
    15
}
fn default_min_interval() -> u64 {
    30
}
fn default_max_interval() -> u64 {
    300
}

fn default_autopilot_file() -> String {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    format!("{}/.claude/state/autopilot.json", home)
}

fn default_backlog_file() -> String {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    format!("{}/.claude/orchestrator/backlog.json", home)
}

fn default_state_file() -> String {
    "/tmp/orchestratord_state.json".to_string()
}

fn default_mesh_nodes() -> HashMap<String, String> {
    let mut m = HashMap::new();
    m.insert("mac1".into(), "100.84.118.106".into());
    m.insert("mac2".into(), "100.119.214.88".into());
    m.insert("mac4".into(), "100.91.231.93".into());
    m.insert("mac5".into(), "100.109.94.124".into());
    m.insert("cloud-vm".into(), "100.114.92.88".into());
    m
}

impl Config {
    /// Default config path: ~/.orchestratord/orchestratord.toml
    pub fn default_path() -> PathBuf {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
        PathBuf::from(home).join(".orchestratord").join("orchestratord.toml")
    }

    /// Load config from file, falling back to defaults if missing.
    pub fn load(path: &Path) -> Result<Self> {
        if path.exists() {
            let content = std::fs::read_to_string(path)
                .with_context(|| format!("reading config from {}", path.display()))?;
            let config: Config = toml::from_str(&content)
                .with_context(|| format!("parsing config from {}", path.display()))?;
            Ok(config)
        } else {
            tracing::info!(
                path = %path.display(),
                "config file not found, using defaults"
            );
            Ok(Self::default())
        }
    }

    /// Resolve autopilot file path.
    pub fn autopilot_path(&self) -> PathBuf {
        PathBuf::from(&self.autopilot_file)
    }

    /// Resolve backlog file path.
    pub fn backlog_path(&self) -> PathBuf {
        PathBuf::from(&self.backlog_file)
    }

    /// Resolve state file path.
    pub fn state_path(&self) -> PathBuf {
        PathBuf::from(&self.state_file)
    }

    /// Look up a mesh node IP by machine id.
    pub fn node_ip(&self, machine: &str) -> Option<&str> {
        self.mesh_nodes.get(machine).map(|s| s.as_str())
    }
}

impl Default for Config {
    fn default() -> Self {
        Self {
            api_port: default_api_port(),
            interval_secs: default_interval(),
            meshd_token: default_token(),
            meshd_port: default_meshd_port(),
            max_injections_per_window: default_max_injections(),
            cooldown_secs: default_cooldown(),
            idle_cycles_before_escalation: default_idle_escalation(),
            min_interval_secs: default_min_interval(),
            max_interval_secs: default_max_interval(),
            autopilot_file: default_autopilot_file(),
            backlog_file: default_backlog_file(),
            state_file: default_state_file(),
            mesh_nodes: default_mesh_nodes(),
        }
    }
}
