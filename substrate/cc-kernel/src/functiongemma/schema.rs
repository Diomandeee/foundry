//! Tool schema formatting for FunctionGemma.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Formatter for tool schemas in FunctionGemma format.
pub struct ToolSchemaFormatter;

impl ToolSchemaFormatter {
    /// Format a single tool schema as a FunctionGemma declaration.
    pub fn format_tool(schema: &ToolSchema) -> String {
        format!(
            "<start_function_declaration>\n{}\n<end_function_declaration>",
            serde_json::to_string_pretty(&serde_json::json!({
                "name": schema.name,
                "description": schema.description,
                "parameters": schema.parameters
            }))
            .unwrap_or_default()
        )
    }

    /// Format multiple tool schemas.
    pub fn format_tools(schemas: &[ToolSchema]) -> String {
        schemas
            .iter()
            .map(Self::format_tool)
            .collect::<Vec<_>>()
            .join("\n\n")
    }

    /// Build a complete prompt for FunctionGemma.
    pub fn build_prompt(
        tools: &[ToolSchema],
        system_context: Option<&str>,
        user_instruction: &str,
    ) -> String {
        let mut prompt = String::new();

        // Developer turn with tool declarations
        prompt.push_str("<start_of_turn>developer\n");
        if let Some(ctx) = system_context {
            prompt.push_str(ctx);
            prompt.push_str("\n\n");
        }
        prompt.push_str(&Self::format_tools(tools));
        prompt.push_str("\n<end_of_turn>\n");

        // User turn with instruction
        prompt.push_str("<start_of_turn>user\n");
        prompt.push_str(user_instruction);
        prompt.push_str("\n<end_of_turn>\n");

        // Model turn start (model will complete this)
        prompt.push_str("<start_of_turn>model\n");

        prompt
    }

    /// Build a continuation prompt with tool response.
    pub fn build_continuation(tool_response: &Value) -> String {
        format!(
            "<start_of_turn>tool\n<start_function_response>\n{}\n<end_function_response>\n<end_of_turn>\n<start_of_turn>model\n",
            serde_json::to_string_pretty(tool_response).unwrap_or_default()
        )
    }
}

/// Simplified tool schema for FunctionGemma.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ToolSchema {
    /// Tool name/identifier.
    pub name: String,
    /// Description for the model.
    pub description: String,
    /// Parameters in JSON Schema format.
    pub parameters: Value,
}

impl ToolSchema {
    /// Create a new tool schema.
    pub fn new(name: impl Into<String>, description: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            description: description.into(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {},
                "required": []
            }),
        }
    }

    /// Set parameters (builder pattern).
    pub fn with_parameters(mut self, params: Value) -> Self {
        self.parameters = params;
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_format_tool() {
        let schema = ToolSchema::new("fs.scan", "Scan a directory")
            .with_parameters(serde_json::json!({
                "type": "object",
                "properties": {
                    "path": {"type": "string"}
                },
                "required": ["path"]
            }));

        let formatted = ToolSchemaFormatter::format_tool(&schema);
        assert!(formatted.contains("<start_function_declaration>"));
        assert!(formatted.contains("fs.scan"));
        assert!(formatted.contains("<end_function_declaration>"));
    }

    #[test]
    fn test_build_prompt() {
        let tools = vec![ToolSchema::new("fs.scan", "Scan a directory")];
        let prompt = ToolSchemaFormatter::build_prompt(&tools, None, "List files in /tmp");

        assert!(prompt.contains("<start_of_turn>developer"));
        assert!(prompt.contains("<start_of_turn>user"));
        assert!(prompt.contains("List files in /tmp"));
        assert!(prompt.contains("<start_of_turn>model"));
    }
}

