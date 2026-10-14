//! Core types for the SMART Kernel.

mod layer;
mod scope;
mod snapshot;
mod call;
mod state;
mod cost;

pub use layer::{Layer, LayerRange};
pub use scope::ScopeToken;
pub use snapshot::SnapshotId;
pub use call::{ProposedCall, ProposalRef, ToolReceipt, ToolOutput, ArtifactRef};
pub use state::{KernelState, TimeGates, Budget};
pub use cost::{CostModel, Mutability};

