//! Ledger entry type.

use crate::types::{ArtifactRef, Layer, SnapshotId};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// An entry in the append-only ledger.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LedgerEntry {
    /// Monotonically increasing sequence number.
    pub seq: u64,

    /// Call ID.
    pub call_id: Uuid,

    /// Tool that was executed.
    pub tool_id: String,

    /// Layer of the tool.
    pub layer: Layer,

    /// Hash of the arguments.
    pub args_hash: [u8; 32],

    /// Scope ID used.
    pub scope_id: Uuid,

    /// Project ID.
    pub project_id: Uuid,

    /// Input snapshot.
    pub input_snapshot: SnapshotId,

    /// Output snapshot (after execution).
    pub output_snapshot: SnapshotId,

    /// Output artifacts.
    pub artifacts: Vec<ArtifactRef>,

    /// Cost consumed.
    pub cost_consumed: u64,

    /// When accepted.
    pub accepted_at: DateTime<Utc>,

    /// When completed.
    pub completed_at: DateTime<Utc>,

    /// Rollback data (if reversible).
    pub rollback_data: Option<Vec<u8>>,

    /// Entry hash (for integrity).
    pub entry_hash: [u8; 32],

    /// Hash of previous entry (chain integrity).
    pub prev_hash: [u8; 32],
}

impl LedgerEntry {
    /// Get the duration of the call.
    pub fn duration(&self) -> chrono::Duration {
        self.completed_at - self.accepted_at
    }

    /// Check if this entry has rollback data.
    pub fn is_reversible(&self) -> bool {
        self.rollback_data.is_some()
    }

    /// Verify the entry hash.
    pub fn verify_hash(&self) -> bool {
        let mut entry_for_hash = self.clone();
        entry_for_hash.entry_hash = [0; 32];
        
        let bytes = match serde_json::to_vec(&entry_for_hash) {
            Ok(b) => b,
            Err(_) => return false,
        };
        
        let computed: [u8; 32] = blake3::hash(&bytes).into();
        computed == self.entry_hash
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_entry_duration() {
        let start = Utc::now();
        let end = start + chrono::Duration::seconds(5);
        
        let entry = LedgerEntry {
            seq: 1,
            call_id: Uuid::new_v4(),
            tool_id: "test".into(),
            layer: Layer::OBSERVE,
            args_hash: [0; 32],
            scope_id: Uuid::new_v4(),
            project_id: Uuid::new_v4(),
            input_snapshot: SnapshotId::zero(),
            output_snapshot: SnapshotId::zero(),
            artifacts: vec![],
            cost_consumed: 10,
            accepted_at: start,
            completed_at: end,
            rollback_data: None,
            entry_hash: [0; 32],
            prev_hash: [0; 32],
        };

        assert_eq!(entry.duration().num_seconds(), 5);
        assert!(!entry.is_reversible());
    }
}

