//! The SMART Kernel - execution authority for TrajectoryOS.

use crate::admissibility::{check_admissibility, RejectReason};
use crate::ledger::Ledger;
use crate::services::KernelServices;
use crate::syscalls::{SyscallContext, SyscallRegistry};
use crate::types::{KernelState, ProposedCall, SnapshotId, ToolReceipt};
use chrono::Utc;
use parking_lot::RwLock;
use std::sync::Arc;

/// Configuration for the Kernel.
#[derive(Clone, Debug)]
pub struct KernelConfig {
    /// Initial budget in compute units.
    pub budget_units: u64,

    /// Maximum steps per session.
    pub max_steps: u64,

    /// Whether to enable metrics.
    pub enable_metrics: bool,
}

impl Default for KernelConfig {
    fn default() -> Self {
        Self {
            budget_units: 100_000,
            max_steps: 10_000,
            enable_metrics: true,
        }
    }
}

/// The SMART Kernel - execution authority for TrajectoryOS.
///
/// The Kernel is the ONLY component that can commit changes to the world.
/// It enforces all admissibility rules before executing any syscall.
pub struct Kernel {
    /// Current execution state.
    state: RwLock<KernelState>,

    /// Registered syscalls.
    syscalls: SyscallRegistry,

    /// Append-only ledger.
    ledger: Arc<Ledger>,

    /// Services (fs, db, rag, artifacts).
    services: Arc<KernelServices>,

    /// Configuration.
    config: KernelConfig,
}

impl Kernel {
    /// Create a new Kernel with default syscalls and mock services.
    pub fn new(config: KernelConfig) -> Self {
        Self {
            state: RwLock::new(KernelState::with_budget(config.budget_units)),
            syscalls: SyscallRegistry::with_defaults(),
            ledger: Arc::new(Ledger::in_memory()),
            services: Arc::new(KernelServices::mock()),
            config,
        }
    }

    /// Create a Kernel with custom services.
    pub fn with_services(config: KernelConfig, services: Arc<KernelServices>) -> Self {
        Self {
            state: RwLock::new(KernelState::with_budget(config.budget_units)),
            syscalls: SyscallRegistry::with_defaults(),
            ledger: Arc::new(Ledger::in_memory()),
            services,
            config,
        }
    }

    /// Create a Kernel with custom ledger and services.
    pub fn with_ledger_and_services(
        config: KernelConfig,
        ledger: Arc<Ledger>,
        services: Arc<KernelServices>,
    ) -> Self {
        Self {
            state: RwLock::new(KernelState::with_budget(config.budget_units)),
            syscalls: SyscallRegistry::with_defaults(),
            ledger,
            services,
            config,
        }
    }

    /// Submit a proposed call for execution.
    ///
    /// This is the main entry point for tool execution. The Kernel will:
    /// 1. Look up the syscall
    /// 2. Check admissibility
    /// 3. Execute the syscall
    /// 4. Write to the ledger
    /// 5. Return a receipt
    pub async fn submit(&self, call: ProposedCall) -> Result<ToolReceipt, RejectReason> {
        let now = Utc::now();

        // Get syscall
        let syscall = self.syscalls.get(&call.tool_id).ok_or_else(|| {
            RejectReason::UnknownTool {
                tool_id: call.tool_id.clone(),
            }
        })?;

        // Check admissibility (under read lock)
        {
            let state = self.state.read();
            check_admissibility(
                syscall.as_ref(),
                &call,
                &state,
                &self.ledger,
                now,
            )?;
        }

        // Execute (under write lock for state mutation)
        let mut state = self.state.write();

        // Re-check admissibility to avoid races
        check_admissibility(
            syscall.as_ref(),
            &call,
            &state,
            &self.ledger,
            now,
        )?;

        let accepted_at = Utc::now();

        // Reserve budget
        let cost = syscall.cost().worst_case_units;
        if !state.budget.consume(cost) {
            return Err(RejectReason::BudgetExceeded {
                needed: cost,
                remaining: state.budget.remaining_units,
            });
        }

        // Increment monotone step
        state.step();

        // Update frontier if moving up
        let requested = syscall.layer();
        state.advance_to(requested);

        let input_snapshot = state.current_snapshot.clone();

        // Execute syscall
        let ctx = SyscallContext {
            now,
            state: &state,
            services: &self.services,
            scope: &call.scope,
            snapshot: &call.snapshot,
        };

        let output = syscall
            .execute(call.args.clone(), ctx)
            .await
            .map_err(|e| RejectReason::InvalidArgs {
                message: e.to_string(),
            })?;

        let completed_at = Utc::now();

        // Compute new snapshot (simplified - in practice this would hash affected state)
        let output_snapshot = SnapshotId::from_bytes(
            &serde_json::to_vec(&output).unwrap_or_default(),
        );
        state.current_snapshot = output_snapshot.clone();

        // Write to ledger
        let seq = self
            .ledger
            .append(
                &call,
                syscall.as_ref(),
                &output,
                &input_snapshot,
                &output_snapshot,
                cost,
                accepted_at,
                completed_at,
            )
            .await
            .map_err(|e| RejectReason::InvalidArgs {
                message: format!("Ledger error: {}", e),
            })?;

        // Update metrics if enabled
        if self.config.enable_metrics {
            metrics::counter!("kernel_calls_accepted_total").increment(1);
            metrics::counter!("kernel_cost_consumed_total").increment(cost);
            metrics::gauge!("kernel_frontier_layer").set(state.frontier.0 as f64);
            metrics::gauge!("kernel_budget_remaining").set(state.budget.remaining_units as f64);
        }

        Ok(ToolReceipt {
            call_id: call.call_id,
            accepted_at,
            completed_at,
            ledger_seq: seq,
            output,
            cost_consumed: cost,
            new_snapshot: output_snapshot,
        })
    }

    /// Get currently admissible tools.
    ///
    /// Returns the list of tool IDs that could be called right now
    /// given the current state.
    pub fn get_enabled_tools(&self) -> Vec<String> {
        let state = self.state.read();
        let now = Utc::now();

        self.syscalls
            .all()
            .filter(|syscall| {
                let layer = syscall.layer();
                state.frontier.can_transition_to(layer)
                    && state.time_gates.is_accessible(layer, now)
                    && state.budget.can_afford(syscall.cost().worst_case_units)
            })
            .map(|s| s.id().to_string())
            .collect()
    }

    /// Get the current kernel state (snapshot).
    pub fn state(&self) -> KernelState {
        self.state.read().clone()
    }

    /// Get the current ledger sequence.
    pub fn ledger_seq(&self) -> u64 {
        self.ledger.current_seq()
    }

    /// Get the syscall registry.
    pub fn syscalls(&self) -> &SyscallRegistry {
        &self.syscalls
    }

    /// Reset the kernel state (for testing).
    pub fn reset(&self) {
        *self.state.write() = KernelState::with_budget(self.config.budget_units);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{LayerRange, ScopeToken};
    use uuid::Uuid;

    fn create_test_kernel() -> Kernel {
        Kernel::new(KernelConfig::default())
    }

    fn create_test_scope() -> ScopeToken {
        let mut scope = ScopeToken::new(Uuid::new_v4(), None);
        scope.allowed_layers = LayerRange::standard();
        scope.can_mutate = false;
        scope
    }

    #[tokio::test]
    async fn test_kernel_submit_valid_call() {
        let kernel = create_test_kernel();
        let scope = create_test_scope();
        let call = ProposedCall::new("fs.scan", serde_json::json!({"path": "/tmp"}), scope);

        let result = kernel.submit(call).await;
        assert!(result.is_ok());

        let receipt = result.unwrap();
        assert_eq!(receipt.ledger_seq, 1);
    }

    #[tokio::test]
    async fn test_kernel_submit_unknown_tool() {
        let kernel = create_test_kernel();
        let scope = create_test_scope();
        let call = ProposedCall::new("unknown.tool", serde_json::json!({}), scope);

        let result = kernel.submit(call).await;
        assert!(matches!(result, Err(RejectReason::UnknownTool { .. })));
    }

    #[tokio::test]
    async fn test_kernel_get_enabled_tools() {
        let kernel = create_test_kernel();
        let enabled = kernel.get_enabled_tools();

        // Should have L0 and L1 tools enabled initially
        assert!(enabled.contains(&"fs.scan".to_string()));
        assert!(enabled.contains(&"rag.search".to_string()));
    }

    #[tokio::test]
    async fn test_kernel_state_progression() {
        let kernel = create_test_kernel();

        // Initial state
        let state1 = kernel.state();
        assert_eq!(state1.monotone_step, 0);

        // Submit a call
        let scope = create_test_scope();
        let call = ProposedCall::new("fs.scan", serde_json::json!({"path": "/tmp"}), scope);
        kernel.submit(call).await.unwrap();

        // State should have progressed
        let state2 = kernel.state();
        assert_eq!(state2.monotone_step, 1);
        assert!(state2.budget.consumed_units > 0);
    }
}

