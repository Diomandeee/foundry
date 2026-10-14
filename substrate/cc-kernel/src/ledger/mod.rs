//! Append-only ledger for committed syscalls.

mod entry;
mod storage;

pub use entry::LedgerEntry;
pub use storage::LedgerStorage;

use crate::syscalls::Syscall;
use crate::types::{ArtifactRef, Layer, ProposedCall, SnapshotId, ToolOutput};
use chrono::{DateTime, Utc};
use parking_lot::RwLock;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use anyhow::Result;

/// Append-only ledger for committed syscalls.
pub struct Ledger {
    /// Storage backend.
    storage: Box<dyn LedgerStorage>,

    /// Current sequence number.
    current_seq: AtomicU64,

    /// Hash of most recent entry.
    last_hash: RwLock<[u8; 32]>,

    /// Proposal index (hash -> seq).
    proposal_index: RwLock<HashMap<[u8; 32], u64>>,
}

impl Ledger {
    /// Create a new ledger with the given storage backend.
    pub fn new(storage: Box<dyn LedgerStorage>) -> Self {
        Self {
            storage,
            current_seq: AtomicU64::new(0),
            last_hash: RwLock::new([0u8; 32]),
            proposal_index: RwLock::new(HashMap::new()),
        }
    }

    /// Create an in-memory ledger (for testing).
    pub fn in_memory() -> Self {
        Self::new(Box::new(storage::InMemoryLedgerStorage::new()))
    }

    /// Initialize the ledger from storage.
    pub async fn initialize(&self) -> Result<()> {
        let last_seq = self.storage.last_seq().await?;
        self.current_seq.store(last_seq, Ordering::SeqCst);

        // Load proposal index
        if last_seq > 0 {
            let entries = self.storage.range(1, last_seq).await?;
            let mut index = self.proposal_index.write();
            for entry in entries {
                for artifact in &entry.artifacts {
                    if artifact.kind == "proposal" {
                        index.insert(artifact.hash, entry.seq);
                    }
                }
            }
        }

        Ok(())
    }

    /// Append a new entry to the ledger.
    pub async fn append(
        &self,
        call: &ProposedCall,
        syscall: &dyn Syscall,
        output: &ToolOutput,
        input_snapshot: &SnapshotId,
        output_snapshot: &SnapshotId,
        cost: u64,
        accepted_at: DateTime<Utc>,
        completed_at: DateTime<Utc>,
    ) -> Result<u64> {
        let seq = self.current_seq.fetch_add(1, Ordering::SeqCst) + 1;
        let prev_hash = *self.last_hash.read();

        let args_hash = blake3::hash(&serde_json::to_vec(&call.args)?).into();

        let rollback_data = syscall.rollback_data(&call.args, output);

        let mut entry = LedgerEntry {
            seq,
            call_id: call.call_id,
            tool_id: call.tool_id.clone(),
            layer: syscall.layer(),
            args_hash,
            scope_id: call.scope.scope_id,
            project_id: call.scope.project_id,
            input_snapshot: input_snapshot.clone(),
            output_snapshot: output_snapshot.clone(),
            artifacts: output.artifacts.clone(),
            cost_consumed: cost,
            accepted_at,
            completed_at,
            rollback_data,
            entry_hash: [0; 32], // Computed below
            prev_hash,
        };

        // Compute entry hash
        let entry_bytes = serde_json::to_vec(&entry)?;
        entry.entry_hash = blake3::hash(&entry_bytes).into();

        // Update last hash
        *self.last_hash.write() = entry.entry_hash;

        // Index proposals
        for artifact in &output.artifacts {
            if artifact.kind == "proposal" {
                self.proposal_index.write().insert(artifact.hash, seq);
            }
        }

        // Persist
        self.storage.append(&entry).await?;

        Ok(seq)
    }

    /// Check if a proposal exists.
    pub fn has_proposal(&self, hash: &[u8; 32]) -> bool {
        self.proposal_index.read().contains_key(hash)
    }

    /// Get the sequence number for a proposal.
    pub fn get_proposal_seq(&self, hash: &[u8; 32]) -> Option<u64> {
        self.proposal_index.read().get(hash).copied()
    }

    /// Get entry by sequence number.
    pub async fn get(&self, seq: u64) -> Result<Option<LedgerEntry>> {
        self.storage.get(seq).await
    }

    /// Get entries in range.
    pub async fn range(&self, start: u64, end: u64) -> Result<Vec<LedgerEntry>> {
        self.storage.range(start, end).await
    }

    /// Get the current sequence number.
    pub fn current_seq(&self) -> u64 {
        self.current_seq.load(Ordering::SeqCst)
    }

    /// Get the last hash.
    pub fn last_hash(&self) -> [u8; 32] {
        *self.last_hash.read()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{CostModel, Mutability, ScopeToken};
    use uuid::Uuid;

    struct MockSyscall;

    #[async_trait::async_trait]
    impl Syscall for MockSyscall {
        fn id(&self) -> &'static str {
            "mock.test"
        }
        fn layer(&self) -> Layer {
            Layer::OBSERVE
        }
        fn mutability(&self) -> Mutability {
            Mutability::ReadOnly
        }
        fn cost(&self) -> CostModel {
            CostModel::cheap()
        }
        fn validate_args(&self, _: &serde_json::Value) -> Result<()> {
            Ok(())
        }
        async fn execute(
            &self,
            _: serde_json::Value,
            _: crate::syscalls::SyscallContext<'_>,
        ) -> anyhow::Result<ToolOutput> {
            Ok(ToolOutput::default())
        }
    }

    #[tokio::test]
    async fn test_ledger_append() {
        let ledger = Ledger::in_memory();
        let scope = ScopeToken::new(Uuid::new_v4(), None);
        let call = ProposedCall::new("mock.test", serde_json::json!({}), scope);
        let output = ToolOutput::default();
        let input = SnapshotId::zero();
        let output_snap = SnapshotId::zero();
        let now = Utc::now();

        let seq = ledger
            .append(&call, &MockSyscall, &output, &input, &output_snap, 10, now, now)
            .await
            .unwrap();

        assert_eq!(seq, 1);
        assert_eq!(ledger.current_seq(), 1);
    }

    #[tokio::test]
    async fn test_ledger_proposal_index() {
        let ledger = Ledger::in_memory();
        let scope = ScopeToken::new(Uuid::new_v4(), None);
        let call = ProposedCall::new("mock.test", serde_json::json!({}), scope);
        let proposal_hash = [1u8; 32];
        let output = ToolOutput {
            result: serde_json::Value::Null,
            artifacts: vec![ArtifactRef::new("proposal", proposal_hash, "uri://test")],
            summary: None,
        };
        let input = SnapshotId::zero();
        let output_snap = SnapshotId::zero();
        let now = Utc::now();

        ledger
            .append(&call, &MockSyscall, &output, &input, &output_snap, 10, now, now)
            .await
            .unwrap();

        assert!(ledger.has_proposal(&proposal_hash));
        assert_eq!(ledger.get_proposal_seq(&proposal_hash), Some(1));
    }
}

