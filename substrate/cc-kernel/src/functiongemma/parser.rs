//! Parser for FunctionGemma output.

use crate::types::{ProposedCall, ScopeToken, SnapshotId};
use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Parsed function call from FunctionGemma output.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ParsedFunctionCall {
    /// Function/tool name.
    pub name: String,
    /// Arguments.
    pub args: Value,
    /// Raw JSON string.
    pub raw: String,
}

/// Parser for FunctionGemma control token output.
pub struct FunctionCallParser;

impl FunctionCallParser {
    /// Parse a function call from FunctionGemma output.
    ///
    /// Extracts content between `<start_function_call>` and `<end_function_call>`.
    pub fn parse(output: &str) -> Result<ParsedFunctionCall> {
        let start_marker = "<start_function_call>";
        let end_marker = "<end_function_call>";

        let start = output
            .find(start_marker)
            .ok_or_else(|| anyhow!("No function call found in output"))?;

        let content_start = start + start_marker.len();

        let end = output[content_start..]
            .find(end_marker)
            .map(|i| content_start + i)
            .ok_or_else(|| anyhow!("Unclosed function call"))?;

        let raw = output[content_start..end].trim().to_string();

        // Parse as JSON
        let parsed: FunctionCallJson = serde_json::from_str(&raw)
            .map_err(|e| anyhow!("Failed to parse function call JSON: {}", e))?;

        Ok(ParsedFunctionCall {
            name: parsed.name,
            args: parsed.args.unwrap_or(Value::Object(serde_json::Map::new())),
            raw,
        })
    }

    /// Parse multiple function calls from output.
    pub fn parse_all(output: &str) -> Vec<ParsedFunctionCall> {
        let mut calls = Vec::new();
        let mut remaining = output;

        while let Ok(call) = Self::parse(remaining) {
            // Find where this call ended
            if let Some(pos) = remaining.find("<end_function_call>") {
                remaining = &remaining[pos + "<end_function_call>".len()..];
                calls.push(call);
            } else {
                break;
            }
        }

        calls
    }

    /// Convert a parsed call to a ProposedCall.
    pub fn to_proposed_call(
        parsed: &ParsedFunctionCall,
        scope: ScopeToken,
        snapshot: SnapshotId,
    ) -> ProposedCall {
        ProposedCall::new(&parsed.name, parsed.args.clone(), scope).with_snapshot(snapshot)
    }

    /// Check if output contains a function call.
    pub fn has_function_call(output: &str) -> bool {
        output.contains("<start_function_call>") && output.contains("<end_function_call>")
    }

    /// Check if output is a clarification request (no function call).
    pub fn is_clarification(output: &str) -> bool {
        !Self::has_function_call(output)
    }

    /// Extract natural language response (after function response).
    pub fn extract_summary(output: &str) -> Option<String> {
        // Look for text after the last end_of_turn for tool
        if let Some(pos) = output.rfind("<end_function_response>") {
            let after = &output[pos + "<end_function_response>".len()..];
            if let Some(model_start) = after.find("<start_of_turn>model") {
                let content = &after[model_start + "<start_of_turn>model".len()..];
                if let Some(end) = content.find("<end_of_turn>") {
                    let summary = content[..end].trim();
                    if !summary.is_empty() && !Self::has_function_call(summary) {
                        return Some(summary.to_string());
                    }
                }
            }
        }
        None
    }
}

#[derive(Deserialize)]
struct FunctionCallJson {
    name: String,
    args: Option<Value>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_function_call() {
        let output = r#"<start_of_turn>model
<start_function_call>
{"name": "fs.scan", "args": {"path": "/tmp"}}
<end_function_call>
<end_of_turn>"#;

        let call = FunctionCallParser::parse(output).unwrap();
        assert_eq!(call.name, "fs.scan");
        assert_eq!(call.args["path"], "/tmp");
    }

    #[test]
    fn test_parse_no_args() {
        let output = r#"<start_function_call>
{"name": "orbit.get_context"}
<end_function_call>"#;

        let call = FunctionCallParser::parse(output).unwrap();
        assert_eq!(call.name, "orbit.get_context");
        assert!(call.args.as_object().unwrap().is_empty());
    }

    #[test]
    fn test_parse_multiple_calls() {
        let output = r#"<start_function_call>
{"name": "fs.scan", "args": {"path": "/"}}
<end_function_call>
<start_function_call>
{"name": "fs.hash", "args": {"path": "/file.txt"}}
<end_function_call>"#;

        let calls = FunctionCallParser::parse_all(output);
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].name, "fs.scan");
        assert_eq!(calls[1].name, "fs.hash");
    }

    #[test]
    fn test_has_function_call() {
        let with_call = "<start_function_call>{}<end_function_call>";
        let without = "Just some text response";

        assert!(FunctionCallParser::has_function_call(with_call));
        assert!(!FunctionCallParser::has_function_call(without));
    }

    #[test]
    fn test_is_clarification() {
        let clarification = "I need more information. What directory should I scan?";
        assert!(FunctionCallParser::is_clarification(clarification));
    }
}

