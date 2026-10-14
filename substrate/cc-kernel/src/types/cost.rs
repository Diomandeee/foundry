//! Cost and mutability types.

use serde::{Deserialize, Serialize};

/// Mutability classification for syscalls.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mutability {
    /// Does not change any state.
    ReadOnly,
    /// Produces proposal artifacts but no world mutation.
    ProposeOnly,
    /// Applies a mutation that can be reversed.
    Reversible,
    /// Applies an irreversible mutation.
    Irreversible,
}

impl Mutability {
    /// Check if this mutability level requires mutation permission.
    pub fn requires_mutation_permission(&self) -> bool {
        matches!(self, Mutability::Reversible | Mutability::Irreversible)
    }

    /// Check if this is a read-only operation.
    pub fn is_read_only(&self) -> bool {
        matches!(self, Mutability::ReadOnly)
    }
}

impl Default for Mutability {
    fn default() -> Self {
        Self::ReadOnly
    }
}

/// Cost model for a syscall.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CostModel {
    /// Worst-case compute units.
    pub worst_case_units: u64,
    /// Typical compute units.
    pub typical_units: u64,
    /// Whether cost can be estimated from args.
    pub supports_estimate: bool,
}

impl CostModel {
    /// Create a cost model for a cheap operation.
    pub fn cheap() -> Self {
        Self {
            worst_case_units: 10,
            typical_units: 5,
            supports_estimate: false,
        }
    }

    /// Create a cost model for a standard operation.
    pub fn standard() -> Self {
        Self {
            worst_case_units: 100,
            typical_units: 50,
            supports_estimate: false,
        }
    }

    /// Create a cost model for an expensive operation.
    pub fn expensive() -> Self {
        Self {
            worst_case_units: 1000,
            typical_units: 500,
            supports_estimate: true,
        }
    }

    /// Create a custom cost model.
    pub fn custom(worst_case: u64, typical: u64) -> Self {
        Self {
            worst_case_units: worst_case,
            typical_units: typical,
            supports_estimate: false,
        }
    }
}

impl Default for CostModel {
    fn default() -> Self {
        Self::standard()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_mutability() {
        assert!(!Mutability::ReadOnly.requires_mutation_permission());
        assert!(!Mutability::ProposeOnly.requires_mutation_permission());
        assert!(Mutability::Reversible.requires_mutation_permission());
        assert!(Mutability::Irreversible.requires_mutation_permission());
    }

    #[test]
    fn test_cost_model() {
        let cheap = CostModel::cheap();
        let expensive = CostModel::expensive();

        assert!(cheap.worst_case_units < expensive.worst_case_units);
    }
}

