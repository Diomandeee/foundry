//! Layer 3: Apply syscalls (execute proposals).

use crate::syscalls::{Syscall, SyscallContext};
use crate::types::{CostModel, Layer, Mutability, ToolOutput};
use anyhow::{anyhow, Result};
use async_trait::async_trait;
use serde_json::{json, Value};

/// apply.patch - Apply a previously proposed patch.
pub struct ApplyPatch;

#[async_trait]
impl Syscall for ApplyPatch {
    fn id(&self) -> &'static str {
        "apply.patch"
    }

    fn layer(&self) -> Layer {
        Layer::APPLY
    }

    fn mutability(&self) -> Mutability {
        Mutability::Reversible
    }

    fn cost(&self) -> CostModel {
        CostModel::standard()
    }

    fn validate_args(&self, args: &Value) -> Result<()> {
        args.get("proposal_hash")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow!("proposal_hash is required"))?;
        Ok(())
    }

    async fn execute(&self, args: Value, ctx: SyscallContext<'_>) -> Result<ToolOutput> {
        let hash_hex = args["proposal_hash"].as_str().unwrap();
        let hash_bytes = hex::decode(hash_hex)?;
        if hash_bytes.len() != 32 {
            return Err(anyhow!("invalid hash length"));
        }

        let mut hash = [0u8; 32];
        hash.copy_from_slice(&hash_bytes);

        // Retrieve proposal
        let proposal: Value = ctx.services.artifacts.get_json(&hash).await?;

        let file = proposal["file"]
            .as_str()
            .ok_or_else(|| anyhow!("invalid proposal: missing file"))?;
        let diff = proposal["diff"]
            .as_str()
            .ok_or_else(|| anyhow!("invalid proposal: missing diff"))?;

        // Apply the patch
        ctx.services.fs.apply_patch(file, diff).await?;

        Ok(ToolOutput::with_summary(
            json!({ "file": file, "applied": true }),
            format!("Applied patch to {}", file),
        ))
    }

    fn rollback_data(&self, _args: &Value, _output: &ToolOutput) -> Option<Vec<u8>> {
        // In practice, we'd store the original file content here
        // For now, just signal that rollback is possible
        Some(vec![])
    }
}

/// apply.move - Execute a previously proposed move plan.
pub struct ApplyMove;

#[async_trait]
impl Syscall for ApplyMove {
    fn id(&self) -> &'static str {
        "apply.move"
    }

    fn layer(&self) -> Layer {
        Layer::APPLY
    }

    fn mutability(&self) -> Mutability {
        Mutability::Reversible
    }

    fn cost(&self) -> CostModel {
        CostModel::standard()
    }

    fn validate_args(&self, args: &Value) -> Result<()> {
        args.get("proposal_hash")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow!("proposal_hash is required"))?;
        Ok(())
    }

    async fn execute(&self, args: Value, ctx: SyscallContext<'_>) -> Result<ToolOutput> {
        let hash_hex = args["proposal_hash"].as_str().unwrap();
        let hash_bytes = hex::decode(hash_hex)?;
        if hash_bytes.len() != 32 {
            return Err(anyhow!("invalid hash length"));
        }

        let mut hash = [0u8; 32];
        hash.copy_from_slice(&hash_bytes);

        // Retrieve proposal
        let proposal: Value = ctx.services.artifacts.get_json(&hash).await?;

        let moves = proposal["moves"]
            .as_array()
            .ok_or_else(|| anyhow!("invalid proposal: missing moves"))?;

        // Execute each move
        let mut moved = vec![];
        for m in moves {
            let src = m["src"].as_str().unwrap();
            let dst = m["dst"].as_str().unwrap();
            ctx.services.fs.rename(src, dst).await?;
            moved.push(json!({"src": src, "dst": dst}));
        }

        Ok(ToolOutput::with_summary(
            json!({ "moves": moved, "count": moved.len() }),
            format!("Moved {} items", moved.len()),
        ))
    }
}

/// db.upsert - Insert or update a database record.
pub struct DbUpsert;

#[async_trait]
impl Syscall for DbUpsert {
    fn id(&self) -> &'static str {
        "db.upsert"
    }

    fn layer(&self) -> Layer {
        Layer::APPLY
    }

    fn mutability(&self) -> Mutability {
        Mutability::Reversible
    }

    fn cost(&self) -> CostModel {
        CostModel::standard()
    }

    fn validate_args(&self, args: &Value) -> Result<()> {
        args.get("table")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow!("table is required"))?;
        args.get("record")
            .and_then(|v| v.as_object())
            .ok_or_else(|| anyhow!("record object is required"))?;
        Ok(())
    }

    async fn execute(&self, args: Value, ctx: SyscallContext<'_>) -> Result<ToolOutput> {
        let table = args["table"].as_str().unwrap();
        let record = &args["record"];
        let conflict_columns: Vec<String> = args
            .get("conflict_columns")
            .and_then(|v| v.as_array())
            .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
            .unwrap_or_default();

        let result = ctx.services.db.upsert(table, record, &conflict_columns).await?;

        Ok(ToolOutput::with_summary(
            json!({ "table": table, "result": result }),
            format!("Upserted record to {}", table),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_apply_patch_layer() {
        let syscall = ApplyPatch;
        assert_eq!(syscall.layer(), Layer::APPLY);
        assert_eq!(syscall.mutability(), Mutability::Reversible);
    }

    #[test]
    fn test_db_upsert_validation() {
        let syscall = DbUpsert;
        assert!(syscall.validate_args(&json!({
            "table": "test",
            "record": {"id": 1}
        })).is_ok());
        assert!(syscall.validate_args(&json!({"table": "test"})).is_err());
    }
}

