//! Scope token for capability management.

use super::{Layer, LayerRange};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use uuid::Uuid;

/// A capability token that grants permission to call tools.
///
/// Scope tokens are short-lived and context-specific. They bind a session
/// to a set of allowed tools and layers.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ScopeToken {
    /// Unique identifier for this scope.
    pub scope_id: Uuid,

    /// The project this scope applies to.
    pub project_id: Uuid,

    /// Optional session binding.
    pub session_id: Option<Uuid>,

    /// Tools that may be called under this scope.
    /// Empty means all tools within layer range are allowed.
    pub allowed_tools: Vec<String>,

    /// Layer range this scope permits.
    pub allowed_layers: LayerRange,

    /// Whether mutation operations are permitted.
    pub can_mutate: bool,

    /// Allowed filesystem roots (empty = all permitted paths).
    pub allowed_roots: Vec<PathBuf>,

    /// When this scope was issued.
    pub issued_at: DateTime<Utc>,

    /// When this scope expires.
    pub expires_at: DateTime<Utc>,

    /// Cryptographic signature (optional, for remote validation).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<Vec<u8>>,
}

impl ScopeToken {
    /// Create a new scope token with default 1-hour expiry.
    pub fn new(project_id: Uuid, session_id: Option<Uuid>) -> Self {
        let now = Utc::now();
        Self {
            scope_id: Uuid::new_v4(),
            project_id,
            session_id,
            allowed_tools: Vec::new(),
            allowed_layers: LayerRange::standard(),
            can_mutate: false,
            allowed_roots: Vec::new(),
            issued_at: now,
            expires_at: now + Duration::hours(1),
            signature: None,
        }
    }

    /// Create a read-only scope token.
    pub fn read_only(project_id: Uuid) -> Self {
        Self {
            allowed_layers: LayerRange::read_only(),
            can_mutate: false,
            ..Self::new(project_id, None)
        }
    }

    /// Check if this scope is currently valid.
    pub fn is_valid(&self, now: DateTime<Utc>) -> bool {
        now >= self.issued_at && now < self.expires_at
    }

    /// Check if this scope has expired.
    pub fn is_expired(&self) -> bool {
        Utc::now() >= self.expires_at
    }

    /// Check if a tool is allowed under this scope.
    pub fn allows_tool(&self, tool_id: &str) -> bool {
        self.allowed_tools.is_empty() || self.allowed_tools.iter().any(|t| t == tool_id)
    }

    /// Check if a layer is allowed under this scope.
    pub fn allows_layer(&self, layer: Layer) -> bool {
        self.allowed_layers.contains(layer)
    }

    /// Check if a path is within allowed roots.
    pub fn allows_path(&self, path: &Path) -> bool {
        if self.allowed_roots.is_empty() {
            return true;
        }
        self.allowed_roots.iter().any(|root| path.starts_with(root))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_scope_validity() {
        let scope = ScopeToken::new(Uuid::new_v4(), None);
        assert!(scope.is_valid(Utc::now()));
        assert!(!scope.is_expired());
    }

    #[test]
    fn test_scope_tool_filtering() {
        let mut scope = ScopeToken::new(Uuid::new_v4(), None);
        scope.allowed_tools = vec!["fs.scan".into(), "fs.hash".into()];

        assert!(scope.allows_tool("fs.scan"));
        assert!(!scope.allows_tool("apply.patch"));
    }
}

