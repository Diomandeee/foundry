//! Syscall trait and registry.

mod registry;
mod l0_observe;
mod l1_interpret;
mod l2_structure;
mod l3_apply;
mod l4_transform;

pub use registry::SyscallRegistry;
pub use l0_observe::*;
pub use l1_interpret::*;
pub use l2_structure::*;
pub use l3_apply::*;
pub use l4_transform::*;

use crate::services::KernelServices;
use crate::types::{CostModel, KernelState, Layer, Mutability, ScopeToken, SnapshotId, ToolOutput};
use async_trait::async_trait;
use std::time::Duration;

/// Context provided to syscall execution.
pub struct SyscallContext<'a> {
    /// Current time.
    pub now: chrono::DateTime<chrono::Utc>,

    /// Kernel state snapshot.
    pub state: &'a KernelState,

    /// Access to kernel services (fs, db, rag).
    pub services: &'a KernelServices,

    /// The scope token authorizing this call.
    pub scope: &'a ScopeToken,

    /// The snapshot this call was proposed against.
    pub snapshot: &'a SnapshotId,
}

/// The core trait that all syscalls must implement.
#[async_trait]
pub trait Syscall: Send + Sync {
    /// Unique identifier for this syscall.
    fn id(&self) -> &'static str;

    /// Layer this syscall belongs to.
    fn layer(&self) -> Layer;

    /// Mutability classification.
    fn mutability(&self) -> Mutability;

    /// Cost model.
    fn cost(&self) -> CostModel;

    /// Maximum allowed snapshot age (None = no staleness check).
    fn max_snapshot_age(&self) -> Option<Duration> {
        Some(Duration::from_secs(10))
    }

    /// Validate arguments before execution.
    fn validate_args(&self, args: &serde_json::Value) -> anyhow::Result<()>;

    /// Execute the syscall.
    async fn execute(
        &self,
        args: serde_json::Value,
        ctx: SyscallContext<'_>,
    ) -> anyhow::Result<ToolOutput>;

    /// Generate rollback data (for reversible syscalls).
    fn rollback_data(
        &self,
        _args: &serde_json::Value,
        _output: &ToolOutput,
    ) -> Option<Vec<u8>> {
        None
    }
}

/// Macro to help define simple syscalls.
#[macro_export]
macro_rules! define_syscall {
    (
        $name:ident,
        id = $id:literal,
        layer = $layer:expr,
        mutability = $mutability:expr,
        cost = $cost:expr,
        $(max_age = $max_age:expr,)?
        validate = $validate:expr,
        execute = $execute:expr
        $(,)?
    ) => {
        pub struct $name;

        #[async_trait::async_trait]
        impl $crate::syscalls::Syscall for $name {
            fn id(&self) -> &'static str {
                $id
            }

            fn layer(&self) -> $crate::types::Layer {
                $layer
            }

            fn mutability(&self) -> $crate::types::Mutability {
                $mutability
            }

            fn cost(&self) -> $crate::types::CostModel {
                $cost
            }

            $(
            fn max_snapshot_age(&self) -> Option<std::time::Duration> {
                $max_age
            }
            )?

            fn validate_args(&self, args: &serde_json::Value) -> anyhow::Result<()> {
                $validate(args)
            }

            async fn execute(
                &self,
                args: serde_json::Value,
                ctx: $crate::syscalls::SyscallContext<'_>,
            ) -> anyhow::Result<$crate::types::ToolOutput> {
                $execute(args, ctx).await
            }
        }
    };
}

