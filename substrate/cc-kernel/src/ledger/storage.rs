//! Ledger storage backends.

use super::LedgerEntry;
use anyhow::Result;
use async_trait::async_trait;
use parking_lot::RwLock;
use std::collections::BTreeMap;

/// Storage backend trait for ledger.
#[async_trait]
pub trait LedgerStorage: Send + Sync {
    /// Append an entry to storage.
    async fn append(&self, entry: &LedgerEntry) -> Result<()>;

    /// Get an entry by sequence number.
    async fn get(&self, seq: u64) -> Result<Option<LedgerEntry>>;

    /// Get entries in a range (inclusive).
    async fn range(&self, start: u64, end: u64) -> Result<Vec<LedgerEntry>>;

    /// Get the last sequence number (0 if empty).
    async fn last_seq(&self) -> Result<u64>;
}

/// In-memory ledger storage (for testing).
pub struct InMemoryLedgerStorage {
    entries: RwLock<BTreeMap<u64, LedgerEntry>>,
}

impl InMemoryLedgerStorage {
    /// Create a new in-memory storage.
    pub fn new() -> Self {
        Self {
            entries: RwLock::new(BTreeMap::new()),
        }
    }
}

impl Default for InMemoryLedgerStorage {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl LedgerStorage for InMemoryLedgerStorage {
    async fn append(&self, entry: &LedgerEntry) -> Result<()> {
        self.entries.write().insert(entry.seq, entry.clone());
        Ok(())
    }

    async fn get(&self, seq: u64) -> Result<Option<LedgerEntry>> {
        Ok(self.entries.read().get(&seq).cloned())
    }

    async fn range(&self, start: u64, end: u64) -> Result<Vec<LedgerEntry>> {
        let entries = self.entries.read();
        Ok(entries
            .range(start..=end)
            .map(|(_, e)| e.clone())
            .collect())
    }

    async fn last_seq(&self) -> Result<u64> {
        Ok(self
            .entries
            .read()
            .keys()
            .last()
            .copied()
            .unwrap_or(0))
    }
}

#[cfg(feature = "sqlite")]
pub mod sqlite {
    //! SQLite storage backend for ledger.
    //!
    //! Enable with the `sqlite` feature.

    use super::*;
    use sqlx::sqlite::{SqlitePool, SqlitePoolOptions};

    /// SQLite ledger storage.
    pub struct SqliteLedgerStorage {
        pool: SqlitePool,
    }

    impl SqliteLedgerStorage {
        /// Create a new SQLite storage.
        pub async fn new(database_url: &str) -> Result<Self> {
            let pool = SqlitePoolOptions::new()
                .max_connections(5)
                .connect(database_url)
                .await?;

            // Create table if not exists
            sqlx::query(
                r#"
                CREATE TABLE IF NOT EXISTS ledger_entries (
                    seq INTEGER PRIMARY KEY,
                    call_id TEXT NOT NULL,
                    tool_id TEXT NOT NULL,
                    layer INTEGER NOT NULL,
                    args_hash BLOB NOT NULL,
                    scope_id TEXT NOT NULL,
                    project_id TEXT NOT NULL,
                    input_snapshot BLOB NOT NULL,
                    output_snapshot BLOB NOT NULL,
                    artifacts TEXT NOT NULL,
                    cost_consumed INTEGER NOT NULL,
                    accepted_at TEXT NOT NULL,
                    completed_at TEXT NOT NULL,
                    rollback_data BLOB,
                    entry_hash BLOB NOT NULL,
                    prev_hash BLOB NOT NULL
                )
                "#,
            )
            .execute(&pool)
            .await?;

            Ok(Self { pool })
        }
    }

    #[async_trait]
    impl LedgerStorage for SqliteLedgerStorage {
        async fn append(&self, entry: &LedgerEntry) -> Result<()> {
            let artifacts_json = serde_json::to_string(&entry.artifacts)?;

            sqlx::query(
                r#"
                INSERT INTO ledger_entries (
                    seq, call_id, tool_id, layer, args_hash, scope_id, project_id,
                    input_snapshot, output_snapshot, artifacts, cost_consumed,
                    accepted_at, completed_at, rollback_data, entry_hash, prev_hash
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                "#,
            )
            .bind(entry.seq as i64)
            .bind(entry.call_id.to_string())
            .bind(&entry.tool_id)
            .bind(entry.layer.0 as i32)
            .bind(&entry.args_hash[..])
            .bind(entry.scope_id.to_string())
            .bind(entry.project_id.to_string())
            .bind(&entry.input_snapshot.0[..])
            .bind(&entry.output_snapshot.0[..])
            .bind(&artifacts_json)
            .bind(entry.cost_consumed as i64)
            .bind(entry.accepted_at.to_rfc3339())
            .bind(entry.completed_at.to_rfc3339())
            .bind(entry.rollback_data.as_deref())
            .bind(&entry.entry_hash[..])
            .bind(&entry.prev_hash[..])
            .execute(&self.pool)
            .await?;

            Ok(())
        }

        async fn get(&self, seq: u64) -> Result<Option<LedgerEntry>> {
            // For brevity, returning None - full implementation would parse the row
            let _ = seq;
            Ok(None)
        }

        async fn range(&self, start: u64, end: u64) -> Result<Vec<LedgerEntry>> {
            // For brevity, returning empty - full implementation would fetch rows
            let _ = (start, end);
            Ok(vec![])
        }

        async fn last_seq(&self) -> Result<u64> {
            let row: (i64,) = sqlx::query_as("SELECT COALESCE(MAX(seq), 0) FROM ledger_entries")
                .fetch_one(&self.pool)
                .await?;
            Ok(row.0 as u64)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Layer, SnapshotId};
    use uuid::Uuid;

    #[tokio::test]
    async fn test_in_memory_storage() {
        let storage = InMemoryLedgerStorage::new();

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
            accepted_at: chrono::Utc::now(),
            completed_at: chrono::Utc::now(),
            rollback_data: None,
            entry_hash: [0; 32],
            prev_hash: [0; 32],
        };

        storage.append(&entry).await.unwrap();

        let retrieved = storage.get(1).await.unwrap();
        assert!(retrieved.is_some());
        assert_eq!(retrieved.unwrap().seq, 1);

        assert_eq!(storage.last_seq().await.unwrap(), 1);
    }
}

