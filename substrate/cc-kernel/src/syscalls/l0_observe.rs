//! Layer 0: Observe syscalls (read-only inspection).

use crate::syscalls::{Syscall, SyscallContext};
use crate::types::{CostModel, Layer, Mutability, ToolOutput};
use anyhow::{anyhow, Result};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::time::Duration;

/// fs.scan - Recursively scan a directory.
pub struct FsScan;

#[async_trait]
impl Syscall for FsScan {
    fn id(&self) -> &'static str {
        "fs.scan"
    }

    fn layer(&self) -> Layer {
        Layer::OBSERVE
    }

    fn mutability(&self) -> Mutability {
        Mutability::ReadOnly
    }

    fn cost(&self) -> CostModel {
        CostModel::standard()
    }

    fn validate_args(&self, args: &Value) -> Result<()> {
        args.get("path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow!("path is required"))?;
        Ok(())
    }

    async fn execute(&self, args: Value, ctx: SyscallContext<'_>) -> Result<ToolOutput> {
        let path = args["path"].as_str().unwrap();
        let max_depth = args.get("max_depth").and_then(|v| v.as_u64()).unwrap_or(10) as usize;
        let include_hidden = args.get("include_hidden").and_then(|v| v.as_bool()).unwrap_or(false);

        let entries = ctx.services.fs.scan(path, max_depth, include_hidden).await?;

        Ok(ToolOutput::with_summary(
            json!({ "entries": entries, "count": entries.len() }),
            format!("Scanned {} entries", entries.len()),
        ))
    }
}

/// fs.hash - Compute cryptographic hash of a file.
pub struct FsHash;

#[async_trait]
impl Syscall for FsHash {
    fn id(&self) -> &'static str {
        "fs.hash"
    }

    fn layer(&self) -> Layer {
        Layer::OBSERVE
    }

    fn mutability(&self) -> Mutability {
        Mutability::ReadOnly
    }

    fn cost(&self) -> CostModel {
        CostModel::standard()
    }

    fn validate_args(&self, args: &Value) -> Result<()> {
        args.get("path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow!("path is required"))?;
        Ok(())
    }

    async fn execute(&self, args: Value, ctx: SyscallContext<'_>) -> Result<ToolOutput> {
        let path = args["path"].as_str().unwrap();

        let hash = ctx.services.fs.hash(path).await?;

        Ok(ToolOutput::with_summary(
            json!({ "path": path, "hash": hash }),
            format!("Hash: {}", &hash[..16]),
        ))
    }
}

/// fs.read - Read file contents.
pub struct FsRead;

#[async_trait]
impl Syscall for FsRead {
    fn id(&self) -> &'static str {
        "fs.read"
    }

    fn layer(&self) -> Layer {
        Layer::OBSERVE
    }

    fn mutability(&self) -> Mutability {
        Mutability::ReadOnly
    }

    fn cost(&self) -> CostModel {
        CostModel::standard()
    }

    fn validate_args(&self, args: &Value) -> Result<()> {
        args.get("path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow!("path is required"))?;
        Ok(())
    }

    async fn execute(&self, args: Value, ctx: SyscallContext<'_>) -> Result<ToolOutput> {
        let path = args["path"].as_str().unwrap();
        let max_bytes = args.get("max_bytes").and_then(|v| v.as_u64()).unwrap_or(1_048_576) as usize;

        let content = ctx.services.fs.read(path, max_bytes).await?;

        Ok(ToolOutput::with_summary(
            json!({ "path": path, "content": content, "bytes": content.len() }),
            format!("Read {} bytes", content.len()),
        ))
    }
}

/// rag.search - Query memory fabric.
pub struct RagSearch;

#[async_trait]
impl Syscall for RagSearch {
    fn id(&self) -> &'static str {
        "rag.search"
    }

    fn layer(&self) -> Layer {
        Layer::OBSERVE
    }

    fn mutability(&self) -> Mutability {
        Mutability::ReadOnly
    }

    fn cost(&self) -> CostModel {
        CostModel::standard()
    }

    fn max_snapshot_age(&self) -> Option<Duration> {
        None // No staleness check for searches
    }

    fn validate_args(&self, args: &Value) -> Result<()> {
        args.get("query")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow!("query is required"))?;
        Ok(())
    }

    async fn execute(&self, args: Value, ctx: SyscallContext<'_>) -> Result<ToolOutput> {
        let query = args["query"].as_str().unwrap();
        let limit = args.get("limit").and_then(|v| v.as_u64()).unwrap_or(10) as usize;

        let results = ctx.services.rag.search(query, limit).await?;

        Ok(ToolOutput::with_summary(
            json!({ "query": query, "results": results, "count": results.len() }),
            format!("Found {} results", results.len()),
        ))
    }
}

/// orbit.get_context - Get current project context.
pub struct OrbitGetContext;

#[async_trait]
impl Syscall for OrbitGetContext {
    fn id(&self) -> &'static str {
        "orbit.get_context"
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

    fn max_snapshot_age(&self) -> Option<Duration> {
        None
    }

    fn validate_args(&self, _args: &Value) -> Result<()> {
        Ok(())
    }

    async fn execute(&self, args: Value, ctx: SyscallContext<'_>) -> Result<ToolOutput> {
        let include_git = args.get("include_git").and_then(|v| v.as_bool()).unwrap_or(true);
        let include_plan = args.get("include_plan").and_then(|v| v.as_bool()).unwrap_or(true);

        let context = ctx.services.orbit.get_context(
            ctx.scope.project_id,
            include_git,
            include_plan,
        ).await?;

        Ok(ToolOutput::with_summary(
            context,
            "Retrieved project context",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_fs_scan_validation() {
        let syscall = FsScan;
        assert!(syscall.validate_args(&json!({"path": "/tmp"})).is_ok());
        assert!(syscall.validate_args(&json!({})).is_err());
    }

    #[test]
    fn test_rag_search_no_staleness() {
        let syscall = RagSearch;
        assert!(syscall.max_snapshot_age().is_none());
    }
}

