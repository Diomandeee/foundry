//! Integration tests for the SMART Kernel.
//!
//! This tests the full flow: scope -> propose -> execute -> receipt

use cc_kernel::{
    Kernel, KernelConfig,
    FunctionCallParser, FunctionGemmaRuntime,
    functiongemma::ToolSchema,
    types::{LayerRange, ProposedCall, ScopeToken, SnapshotId},
};
use uuid::Uuid;

/// Helper to create a test scope token.
fn test_scope() -> ScopeToken {
    let mut scope = ScopeToken::new(Uuid::new_v4(), Some(Uuid::new_v4()));
    scope.allowed_layers = LayerRange::standard();
    scope.can_mutate = false;
    scope
}

/// Helper to create tool schemas for testing.
fn test_tools() -> Vec<ToolSchema> {
    vec![
        ToolSchema::new("fs.scan", "Recursively scan a directory for files").with_parameters(
            serde_json::json!({
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Directory to scan"}
                },
                "required": ["path"]
            }),
        ),
        ToolSchema::new("fs.hash", "Compute cryptographic hash of a file").with_parameters(
            serde_json::json!({
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "File to hash"}
                },
                "required": ["path"]
            }),
        ),
        ToolSchema::new("rag.search", "Search the memory fabric").with_parameters(
            serde_json::json!({
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Search query"},
                    "limit": {"type": "integer", "description": "Max results"}
                },
                "required": ["query"]
            }),
        ),
    ]
}

#[tokio::test]
async fn test_full_pipeline_scope_to_receipt() {
    // 1. Create a scope token (simulates Orbit issuing a token)
    let scope = test_scope();
    assert!(scope.allows_layer(cc_kernel::types::Layer::OBSERVE));
    assert!(scope.allows_layer(cc_kernel::types::Layer::INTERPRET));

    // 2. Create FunctionGemma runtime and propose a call
    let runtime = FunctionGemmaRuntime::mock();
    let tools = test_tools();

    let parsed_call = runtime
        .propose(&tools, None, "List all files in /tmp")
        .await
        .expect("Should propose a function call");

    assert_eq!(parsed_call.name, "fs.scan");

    // 3. Convert to ProposedCall
    let proposed = FunctionCallParser::to_proposed_call(
        &parsed_call,
        scope,
        SnapshotId::zero(),
    );

    assert_eq!(proposed.tool_id, "fs.scan");

    // 4. Submit to Kernel
    let kernel = Kernel::new(KernelConfig::default());
    let receipt = kernel.submit(proposed).await.expect("Should execute");

    // 5. Verify receipt
    assert_eq!(receipt.ledger_seq, 1);
    assert!(receipt.cost_consumed > 0);
    assert!(receipt.output.summary.is_some());

    // 6. Verify kernel state progressed
    let state = kernel.state();
    assert_eq!(state.monotone_step, 1);
}

#[tokio::test]
async fn test_multi_step_execution() {
    let kernel = Kernel::new(KernelConfig::default());
    let scope = test_scope();

    // Execute multiple L0 calls
    for i in 0..3 {
        let call = ProposedCall::new(
            "fs.scan",
            serde_json::json!({"path": format!("/dir{}", i)}),
            scope.clone(),
        );
        let receipt = kernel.submit(call).await.expect("Should execute");
        assert_eq!(receipt.ledger_seq, i as u64 + 1);
    }

    // Verify state
    let state = kernel.state();
    assert_eq!(state.monotone_step, 3);
    assert!(state.budget.consumed_units > 0);
}

#[tokio::test]
async fn test_layer_progression() {
    let kernel = Kernel::new(KernelConfig::default());
    let mut scope = test_scope();
    scope.can_mutate = false; // Only read operations

    // Start at L0
    let l0_call = ProposedCall::new(
        "fs.scan",
        serde_json::json!({"path": "/tmp"}),
        scope.clone(),
    );
    kernel.submit(l0_call).await.expect("L0 should work");

    // Move to L1
    let l1_call = ProposedCall::new(
        "embed.compute",
        serde_json::json!({"text": "test"}),
        scope.clone(),
    );
    kernel.submit(l1_call).await.expect("L1 should work");

    // Verify frontier advanced
    let state = kernel.state();
    assert_eq!(state.frontier, cc_kernel::types::Layer::INTERPRET);
}

#[tokio::test]
async fn test_rejection_unknown_tool() {
    let kernel = Kernel::new(KernelConfig::default());
    let scope = test_scope();

    let call = ProposedCall::new(
        "unknown.tool",
        serde_json::json!({}),
        scope,
    );

    let result = kernel.submit(call).await;
    assert!(matches!(
        result,
        Err(cc_kernel::admissibility::RejectReason::UnknownTool { .. })
    ));
}

#[tokio::test]
async fn test_rejection_expired_scope() {
    let kernel = Kernel::new(KernelConfig::default());
    let mut scope = test_scope();
    scope.expires_at = chrono::Utc::now() - chrono::Duration::hours(1);

    let call = ProposedCall::new(
        "fs.scan",
        serde_json::json!({"path": "/tmp"}),
        scope,
    );

    let result = kernel.submit(call).await;
    assert!(matches!(
        result,
        Err(cc_kernel::admissibility::RejectReason::ScopeExpired { .. })
    ));
}

#[tokio::test]
async fn test_rejection_layer_violation() {
    let kernel = Kernel::new(KernelConfig::default());
    let scope = test_scope();

    // Try to jump from L0 directly to L2 (Structure)
    let call = ProposedCall::new(
        "propose.patch",
        serde_json::json!({"file": "test.rs", "diff": "--- a\n+++ b"}),
        scope,
    );

    let result = kernel.submit(call).await;
    assert!(matches!(
        result,
        Err(cc_kernel::admissibility::RejectReason::LayerViolation { .. })
    ));
}

#[tokio::test]
async fn test_enabled_tools() {
    let kernel = Kernel::new(KernelConfig::default());

    // Initially, L0 and L1 tools should be enabled
    let enabled = kernel.get_enabled_tools();
    assert!(enabled.contains(&"fs.scan".to_string()));
    assert!(enabled.contains(&"rag.search".to_string()));
    assert!(enabled.contains(&"embed.compute".to_string()));
}

#[tokio::test]
async fn test_function_call_parsing() {
    let output = r#"<start_of_turn>model
Based on your request, I'll scan the directory.
<start_function_call>
{"name": "fs.scan", "args": {"path": "/home/user/docs", "max_depth": 3}}
<end_function_call>
<end_of_turn>"#;

    let parsed = FunctionCallParser::parse(output).expect("Should parse");
    assert_eq!(parsed.name, "fs.scan");
    assert_eq!(parsed.args["path"], "/home/user/docs");
    assert_eq!(parsed.args["max_depth"], 3);
}

#[tokio::test]
async fn test_conversation_flow() {
    let runtime = FunctionGemmaRuntime::mock();
    let tools = test_tools();

    let result = runtime
        .run_conversation(
            &tools,
            Some("You are helping organize a project."),
            "Find all files in the project",
            |call| {
                // Mock execution
                Ok(serde_json::json!({
                    "tool": call.name,
                    "status": "success",
                    "files": ["/project/src/main.rs", "/project/Cargo.toml"]
                }))
            },
            5,
        )
        .await
        .expect("Conversation should work");

    assert!(!result.turns.is_empty());
    assert!(result.turns[0].function_call.is_some());
    assert!(result.turns[0].function_result.is_some());
}

#[tokio::test]
async fn test_ledger_integrity() {
    let kernel = Kernel::new(KernelConfig::default());
    let scope = test_scope();

    // Execute several calls
    for _ in 0..5 {
        let call = ProposedCall::new(
            "fs.scan",
            serde_json::json!({"path": "/tmp"}),
            scope.clone(),
        );
        kernel.submit(call).await.unwrap();
    }

    // Verify ledger sequence
    assert_eq!(kernel.ledger_seq(), 5);
}

#[tokio::test]
async fn test_budget_tracking() {
    let config = KernelConfig {
        budget_units: 500, // Small budget
        ..Default::default()
    };
    let kernel = Kernel::new(config);
    let scope = test_scope();

    // Execute calls until budget is exhausted
    let mut executed = 0;
    for _ in 0..20 {
        let call = ProposedCall::new(
            "fs.scan",
            serde_json::json!({"path": "/tmp"}),
            scope.clone(),
        );
        match kernel.submit(call).await {
            Ok(_) => executed += 1,
            Err(cc_kernel::admissibility::RejectReason::BudgetExceeded { .. }) => break,
            Err(e) => panic!("Unexpected error: {:?}", e),
        }
    }

    // Should have executed some calls
    assert!(executed > 0);
    // But not all 20
    assert!(executed < 20);

    // Verify budget was consumed
    let state = kernel.state();
    assert!(state.budget.consumed_units > 0);
    assert!(state.budget.remaining_units < state.budget.total_units);
}

