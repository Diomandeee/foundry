//! Layer 2: Structure syscalls (create proposals).

use crate::syscalls::{Syscall, SyscallContext};
use crate::types::{ArtifactRef, CostModel, Layer, Mutability, ToolOutput};
use anyhow::{anyhow, Result};
use async_trait::async_trait;
use serde_json::{json, Value};

/// propose.patch - Create a patch proposal artifact.
pub struct ProposePatch;

#[async_trait]
impl Syscall for ProposePatch {
    fn id(&self) -> &'static str {
        "propose.patch"
    }

    fn layer(&self) -> Layer {
        Layer::STRUCTURE
    }

    fn mutability(&self) -> Mutability {
        Mutability::ProposeOnly
    }

    fn cost(&self) -> CostModel {
        CostModel::standard()
    }

    fn validate_args(&self, args: &Value) -> Result<()> {
        args.get("file")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow!("file is required"))?;
        args.get("diff")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow!("diff is required"))?;
        Ok(())
    }

    async fn execute(&self, args: Value, ctx: SyscallContext<'_>) -> Result<ToolOutput> {
        let file = args["file"].as_str().unwrap();
        let diff = args["diff"].as_str().unwrap();
        let description = args.get("description").and_then(|v| v.as_str()).unwrap_or("");

        // Create proposal artifact
        let proposal = json!({
            "type": "patch",
            "file": file,
            "diff": diff,
            "description": description,
        });

        let proposal_bytes = serde_json::to_vec(&proposal)?;
        let hash: [u8; 32] = blake3::hash(&proposal_bytes).into();

        // Store proposal
        let uri = ctx.services.artifacts.store("proposal", &proposal_bytes).await?;

        Ok(ToolOutput {
            result: json!({ "proposal_hash": hex::encode(hash), "file": file }),
            artifacts: vec![ArtifactRef::new("proposal", hash, uri)],
            summary: Some(format!("Created patch proposal for {}", file)),
        })
    }
}

/// propose.move - Create a move plan proposal.
pub struct ProposeMove;

#[async_trait]
impl Syscall for ProposeMove {
    fn id(&self) -> &'static str {
        "propose.move"
    }

    fn layer(&self) -> Layer {
        Layer::STRUCTURE
    }

    fn mutability(&self) -> Mutability {
        Mutability::ProposeOnly
    }

    fn cost(&self) -> CostModel {
        CostModel::standard()
    }

    fn validate_args(&self, args: &Value) -> Result<()> {
        args.get("moves")
            .and_then(|v| v.as_array())
            .filter(|arr| !arr.is_empty())
            .ok_or_else(|| anyhow!("moves array is required and must not be empty"))?;
        Ok(())
    }

    async fn execute(&self, args: Value, ctx: SyscallContext<'_>) -> Result<ToolOutput> {
        let moves = args["moves"].as_array().unwrap();

        // Validate each move
        for m in moves {
            m.get("src").and_then(|v| v.as_str())
                .ok_or_else(|| anyhow!("each move must have src"))?;
            m.get("dst").and_then(|v| v.as_str())
                .ok_or_else(|| anyhow!("each move must have dst"))?;
        }

        // Create proposal artifact
        let proposal = json!({
            "type": "move",
            "moves": moves,
        });

        let proposal_bytes = serde_json::to_vec(&proposal)?;
        let hash: [u8; 32] = blake3::hash(&proposal_bytes).into();

        // Store proposal
        let uri = ctx.services.artifacts.store("proposal", &proposal_bytes).await?;

        Ok(ToolOutput {
            result: json!({ "proposal_hash": hex::encode(hash), "move_count": moves.len() }),
            artifacts: vec![ArtifactRef::new("proposal", hash, uri)],
            summary: Some(format!("Created move proposal for {} items", moves.len())),
        })
    }
}

/// propose.redirects - Create redirect headers for superseded docs.
pub struct ProposeRedirects;

#[async_trait]
impl Syscall for ProposeRedirects {
    fn id(&self) -> &'static str {
        "propose.redirects"
    }

    fn layer(&self) -> Layer {
        Layer::STRUCTURE
    }

    fn mutability(&self) -> Mutability {
        Mutability::ProposeOnly
    }

    fn cost(&self) -> CostModel {
        CostModel::standard()
    }

    fn validate_args(&self, args: &Value) -> Result<()> {
        args.get("redirects")
            .and_then(|v| v.as_array())
            .ok_or_else(|| anyhow!("redirects array is required"))?;
        Ok(())
    }

    async fn execute(&self, args: Value, ctx: SyscallContext<'_>) -> Result<ToolOutput> {
        let redirects = args["redirects"].as_array().unwrap();

        // Create proposal artifact
        let proposal = json!({
            "type": "redirects",
            "redirects": redirects,
        });

        let proposal_bytes = serde_json::to_vec(&proposal)?;
        let hash: [u8; 32] = blake3::hash(&proposal_bytes).into();

        // Store proposal
        let uri = ctx.services.artifacts.store("proposal", &proposal_bytes).await?;

        Ok(ToolOutput {
            result: json!({ "proposal_hash": hex::encode(hash), "redirect_count": redirects.len() }),
            artifacts: vec![ArtifactRef::new("proposal", hash, uri)],
            summary: Some(format!("Created {} redirect proposals", redirects.len())),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_propose_patch_layer() {
        let syscall = ProposePatch;
        assert_eq!(syscall.layer(), Layer::STRUCTURE);
        assert_eq!(syscall.mutability(), Mutability::ProposeOnly);
    }

    #[test]
    fn test_propose_move_validation() {
        let syscall = ProposeMove;
        assert!(syscall.validate_args(&json!({
            "moves": [{"src": "a", "dst": "b"}]
        })).is_ok());
        assert!(syscall.validate_args(&json!({"moves": []})).is_err());
    }
}

