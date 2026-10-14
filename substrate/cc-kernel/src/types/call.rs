//! Tool call and receipt types.

use super::{ScopeToken, SnapshotId};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// A tool call proposed by FunctionGemma.
///
/// This is the unit of work submitted to the Kernel for execution.
/// The Kernel will validate admissibility before executing.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProposedCall {
    /// Unique identifier for this call.
    pub call_id: Uuid,

    /// The tool to execute.
    pub tool_id: String,

    /// Arguments as JSON.
    pub args: serde_json::Value,

    /// The scope token authorizing this call.
    pub scope: ScopeToken,

    /// Snapshot of world state when this call was proposed.
    pub snapshot: SnapshotId,

    /// When this call was proposed.
    pub proposed_at: DateTime<Utc>,

    /// Optional reference to a proposal artifact (for Apply layer).
    pub proposal_ref: Option<ProposalRef>,
}

impl ProposedCall {
    /// Create a new proposed call.
    pub fn new(tool_id: impl Into<String>, args: serde_json::Value, scope: ScopeToken) -> Self {
        Self {
            call_id: Uuid::new_v4(),
            tool_id: tool_id.into(),
            args,
            scope,
            snapshot: SnapshotId::zero(),
            proposed_at: Utc::now(),
            proposal_ref: None,
        }
    }

    /// Set the snapshot (builder pattern).
    pub fn with_snapshot(mut self, snapshot: SnapshotId) -> Self {
        self.snapshot = snapshot;
        self
    }

    /// Set the proposal reference (builder pattern).
    pub fn with_proposal_ref(mut self, proposal_ref: ProposalRef) -> Self {
        self.proposal_ref = Some(proposal_ref);
        self
    }
}

/// Reference to a previously created proposal artifact.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProposalRef {
    /// Hash of the proposal artifact.
    pub proposal_hash: [u8; 32],

    /// Snapshot when the proposal was created.
    pub proposal_snapshot: SnapshotId,

    /// Ledger sequence number of the proposal.
    pub proposal_seq: u64,
}

impl ProposalRef {
    /// Create a new proposal reference.
    pub fn new(hash: [u8; 32], snapshot: SnapshotId, seq: u64) -> Self {
        Self {
            proposal_hash: hash,
            proposal_snapshot: snapshot,
            proposal_seq: seq,
        }
    }
}

/// Receipt returned after successful tool execution.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ToolReceipt {
    /// The call ID that was executed.
    pub call_id: Uuid,

    /// When the call was accepted by the Kernel.
    pub accepted_at: DateTime<Utc>,

    /// When execution completed.
    pub completed_at: DateTime<Utc>,

    /// Ledger sequence number.
    pub ledger_seq: u64,

    /// Output from the tool.
    pub output: ToolOutput,

    /// Actual cost consumed.
    pub cost_consumed: u64,

    /// New snapshot ID after execution.
    pub new_snapshot: SnapshotId,
}

/// Output from a tool execution.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ToolOutput {
    /// JSON result data.
    pub result: serde_json::Value,

    /// Any artifacts produced.
    pub artifacts: Vec<ArtifactRef>,

    /// Human-readable summary.
    pub summary: Option<String>,
}

impl ToolOutput {
    /// Create a simple output with just a result.
    pub fn simple(result: serde_json::Value) -> Self {
        Self {
            result,
            artifacts: Vec::new(),
            summary: None,
        }
    }

    /// Create an output with a summary.
    pub fn with_summary(result: serde_json::Value, summary: impl Into<String>) -> Self {
        Self {
            result,
            artifacts: Vec::new(),
            summary: Some(summary.into()),
        }
    }
}

impl Default for ToolOutput {
    fn default() -> Self {
        Self {
            result: serde_json::Value::Null,
            artifacts: Vec::new(),
            summary: None,
        }
    }
}

/// Reference to an artifact produced by a tool.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ArtifactRef {
    /// Artifact type (e.g., "patch", "move_plan", "index").
    pub kind: String,

    /// Content hash.
    pub hash: [u8; 32],

    /// Storage URI.
    pub uri: String,
}

impl ArtifactRef {
    /// Create a new artifact reference.
    pub fn new(kind: impl Into<String>, hash: [u8; 32], uri: impl Into<String>) -> Self {
        Self {
            kind: kind.into(),
            hash,
            uri: uri.into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::LayerRange;

    #[test]
    fn test_proposed_call_creation() {
        let scope = ScopeToken::new(Uuid::new_v4(), None);
        let call = ProposedCall::new("fs.scan", serde_json::json!({"path": "/tmp"}), scope);

        assert_eq!(call.tool_id, "fs.scan");
        assert!(call.proposal_ref.is_none());
    }

    #[test]
    fn test_tool_output() {
        let output = ToolOutput::with_summary(serde_json::json!({"count": 42}), "Scanned 42 files");

        assert!(output.summary.is_some());
        assert!(output.artifacts.is_empty());
    }
}

