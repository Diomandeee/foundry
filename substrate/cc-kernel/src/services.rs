//! Kernel services - abstraction layer for external dependencies.

use anyhow::Result;
use async_trait::async_trait;
use serde_json::Value;
use std::sync::Arc;
use uuid::Uuid;

/// Container for kernel services.
pub struct KernelServices {
    /// Filesystem service.
    pub fs: Arc<dyn FsService>,

    /// RAG/memory service.
    pub rag: Arc<dyn RagService>,

    /// ML/embedding service.
    pub ml: Arc<dyn MlService>,

    /// Database service.
    pub db: Arc<dyn DbService>,

    /// Artifact storage service.
    pub artifacts: Arc<dyn ArtifactService>,

    /// Orbit context service.
    pub orbit: Arc<dyn OrbitService>,
}

impl KernelServices {
    /// Create services with mock implementations (for testing).
    pub fn mock() -> Self {
        Self {
            fs: Arc::new(MockFsService),
            rag: Arc::new(MockRagService),
            ml: Arc::new(MockMlService),
            db: Arc::new(MockDbService),
            artifacts: Arc::new(MockArtifactService),
            orbit: Arc::new(MockOrbitService),
        }
    }
}

/// Filesystem service trait.
#[async_trait]
pub trait FsService: Send + Sync {
    /// Scan a directory recursively.
    async fn scan(&self, path: &str, max_depth: usize, include_hidden: bool) -> Result<Vec<Value>>;

    /// Compute hash of a file.
    async fn hash(&self, path: &str) -> Result<String>;

    /// Read file contents.
    async fn read(&self, path: &str, max_bytes: usize) -> Result<String>;

    /// Apply a patch to a file.
    async fn apply_patch(&self, path: &str, diff: &str) -> Result<()>;

    /// Rename/move a file.
    async fn rename(&self, src: &str, dst: &str) -> Result<()>;

    /// Quarantine files (move to archive).
    async fn quarantine(&self, paths: &[String], reason: &str) -> Result<Vec<String>>;
}

/// RAG/memory service trait.
#[async_trait]
pub trait RagService: Send + Sync {
    /// Search memory fabric.
    async fn search(&self, query: &str, limit: usize) -> Result<Vec<Value>>;

    /// Rebuild an index.
    async fn rebuild_index(&self, index_name: &str, force: bool) -> Result<Value>;
}

/// ML/embedding service trait.
#[async_trait]
pub trait MlService: Send + Sync {
    /// Compute embedding for text.
    async fn compute_embedding(&self, text: &str) -> Result<Vec<f32>>;

    /// Cluster items to find duplicates.
    async fn cluster_duplicates(&self, items: &[String], threshold: f64) -> Result<Vec<Value>>;

    /// Infer superseded documents.
    async fn infer_superseded(&self, doc_paths: &[String]) -> Result<Vec<Value>>;

    /// Validate document claims against codebase.
    async fn validate_doc_claims(&self, doc_path: &str, repo_path: Option<&str>) -> Result<Vec<Value>>;
}

/// Database service trait.
#[async_trait]
pub trait DbService: Send + Sync {
    /// Upsert a record.
    async fn upsert(&self, table: &str, record: &Value, conflict_columns: &[String]) -> Result<Value>;
}

/// Artifact storage service trait.
#[async_trait]
pub trait ArtifactService: Send + Sync {
    /// Store an artifact and return its URI.
    async fn store(&self, kind: &str, data: &[u8]) -> Result<String>;

    /// Retrieve an artifact as JSON.
    async fn get_json(&self, hash: &[u8; 32]) -> Result<Value>;

    /// Check if an artifact exists.
    async fn exists(&self, hash: &[u8; 32]) -> Result<bool>;
}

/// Orbit context service trait.
#[async_trait]
pub trait OrbitService: Send + Sync {
    /// Get project context.
    async fn get_context(&self, project_id: Uuid, include_git: bool, include_plan: bool) -> Result<Value>;
}

// Mock implementations for testing

struct MockFsService;

#[async_trait]
impl FsService for MockFsService {
    async fn scan(&self, path: &str, _max_depth: usize, _include_hidden: bool) -> Result<Vec<Value>> {
        Ok(vec![serde_json::json!({"path": path, "type": "directory"})])
    }

    async fn hash(&self, _path: &str) -> Result<String> {
        Ok("0".repeat(64))
    }

    async fn read(&self, _path: &str, _max_bytes: usize) -> Result<String> {
        Ok("mock content".into())
    }

    async fn apply_patch(&self, _path: &str, _diff: &str) -> Result<()> {
        Ok(())
    }

    async fn rename(&self, _src: &str, _dst: &str) -> Result<()> {
        Ok(())
    }

    async fn quarantine(&self, paths: &[String], _reason: &str) -> Result<Vec<String>> {
        Ok(paths.to_vec())
    }
}

struct MockRagService;

#[async_trait]
impl RagService for MockRagService {
    async fn search(&self, query: &str, limit: usize) -> Result<Vec<Value>> {
        Ok(vec![serde_json::json!({"query": query, "limit": limit})])
    }

    async fn rebuild_index(&self, index_name: &str, _force: bool) -> Result<Value> {
        Ok(serde_json::json!({"index": index_name, "rebuilt": true}))
    }
}

struct MockMlService;

#[async_trait]
impl MlService for MockMlService {
    async fn compute_embedding(&self, _text: &str) -> Result<Vec<f32>> {
        Ok(vec![0.0; 768])
    }

    async fn cluster_duplicates(&self, _items: &[String], _threshold: f64) -> Result<Vec<Value>> {
        Ok(vec![])
    }

    async fn infer_superseded(&self, _doc_paths: &[String]) -> Result<Vec<Value>> {
        Ok(vec![])
    }

    async fn validate_doc_claims(&self, _doc_path: &str, _repo_path: Option<&str>) -> Result<Vec<Value>> {
        Ok(vec![serde_json::json!({"claim": "test", "valid": true})])
    }
}

struct MockDbService;

#[async_trait]
impl DbService for MockDbService {
    async fn upsert(&self, table: &str, _record: &Value, _conflict_columns: &[String]) -> Result<Value> {
        Ok(serde_json::json!({"table": table, "success": true}))
    }
}

struct MockArtifactService;

#[async_trait]
impl ArtifactService for MockArtifactService {
    async fn store(&self, kind: &str, data: &[u8]) -> Result<String> {
        let hash = hex::encode(blake3::hash(data).as_bytes());
        Ok(format!("artifact://{}/{}", kind, hash))
    }

    async fn get_json(&self, _hash: &[u8; 32]) -> Result<Value> {
        Ok(serde_json::json!({}))
    }

    async fn exists(&self, _hash: &[u8; 32]) -> Result<bool> {
        Ok(true)
    }
}

struct MockOrbitService;

#[async_trait]
impl OrbitService for MockOrbitService {
    async fn get_context(&self, project_id: Uuid, _include_git: bool, _include_plan: bool) -> Result<Value> {
        Ok(serde_json::json!({
            "project_id": project_id.to_string(),
            "name": "Mock Project",
            "status": "active"
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_mock_services() {
        let services = KernelServices::mock();
        
        let entries = services.fs.scan("/tmp", 10, false).await.unwrap();
        assert!(!entries.is_empty());
        
        let results = services.rag.search("test", 10).await.unwrap();
        assert!(!results.is_empty());
    }
}

