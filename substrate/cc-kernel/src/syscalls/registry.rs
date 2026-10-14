//! Syscall registry.

use super::Syscall;
use super::{
    l0_observe::{FsHash, FsRead, FsScan, OrbitGetContext, RagSearch},
    l1_interpret::{ClusterDuplicates, EmbedCompute, InferSuperseded, ValidateDocClaims},
    l2_structure::{ProposePatch, ProposeMove, ProposeRedirects},
    l3_apply::{ApplyPatch, ApplyMove, DbUpsert},
    l4_transform::{FsQuarantine, RebuildIndex},
};
use std::collections::HashMap;
use std::sync::Arc;

/// Registry of available syscalls.
pub struct SyscallRegistry {
    syscalls: HashMap<String, Arc<dyn Syscall>>,
}

impl SyscallRegistry {
    /// Create a new empty registry.
    pub fn new() -> Self {
        Self {
            syscalls: HashMap::new(),
        }
    }

    /// Create a registry with all default syscalls.
    pub fn with_defaults() -> Self {
        let mut registry = Self::new();

        // L0: Observe
        registry.register(Arc::new(FsScan));
        registry.register(Arc::new(FsHash));
        registry.register(Arc::new(FsRead));
        registry.register(Arc::new(RagSearch));
        registry.register(Arc::new(OrbitGetContext));

        // L1: Interpret
        registry.register(Arc::new(EmbedCompute));
        registry.register(Arc::new(ClusterDuplicates));
        registry.register(Arc::new(InferSuperseded));
        registry.register(Arc::new(ValidateDocClaims));

        // L2: Structure
        registry.register(Arc::new(ProposePatch));
        registry.register(Arc::new(ProposeMove));
        registry.register(Arc::new(ProposeRedirects));

        // L3: Apply
        registry.register(Arc::new(ApplyPatch));
        registry.register(Arc::new(ApplyMove));
        registry.register(Arc::new(DbUpsert));

        // L4: Transform
        registry.register(Arc::new(FsQuarantine));
        registry.register(Arc::new(RebuildIndex));

        registry
    }

    /// Register a syscall.
    pub fn register(&mut self, syscall: Arc<dyn Syscall>) {
        self.syscalls.insert(syscall.id().to_string(), syscall);
    }

    /// Get a syscall by ID.
    pub fn get(&self, id: &str) -> Option<Arc<dyn Syscall>> {
        self.syscalls.get(id).cloned()
    }

    /// Get all syscalls.
    pub fn all(&self) -> impl Iterator<Item = &Arc<dyn Syscall>> {
        self.syscalls.values()
    }

    /// Get syscall count.
    pub fn len(&self) -> usize {
        self.syscalls.len()
    }

    /// Check if empty.
    pub fn is_empty(&self) -> bool {
        self.syscalls.is_empty()
    }
}

impl Default for SyscallRegistry {
    fn default() -> Self {
        Self::with_defaults()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_registry_defaults() {
        let registry = SyscallRegistry::with_defaults();
        assert!(!registry.is_empty());
        assert!(registry.get("fs.scan").is_some());
        assert!(registry.get("rag.search").is_some());
        assert!(registry.get("apply.patch").is_some());
    }
}

