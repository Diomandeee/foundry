//! Snapshot ID for world state binding.

use serde::{Deserialize, Serialize};
use std::io;
use std::path::PathBuf;

/// A cryptographic binding to a specific world state.
///
/// Snapshot IDs ensure that tool calls execute against the state
/// they were planned against, preventing stale execution.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SnapshotId(pub [u8; 32]);

impl SnapshotId {
    /// Create a zero snapshot (for testing).
    pub fn zero() -> Self {
        Self([0u8; 32])
    }

    /// Create a snapshot ID from a manifest of hashes.
    pub fn from_manifest(hashes: &[(&str, &[u8])]) -> Self {
        let mut hasher = blake3::Hasher::new();
        for (key, value) in hashes {
            hasher.update(key.as_bytes());
            hasher.update(value);
        }
        Self(hasher.finalize().into())
    }

    /// Create a snapshot ID from the current filesystem state.
    pub fn from_paths(paths: &[PathBuf]) -> io::Result<Self> {
        let mut hasher = blake3::Hasher::new();
        for path in paths {
            let metadata = std::fs::metadata(path)?;
            hasher.update(path.to_string_lossy().as_bytes());
            hasher.update(&metadata.len().to_le_bytes());
            if let Ok(modified) = metadata.modified() {
                let ts = modified
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs();
                hasher.update(&ts.to_le_bytes());
            }
        }
        Ok(Self(hasher.finalize().into()))
    }

    /// Create a snapshot from arbitrary bytes.
    pub fn from_bytes(data: &[u8]) -> Self {
        Self(blake3::hash(data).into())
    }

    /// Check if this snapshot matches another.
    pub fn matches(&self, other: &SnapshotId) -> bool {
        self.0 == other.0
    }

    /// Get the hash as a hex string.
    pub fn to_hex(&self) -> String {
        hex::encode(self.0)
    }

    /// Parse from a hex string.
    pub fn from_hex(s: &str) -> Result<Self, hex::FromHexError> {
        let bytes = hex::decode(s)?;
        if bytes.len() != 32 {
            return Err(hex::FromHexError::InvalidStringLength);
        }
        let mut arr = [0u8; 32];
        arr.copy_from_slice(&bytes);
        Ok(Self(arr))
    }
}

impl Default for SnapshotId {
    fn default() -> Self {
        Self::zero()
    }
}

impl std::fmt::Display for SnapshotId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", &self.to_hex()[..16])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_snapshot_from_manifest() {
        let s1 = SnapshotId::from_manifest(&[("file1", b"content1"), ("file2", b"content2")]);
        let s2 = SnapshotId::from_manifest(&[("file1", b"content1"), ("file2", b"content2")]);
        let s3 = SnapshotId::from_manifest(&[("file1", b"content1"), ("file2", b"different")]);

        assert!(s1.matches(&s2));
        assert!(!s1.matches(&s3));
    }

    #[test]
    fn test_hex_roundtrip() {
        let original = SnapshotId::from_bytes(b"test data");
        let hex = original.to_hex();
        let parsed = SnapshotId::from_hex(&hex).unwrap();
        assert!(original.matches(&parsed));
    }
}

