//! Scope token for capability management.

use super::{Layer, LayerRange};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use uuid::Uuid;

/// A capability token that grants permission to call tools.
///
/// Scope tokens are short-lived and context-specific. They bind a session
/// to a set of allowed tools and layers.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ScopeToken {
    /// Unique identifier for this scope.
    pub scope_id: Uuid,

    /// The project this scope applies to.
    pub project_id: Uuid,

    /// Optional session binding.
    pub session_id: Option<Uuid>,

    /// Tools that may be called under this scope.
    /// Empty means all tools within layer range are allowed.
    pub allowed_tools: Vec<String>,

    /// Layer range this scope permits.
    pub allowed_layers: LayerRange,

    /// Whether mutation operations are permitted.
    pub can_mutate: bool,

    /// Allowed filesystem roots (empty = all permitted paths).
    pub allowed_roots: Vec<PathBuf>,

    /// When this scope was issued.
    pub issued_at: DateTime<Utc>,

    /// When this scope expires.
    pub expires_at: DateTime<Utc>,

    /// Cryptographic signature (optional, for remote validation).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<Vec<u8>>,
}

impl ScopeToken {
    /// Create a new scope token with default 1-hour expiry.
    pub fn new(project_id: Uuid, session_id: Option<Uuid>) -> Self {
        let now = Utc::now();
        Self {
            scope_id: Uuid::new_v4(),
            project_id,
            session_id,
            allowed_tools: Vec::new(),
            allowed_layers: LayerRange::standard(),
            can_mutate: false,
            allowed_roots: Vec::new(),
            issued_at: now,
            expires_at: now + Duration::hours(1),
            signature: None,
        }
    }

    /// Create a read-only scope token.
    pub fn read_only(project_id: Uuid) -> Self {
        Self {
            allowed_layers: LayerRange::read_only(),
            can_mutate: false,
            ..Self::new(project_id, None)
        }
    }

    /// Check if this scope is currently valid.
    pub fn is_valid(&self, now: DateTime<Utc>) -> bool {
        now >= self.issued_at && now < self.expires_at
    }

    /// Check if this scope has expired.
    pub fn is_expired(&self) -> bool {
        Utc::now() >= self.expires_at
    }

    /// Check if a tool is allowed under this scope.
    pub fn allows_tool(&self, tool_id: &str) -> bool {
        self.allowed_tools.is_empty() || self.allowed_tools.iter().any(|t| t == tool_id)
    }

    /// Check if a layer is allowed under this scope.
    pub fn allows_layer(&self, layer: Layer) -> bool {
        self.allowed_layers.contains(layer)
    }

    /// Check if a path is within allowed roots.
    ///
    /// An empty `allowed_roots` permits every path. The allowlist is compared
    /// against the canonicalised path (see [`canonicalize_path`]), because a
    /// tool argument is caller-supplied and `src/allowed/../secret.txt` must not
    /// read as "under `src/allowed`".
    pub fn allows_path(&self, path: &Path) -> bool {
        if self.allowed_roots.is_empty() {
            return true;
        }
        let norm = canonicalize_path(path);
        self.allowed_roots.iter().any(|root| {
            let r = canonicalize_path(root);
            if r.is_empty() {
                return false;
            }
            let prefix = if r == "/" {
                "/".to_string()
            } else {
                format!("{}/", r)
            };
            norm == r || norm.starts_with(&prefix)
        })
    }
}

// LOCAL PATCH — not upstream. See substrate/README.md, "Local modifications".
//
// Upstream compared with `Path::starts_with`, which is component-wise but does
// not resolve dot segments: `src/allowed/../secret.txt` starts with
// `src/allowed` and was therefore admitted. `Path::starts_with` also collapses
// repeated separators, so `src//allowed/x` was admitted upstream while the
// TypeScript port rejected it — the same input, two answers. Both sides now
// canonicalise first, and `fixtures/kernel-parity.json` is the shared case set
// that keeps them equal. Keep the body identical to `canonicalizePath` in
// `packages/gate-ts/src/types.ts`.
//
/// Lexically resolve `.` and `..` the way a filesystem would, without touching
/// the filesystem. `\` is a filename character on POSIX, not a separator.
fn canonicalize_path(path: &Path) -> String {
    let text = path.to_string_lossy();
    let absolute = text.starts_with('/');
    let mut out: Vec<&str> = Vec::new();
    for segment in text.split('/') {
        match segment {
            "" | "." => continue,
            ".." => match out.last() {
                Some(last) if *last != ".." => {
                    out.pop();
                }
                // `..` at an absolute root is a no-op, as POSIX resolves it.
                None | Some(_) if !absolute => out.push(".."),
                _ => {}
            },
            other => out.push(other),
        }
    }
    let joined = out.join("/");
    if absolute {
        format!("/{}", joined)
    } else if joined.is_empty() {
        ".".to_string()
    } else {
        joined
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_scope_validity() {
        let scope = ScopeToken::new(Uuid::new_v4(), None);
        assert!(scope.is_valid(Utc::now()));
        assert!(!scope.is_expired());
    }

    #[test]
    fn test_scope_tool_filtering() {
        let mut scope = ScopeToken::new(Uuid::new_v4(), None);
        scope.allowed_tools = vec!["fs.scan".into(), "fs.hash".into()];

        assert!(scope.allows_tool("fs.scan"));
        assert!(!scope.allows_tool("apply.patch"));
    }

    fn scoped_to(roots: &[&str]) -> ScopeToken {
        let mut scope = ScopeToken::new(Uuid::new_v4(), None);
        scope.allowed_roots = roots.iter().map(PathBuf::from).collect();
        scope
    }

    #[test]
    fn test_allows_path_basics() {
        let scope = scoped_to(&["src/allowed"]);
        assert!(scope.allows_path(Path::new("src/allowed/x.txt")));
        assert!(scope.allows_path(Path::new("src/allowed")));
        assert!(scope.allows_path(Path::new("src/allowed/")));
        // Prefix match must respect a segment boundary.
        assert!(!scope.allows_path(Path::new("src/allowed_elsewhere/x")));
        assert!(!scope.allows_path(Path::new("src")));
        assert!(!scope.allows_path(Path::new("etc/passwd")));
    }

    #[test]
    fn test_allows_path_traversal_is_resolved() {
        let scope = scoped_to(&["src/allowed"]);
        // The traversal hole: this string starts with the allowed root.
        assert!(!scope.allows_path(Path::new("src/allowed/../secret.txt")));
        assert!(!scope.allows_path(Path::new("src/allowed/../../etc/passwd")));
        assert!(!scope.allows_path(Path::new("../src/allowed/x")));
        // A dot segment that stays inside is still inside.
        assert!(scope.allows_path(Path::new("src/allowed/a/../b.txt")));
        assert!(scope.allows_path(Path::new("./src/allowed/x")));
    }

    #[test]
    fn test_allows_path_absolute_and_separators() {
        let scope = scoped_to(&["src/allowed"]);
        assert!(!scope.allows_path(Path::new("/src/allowed/x")));
        assert!(!scope.allows_path(Path::new("/etc/passwd")));
        // `\` is a filename character on POSIX, never a separator: the result
        // must fail closed rather than treat `..\..` as a traversal.
        assert!(!scope.allows_path(Path::new("src\\..\\..\\etc\\passwd")));
        // Repeated separators collapse to the same target.
        assert!(scope.allows_path(Path::new("src//allowed///x.txt")));

        let root = scoped_to(&["/"]);
        assert!(root.allows_path(Path::new("/anywhere/x")));
        assert!(!root.allows_path(Path::new("relative/x")));
    }

    #[test]
    fn test_allows_path_empty_roots_is_fail_open() {
        // Documented default: no roots means every path. Asserted so the
        // behaviour is a decision, not an accident.
        let scope = scoped_to(&[]);
        assert!(scope.allows_path(Path::new("anything/at/all")));
        assert!(scope.allows_path(Path::new("/etc/shadow")));
    }

    #[test]
    fn test_canonicalize_path_matches_the_port() {
        // The same table is asserted by packages/gate-ts/src/gate.test.ts;
        // fixtures/kernel-parity.json is the shared case set.
        for (input, expected) in [
            ("a/b", "a/b"),
            ("a//b", "a/b"),
            ("a/./b", "a/b"),
            ("a/../b", "b"),
            ("a/b/..", "a"),
            ("..", ".."),
            ("../a", "../a"),
            ("a/../../b", "../b"),
            (".", "."),
            ("", "."),
            ("/", "/"),
            ("/a/b", "/a/b"),
            ("/../a", "/a"),
            ("/a/../../b", "/b"),
        ] {
            assert_eq!(
                canonicalize_path(Path::new(input)),
                expected,
                "canonicalize_path({input:?})"
            );
        }
    }
}
