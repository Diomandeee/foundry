//! SMART Kernel - Stratified Monotone Action Runtime for TrajectoryOS
//!
//! The Kernel is the execution authority for TrajectoryOS. It enforces the
//! Clarity-like guarantees that make tool execution safe and auditable:
//!
//! - **Stratified**: Tools are layered by privilege (L0-L4)
//! - **Monotone**: State progression prevents loops
//! - **Action**: Focus on executable primitives
//! - **Runtime**: Always-on, non-turn-complete execution
//!
//! # Authority Model
//!
//! The Kernel is the ONLY component that can commit changes:
//! - Orbit grants capability (scope tokens)
//! - FunctionGemma proposes tool calls
//! - RAG++ advises with context
//! - **Kernel commits**
//!
//! # Example
//!
//! ```ignore
//! use cc_kernel::{Kernel, KernelConfig, ProposedCall};
//!
//! let kernel = Kernel::new(config).await?;
//!
//! // Submit a proposed call
//! let receipt = kernel.submit(proposed_call).await?;
//! println!("Committed at ledger seq: {}", receipt.ledger_seq);
//! ```

#![warn(missing_docs)]
#![deny(unsafe_code)]

pub mod types;
pub mod admissibility;
pub mod ledger;
pub mod syscalls;
pub mod functiongemma;
mod kernel;
mod services;

// Re-exports
pub use types::{
    Layer, LayerRange, Budget, TimeGates,
    ScopeToken, SnapshotId, ProposedCall, ProposalRef,
    ToolReceipt, ToolOutput, ArtifactRef,
    KernelState, CostModel, Mutability,
};
pub use admissibility::{check_admissibility, RejectReason};
pub use ledger::{Ledger, LedgerEntry, LedgerStorage};
pub use syscalls::{Syscall, SyscallContext, SyscallRegistry};
pub use kernel::{Kernel, KernelConfig};
pub use services::KernelServices;
pub use functiongemma::{
    FunctionGemmaConfig, FunctionGemmaRuntime, RuntimeBackend,
    FunctionCallParser, ParsedFunctionCall, ToolSchemaFormatter,
};

