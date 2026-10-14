//! FunctionGemma integration for local tool calling.
//!
//! FunctionGemma is a 270M parameter model trained specifically for function calling.
//! It uses strict control tokens to separate tool declarations, calls, and responses.
//!
//! # Architecture
//!
//! ```text
//! User Instruction + Tool Schemas
//!          │
//!          ▼
//!    FunctionGemma (local)
//!          │
//!          ▼
//!    ProposedCall (structured)
//!          │
//!          ▼
//!    Kernel (validate + execute)
//! ```
//!
//! # Control Tokens
//!
//! - `<start_of_turn>role ... <end_of_turn>` - Turn boundaries
//! - `<start_function_declaration> ... <end_function_declaration>` - Tool schemas
//! - `<start_function_call> ... <end_function_call>` - Model's tool calls
//! - `<start_function_response> ... <end_function_response>` - Tool outputs

mod schema;
mod parser;
mod runtime;

pub use schema::{ToolSchema, ToolSchemaFormatter};
pub use parser::{FunctionCallParser, ParsedFunctionCall};
pub use runtime::{FunctionGemmaConfig, FunctionGemmaRuntime, RuntimeBackend};

