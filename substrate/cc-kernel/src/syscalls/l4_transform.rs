//! Layer 4: Transform syscalls (high-impact operations).

use crate::syscalls::{Syscall, SyscallContext};
use crate::types::{CostModel, Layer, Mutability, ToolOutput};
use anyhow::{anyhow, Result};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::time::Duration;

/// fs.quarantine - Move files to quarantine (reversible delete).
pub struct FsQuarantine;

#[async_trait]
impl Syscall for FsQuarantine {
    fn id(&self) -> &'static str {
        "fs.quarantine"
    }

    fn layer(&self) -> Layer {
        Layer::TRANSFORM
    }

    fn mutability(&self) -> Mutability {
        Mutability::Reversible
    }

    fn cost(&self) -> CostModel {
        CostModel::expensive()
    }

    fn max_snapshot_age(&self) -> Option<Duration> {
        Some(Duration::from_secs(5)) // Require very fresh state
    }

    fn validate_args(&self, args: &Value) -> Result<()> {
        args.get("paths")
            .and_then(|v| v.as_array())
            .filter(|arr| !arr.is_empty())
            .ok_or_else(|| anyhow!("paths array is required and must not be empty"))?;
        Ok(())
    }

    async fn execute(&self, args: Value, ctx: SyscallContext<'_>) -> Result<ToolOutput> {
        let paths: Vec<String> = args["paths"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|v| v.as_str().map(String::from))
            .collect();
        let reason = args.get("reason").and_then(|v| v.as_str()).unwrap_or("unspecified");

        let quarantined = ctx.services.fs.quarantine(&paths, reason).await?;

        Ok(ToolOutput::with_summary(
            json!({ "quarantined": quarantined, "count": quarantined.len(), "reason": reason }),
            format!("Quarantined {} items", quarantined.len()),
        ))
    }
}

/// rebuild.index - Full index reconstruction.
pub struct RebuildIndex;

#[async_trait]
impl Syscall for RebuildIndex {
    fn id(&self) -> &'static str {
        "rebuild.index"
    }

    fn layer(&self) -> Layer {
        Layer::TRANSFORM
    }

    fn mutability(&self) -> Mutability {
        Mutability::Irreversible
    }

    fn cost(&self) -> CostModel {
        CostModel::expensive()
    }

    fn max_snapshot_age(&self) -> Option<Duration> {
        Some(Duration::from_secs(5))
    }

    fn validate_args(&self, args: &Value) -> Result<()> {
        args.get("index_name")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow!("index_name is required"))?;
        Ok(())
    }

    async fn execute(&self, args: Value, ctx: SyscallContext<'_>) -> Result<ToolOutput> {
        let index_name = args["index_name"].as_str().unwrap();
        let force = args.get("force").and_then(|v| v.as_bool()).unwrap_or(false);

        let stats = ctx.services.rag.rebuild_index(index_name, force).await?;

        Ok(ToolOutput::with_summary(
            json!({ "index": index_name, "stats": stats }),
            format!("Rebuilt index '{}'", index_name),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_fs_quarantine_layer() {
        let syscall = FsQuarantine;
        assert_eq!(syscall.layer(), Layer::TRANSFORM);
        assert_eq!(syscall.mutability(), Mutability::Reversible);
    }

    #[test]
    fn test_rebuild_index_irreversible() {
        let syscall = RebuildIndex;
        assert_eq!(syscall.mutability(), Mutability::Irreversible);
    }
}

