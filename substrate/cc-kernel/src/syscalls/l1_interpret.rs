//! Layer 1: Interpret syscalls (summarize, cluster, analyze).

use crate::syscalls::{Syscall, SyscallContext};
use crate::types::{CostModel, Layer, Mutability, ToolOutput};
use anyhow::{anyhow, Result};
use async_trait::async_trait;
use serde_json::{json, Value};

/// embed.compute - Generate embeddings for text.
pub struct EmbedCompute;

#[async_trait]
impl Syscall for EmbedCompute {
    fn id(&self) -> &'static str {
        "embed.compute"
    }

    fn layer(&self) -> Layer {
        Layer::INTERPRET
    }

    fn mutability(&self) -> Mutability {
        Mutability::ReadOnly
    }

    fn cost(&self) -> CostModel {
        CostModel::standard()
    }

    fn validate_args(&self, args: &Value) -> Result<()> {
        args.get("text")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow!("text is required"))?;
        Ok(())
    }

    async fn execute(&self, args: Value, ctx: SyscallContext<'_>) -> Result<ToolOutput> {
        let text = args["text"].as_str().unwrap();

        let embedding = ctx.services.ml.compute_embedding(text).await?;

        Ok(ToolOutput::with_summary(
            json!({ "embedding": embedding, "dimensions": embedding.len() }),
            format!("Computed {}-dimensional embedding", embedding.len()),
        ))
    }
}

/// cluster.duplicates - Find similar/duplicate items.
pub struct ClusterDuplicates;

#[async_trait]
impl Syscall for ClusterDuplicates {
    fn id(&self) -> &'static str {
        "cluster.duplicates"
    }

    fn layer(&self) -> Layer {
        Layer::INTERPRET
    }

    fn mutability(&self) -> Mutability {
        Mutability::ReadOnly
    }

    fn cost(&self) -> CostModel {
        CostModel::expensive()
    }

    fn validate_args(&self, args: &Value) -> Result<()> {
        args.get("items")
            .and_then(|v| v.as_array())
            .filter(|arr| !arr.is_empty())
            .ok_or_else(|| anyhow!("items array is required and must not be empty"))?;
        Ok(())
    }

    async fn execute(&self, args: Value, ctx: SyscallContext<'_>) -> Result<ToolOutput> {
        let items: Vec<String> = args["items"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|v| v.as_str().map(String::from))
            .collect();
        let threshold = args.get("threshold").and_then(|v| v.as_f64()).unwrap_or(0.9);

        let clusters = ctx.services.ml.cluster_duplicates(&items, threshold).await?;

        Ok(ToolOutput::with_summary(
            json!({ "clusters": clusters, "cluster_count": clusters.len() }),
            format!("Found {} clusters", clusters.len()),
        ))
    }
}

/// infer.superseded - Detect superseded documents.
pub struct InferSuperseded;

#[async_trait]
impl Syscall for InferSuperseded {
    fn id(&self) -> &'static str {
        "infer.superseded"
    }

    fn layer(&self) -> Layer {
        Layer::INTERPRET
    }

    fn mutability(&self) -> Mutability {
        Mutability::ReadOnly
    }

    fn cost(&self) -> CostModel {
        CostModel::expensive()
    }

    fn validate_args(&self, args: &Value) -> Result<()> {
        args.get("doc_paths")
            .and_then(|v| v.as_array())
            .ok_or_else(|| anyhow!("doc_paths array is required"))?;
        Ok(())
    }

    async fn execute(&self, args: Value, ctx: SyscallContext<'_>) -> Result<ToolOutput> {
        let doc_paths: Vec<String> = args["doc_paths"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|v| v.as_str().map(String::from))
            .collect();

        let superseded = ctx.services.ml.infer_superseded(&doc_paths).await?;

        Ok(ToolOutput::with_summary(
            json!({ "superseded": superseded, "count": superseded.len() }),
            format!("Found {} superseded documents", superseded.len()),
        ))
    }
}

/// validate.doc_claims - Validate document claims against codebase.
pub struct ValidateDocClaims;

#[async_trait]
impl Syscall for ValidateDocClaims {
    fn id(&self) -> &'static str {
        "validate.doc_claims"
    }

    fn layer(&self) -> Layer {
        Layer::INTERPRET
    }

    fn mutability(&self) -> Mutability {
        Mutability::ReadOnly
    }

    fn cost(&self) -> CostModel {
        CostModel::expensive()
    }

    fn validate_args(&self, args: &Value) -> Result<()> {
        args.get("doc_path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow!("doc_path is required"))?;
        Ok(())
    }

    async fn execute(&self, args: Value, ctx: SyscallContext<'_>) -> Result<ToolOutput> {
        let doc_path = args["doc_path"].as_str().unwrap();
        let repo_path = args.get("repo_path").and_then(|v| v.as_str());

        let validation = ctx.services.ml.validate_doc_claims(doc_path, repo_path).await?;

        let valid_count = validation.iter().filter(|v| v["valid"].as_bool().unwrap_or(false)).count();

        Ok(ToolOutput::with_summary(
            json!({ "validations": validation, "total": validation.len(), "valid": valid_count }),
            format!("{}/{} claims valid", valid_count, validation.len()),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_embed_compute_layer() {
        let syscall = EmbedCompute;
        assert_eq!(syscall.layer(), Layer::INTERPRET);
    }

    #[test]
    fn test_cluster_duplicates_validation() {
        let syscall = ClusterDuplicates;
        assert!(syscall.validate_args(&json!({"items": ["a", "b"]})).is_ok());
        assert!(syscall.validate_args(&json!({"items": []})).is_err());
    }
}

