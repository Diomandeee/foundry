//! Admissibility gate - the central enforcement point.
//!
//! Every proposed call must pass through this gate before execution.
//! The gate checks all rules and returns either Ok(()) or a RejectReason.

use crate::ledger::Ledger;
use crate::syscalls::Syscall;
use crate::types::{KernelState, Layer, Mutability, ProposedCall, SnapshotId};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::Duration;

/// Reasons why a proposed call may be rejected.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "reason", rename_all = "snake_case")]
pub enum RejectReason {
    /// Unknown tool ID.
    UnknownTool { tool_id: String },

    /// Scope token has expired.
    ScopeExpired { expired_at: DateTime<Utc> },

    /// Tool not allowed in scope.
    ToolNotAllowed { tool_id: String },

    /// Layer violation (too high or outside scope).
    LayerViolation {
        frontier: Layer,
        requested: Layer,
        max_allowed: Layer,
    },

    /// Time gate not yet passed.
    TimeGateViolation {
        requested: Layer,
        earliest: DateTime<Utc>,
        now: DateTime<Utc>,
    },

    /// Insufficient budget.
    BudgetExceeded { needed: u64, remaining: u64 },

    /// Maximum steps exceeded.
    StepsExceeded { current: u64, max: u64 },

    /// Mutation not permitted in scope.
    MutationNotAllowed,

    /// Snapshot too stale.
    SnapshotTooStale { age_secs: u64, max_age_secs: u64 },

    /// Path not within allowed roots.
    PathNotAllowed { path: PathBuf },

    /// Invalid arguments.
    InvalidArgs { message: String },

    /// Apply requires valid proposal reference.
    MissingProposalRef,

    /// Proposal not found in ledger.
    ProposalNotFound { hash_hex: String },

    /// Proposal snapshot doesn't match current state.
    ProposalSnapshotMismatch,
}

impl RejectReason {
    /// Get a human-readable description.
    pub fn description(&self) -> String {
        match self {
            Self::UnknownTool { tool_id } => format!("Unknown tool: {}", tool_id),
            Self::ScopeExpired { expired_at } => format!("Scope expired at {}", expired_at),
            Self::ToolNotAllowed { tool_id } => format!("Tool not allowed in scope: {}", tool_id),
            Self::LayerViolation {
                frontier,
                requested,
                ..
            } => format!(
                "Layer violation: at {} but requested {}",
                frontier, requested
            ),
            Self::TimeGateViolation {
                requested,
                earliest,
                now,
            } => format!(
                "Time gate: {} not accessible until {} (now: {})",
                requested, earliest, now
            ),
            Self::BudgetExceeded { needed, remaining } => {
                format!("Budget exceeded: need {} but have {}", needed, remaining)
            }
            Self::StepsExceeded { current, max } => {
                format!("Steps exceeded: {} of {} max", current, max)
            }
            Self::MutationNotAllowed => "Mutation not permitted in scope".into(),
            Self::SnapshotTooStale {
                age_secs,
                max_age_secs,
            } => format!(
                "Snapshot too stale: {}s old, max {}s",
                age_secs, max_age_secs
            ),
            Self::PathNotAllowed { path } => format!("Path not allowed: {:?}", path),
            Self::InvalidArgs { message } => format!("Invalid arguments: {}", message),
            Self::MissingProposalRef => "Apply layer requires proposal reference".into(),
            Self::ProposalNotFound { hash_hex } => format!("Proposal not found: {}", hash_hex),
            Self::ProposalSnapshotMismatch => "Proposal snapshot doesn't match current state".into(),
        }
    }
}

impl std::fmt::Display for RejectReason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.description())
    }
}

impl std::error::Error for RejectReason {}

/// Check if a proposed call is admissible.
///
/// This is the central enforcement point. Every rule is checked here.
///
/// # Rules Checked
///
/// 1. Scope validity (not expired)
/// 2. Tool allowed in scope
/// 3. Layer within scope
/// 4. Layer rule (frontier or frontier+1)
/// 5. Time gate (minimum delay elapsed)
/// 6. Budget bound (cost within limit)
/// 7. Monotone step (no loops)
/// 8. Mutation permissions
/// 9. Snapshot freshness
/// 10. Path permission (if applicable)
/// 11. Argument validation
/// 12. Proposal reference (for Apply layer)
pub fn check_admissibility(
    syscall: &dyn Syscall,
    call: &ProposedCall,
    state: &KernelState,
    ledger: &Ledger,
    now: DateTime<Utc>,
) -> Result<(), RejectReason> {
    // 1. Scope validity
    if !call.scope.is_valid(now) {
        return Err(RejectReason::ScopeExpired {
            expired_at: call.scope.expires_at,
        });
    }

    // 2. Tool allowed in scope
    if !call.scope.allows_tool(&call.tool_id) {
        return Err(RejectReason::ToolNotAllowed {
            tool_id: call.tool_id.clone(),
        });
    }

    // 3. Layer within scope
    let requested = syscall.layer();
    if !call.scope.allows_layer(requested) {
        return Err(RejectReason::LayerViolation {
            frontier: state.frontier,
            requested,
            max_allowed: call.scope.allowed_layers.max,
        });
    }

    // 4. Layer rule: frontier or frontier+1
    if !state.frontier.can_transition_to(requested) {
        return Err(RejectReason::LayerViolation {
            frontier: state.frontier,
            requested,
            max_allowed: call.scope.allowed_layers.max,
        });
    }

    // 5. Time gate for layer transition
    if requested > state.frontier {
        if !state.time_gates.is_accessible(requested, now) {
            let earliest = state
                .time_gates
                .get_gate(requested)
                .unwrap_or(now);
            return Err(RejectReason::TimeGateViolation {
                requested,
                earliest,
                now,
            });
        }
    }

    // 6. Budget check
    let needed = syscall.cost().worst_case_units;
    if !state.budget.can_afford(needed) {
        return Err(RejectReason::BudgetExceeded {
            needed,
            remaining: state.budget.remaining_units,
        });
    }

    // 7. Monotone step check (no loops)
    if state.monotone_step >= state.max_steps {
        return Err(RejectReason::StepsExceeded {
            current: state.monotone_step,
            max: state.max_steps,
        });
    }

    // 8. Mutation permission
    let mutability = syscall.mutability();
    if mutability.requires_mutation_permission() && !call.scope.can_mutate {
        return Err(RejectReason::MutationNotAllowed);
    }

    // 9. Snapshot freshness
    if let Some(max_age) = syscall.max_snapshot_age() {
        let age = now.signed_duration_since(call.proposed_at);
        let age_duration = age.to_std().unwrap_or(Duration::MAX);
        if age_duration > max_age {
            return Err(RejectReason::SnapshotTooStale {
                age_secs: age_duration.as_secs(),
                max_age_secs: max_age.as_secs(),
            });
        }
    }

    // 10. Path permission (if applicable)
    if let Some(path) = extract_path_from_args(&call.args) {
        if !call.scope.allows_path(&path) {
            return Err(RejectReason::PathNotAllowed { path });
        }
    }

    // 11. Argument validation
    syscall
        .validate_args(&call.args)
        .map_err(|e| RejectReason::InvalidArgs {
            message: e.to_string(),
        })?;

    // 12. Proposal reference for Apply layer
    if syscall.layer() >= Layer::APPLY && !mutability.is_read_only() {
        if let Some(ref proposal_ref) = call.proposal_ref {
            // Verify proposal exists in ledger
            if !ledger.has_proposal(&proposal_ref.proposal_hash) {
                return Err(RejectReason::ProposalNotFound {
                    hash_hex: hex::encode(proposal_ref.proposal_hash),
                });
            }
            // Verify snapshot matches (with tolerance)
            if !proposal_ref.proposal_snapshot.matches(&state.current_snapshot) {
                // Allow some tolerance - just check they're both non-zero
                if proposal_ref.proposal_snapshot != SnapshotId::zero()
                    && state.current_snapshot != SnapshotId::zero()
                {
                    return Err(RejectReason::ProposalSnapshotMismatch);
                }
            }
        } else if mutability != Mutability::ProposeOnly && mutability != Mutability::ReadOnly {
            return Err(RejectReason::MissingProposalRef);
        }
    }

    Ok(())
}

/// Helper to extract path from common argument patterns.
fn extract_path_from_args(args: &serde_json::Value) -> Option<PathBuf> {
    args.get("path")
        .and_then(|v| v.as_str())
        .map(PathBuf::from)
        .or_else(|| {
            args.get("file")
                .and_then(|v| v.as_str())
                .map(PathBuf::from)
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{CostModel, LayerRange, ScopeToken};
    use async_trait::async_trait;
    use uuid::Uuid;

    struct MockSyscall {
        layer: Layer,
        mutability: Mutability,
        cost: CostModel,
    }

    #[async_trait]
    impl Syscall for MockSyscall {
        fn id(&self) -> &'static str {
            "mock.syscall"
        }

        fn layer(&self) -> Layer {
            self.layer
        }

        fn mutability(&self) -> Mutability {
            self.mutability
        }

        fn cost(&self) -> CostModel {
            self.cost.clone()
        }

        fn validate_args(&self, _args: &serde_json::Value) -> anyhow::Result<()> {
            Ok(())
        }

        async fn execute(
            &self,
            _args: serde_json::Value,
            _ctx: crate::syscalls::SyscallContext<'_>,
        ) -> anyhow::Result<crate::types::ToolOutput> {
            Ok(crate::types::ToolOutput::default())
        }
    }

    fn create_test_scope() -> ScopeToken {
        let mut scope = ScopeToken::new(Uuid::new_v4(), None);
        scope.allowed_tools = vec!["mock.syscall".into()];
        scope.allowed_layers = LayerRange::standard();
        scope.can_mutate = false;
        scope
    }

    fn create_test_state() -> KernelState {
        KernelState::new()
    }

    fn create_test_ledger() -> Ledger {
        Ledger::in_memory()
    }

    #[test]
    fn test_admissibility_valid_call() {
        let syscall = MockSyscall {
            layer: Layer::OBSERVE,
            mutability: Mutability::ReadOnly,
            cost: CostModel::cheap(),
        };
        let scope = create_test_scope();
        let state = create_test_state();
        let ledger = create_test_ledger();
        let call = ProposedCall::new("mock.syscall", serde_json::json!({}), scope);
        let now = Utc::now();

        let result = check_admissibility(&syscall, &call, &state, &ledger, now);
        assert!(result.is_ok());
    }

    #[test]
    fn test_admissibility_expired_scope() {
        let syscall = MockSyscall {
            layer: Layer::OBSERVE,
            mutability: Mutability::ReadOnly,
            cost: CostModel::cheap(),
        };
        let mut scope = create_test_scope();
        scope.expires_at = Utc::now() - chrono::Duration::hours(1);
        let state = create_test_state();
        let ledger = create_test_ledger();
        let call = ProposedCall::new("mock.syscall", serde_json::json!({}), scope);
        let now = Utc::now();

        let result = check_admissibility(&syscall, &call, &state, &ledger, now);
        assert!(matches!(result, Err(RejectReason::ScopeExpired { .. })));
    }

    #[test]
    fn test_admissibility_layer_violation() {
        let syscall = MockSyscall {
            layer: Layer::STRUCTURE, // L2
            mutability: Mutability::ProposeOnly,
            cost: CostModel::cheap(),
        };
        let scope = create_test_scope();
        let state = create_test_state(); // frontier at L0
        let ledger = create_test_ledger();
        let call = ProposedCall::new("mock.syscall", serde_json::json!({}), scope);
        let now = Utc::now();

        // Can't jump from L0 to L2 directly
        let result = check_admissibility(&syscall, &call, &state, &ledger, now);
        assert!(matches!(result, Err(RejectReason::LayerViolation { .. })));
    }

    #[test]
    fn test_admissibility_mutation_not_allowed() {
        let syscall = MockSyscall {
            layer: Layer::OBSERVE,
            mutability: Mutability::Reversible,
            cost: CostModel::cheap(),
        };
        let scope = create_test_scope(); // can_mutate is false
        let state = create_test_state();
        let ledger = create_test_ledger();
        let call = ProposedCall::new("mock.syscall", serde_json::json!({}), scope);
        let now = Utc::now();

        let result = check_admissibility(&syscall, &call, &state, &ledger, now);
        assert!(matches!(result, Err(RejectReason::MutationNotAllowed)));
    }
}

