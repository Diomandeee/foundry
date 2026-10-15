//! Cross-language parity: the Rust reference kernel and the TypeScript port
//! execute the same case set, `fixtures/kernel-parity.json`.
//!
//! The TypeScript half is `packages/gate-ts/src/parity.test.ts`. Upstream
//! cc-kernel does not load external fixtures — this file is a Foundry addition
//! (see substrate/README.md, "Local modifications"). It exists so that the
//! claim "packages/gate-ts mirrors the Rust kernel" fails CI when it stops
//! being true, instead of living on as a comment in a source file.

use async_trait::async_trait;
use cc_kernel::types::{
    CostModel, KernelState, Layer, LayerRange, Mutability, ProposedCall, ProposalRef, ScopeToken,
};
use cc_kernel::{check_admissibility, Ledger, Syscall};
use chrono::{Duration, Utc};
use serde_json::Value;
use std::path::PathBuf;
// The trait speaks std Duration; the fixture offsets speak chrono.
use std::time::Duration as StdDuration;
use uuid::Uuid;

/// The shared case set, compiled into the test binary.
const FIXTURE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../fixtures/kernel-parity.json"
));

struct FixtureSyscall {
    layer: Layer,
    mutability: Mutability,
    cost: CostModel,
    max_age: Option<StdDuration>,
    reject_args: bool,
}

#[async_trait]
impl Syscall for FixtureSyscall {
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
    fn max_snapshot_age(&self) -> Option<StdDuration> {
        self.max_age
    }
    fn validate_args(&self, _args: &Value) -> anyhow::Result<()> {
        if self.reject_args {
            anyhow::bail!("rejected-by-fixture");
        }
        Ok(())
    }
    async fn execute(
        &self,
        _args: Value,
        _ctx: cc_kernel::SyscallContext<'_>,
    ) -> anyhow::Result<cc_kernel::ToolOutput> {
        Ok(cc_kernel::ToolOutput::default())
    }
}

fn layer(n: u64) -> Layer {
    Layer(n as u8)
}

fn mutability(name: &str) -> Mutability {
    match name {
        "read_only" => Mutability::ReadOnly,
        "propose_only" => Mutability::ProposeOnly,
        "reversible" => Mutability::Reversible,
        "irreversible" => Mutability::Irreversible,
        other => panic!("fixture names an unknown mutability: {other}"),
    }
}

fn parse_hash(hex: &str) -> [u8; 32] {
    assert_eq!(hex.len(), 64, "proposal_hash_hex must be 32 bytes");
    let mut out = [0u8; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).expect("hex");
    }
    out
}

fn json<T: serde::de::DeserializeOwned>(v: &Value, key: &str) -> T {
    serde_json::from_value(v[key].clone())
        .unwrap_or_else(|e| panic!("fixture field {key:?} did not fit: {e}"))
}

/// Run one fixture case and return the RejectReason tag, if the call was refused.
fn run_case(case: &Value, now: chrono::DateTime<Utc>) -> Result<(), String> {
    let scope_json = &case["scope"];
    let mut scope = ScopeToken::new(Uuid::new_v4(), None);
    scope.allowed_tools = json(scope_json, "tools");
    scope.can_mutate = json(scope_json, "can_mutate");
    scope.allowed_layers = LayerRange::new(
        layer(json(scope_json, "min_layer")),
        layer(json(scope_json, "max_layer")),
    );
    let roots: Vec<String> = json(scope_json, "roots");
    scope.allowed_roots = roots.iter().map(PathBuf::from).collect();

    let expired: bool = json(scope_json, "expired");
    let not_yet_valid: bool = json(scope_json, "not_yet_valid");
    scope.issued_at = now + Duration::seconds(if not_yet_valid { 60 } else { -60 });
    scope.expires_at = now + Duration::seconds(if expired { -60 } else { 3600 });

    let tool_id: String = json(case, "tool_id");
    let mut call = ProposedCall::new(tool_id, case["args"].clone(), scope);
    call.proposed_at = now + Duration::seconds(json(case, "proposed_at_offset_secs"));

    let hash_hex: Option<String> = json(case, "proposal_hash_hex");
    if let Some(hex) = hash_hex {
        call.proposal_ref = Some(ProposalRef::new(
            parse_hash(&hex),
            call.snapshot.clone(),
            0,
        ));
    }

    let layer_value = layer(json(case, "layer"));
    let max_age: Option<i64> = json(case, "max_snapshot_age_secs");

    let mut state = KernelState::new();
    state.frontier = layer(json(case, "frontier"));
    state.budget.remaining_units = json(case, "budget_remaining");
    state.monotone_step = json(case, "monotone_step");
    state.max_steps = json(case, "max_steps");

    let gate: Option<i64> = json(case, "layer_gate_offset_secs");
    if let Some(offset) = gate {
        state
            .time_gates
            .set_gate(layer_value, now + Duration::seconds(offset));
    }

    let syscall = FixtureSyscall {
        layer: layer_value,
        mutability: mutability(&json::<String>(case, "mutability")),
        cost: CostModel {
            worst_case_units: json(case, "cost_worst"),
            typical_units: 0,
            supports_estimate: false,
        },
        max_age: max_age.map(|secs| StdDuration::from_secs(secs.max(0) as u64)),
        reject_args: json(case, "reject_args"),
    };

    let ledger = Ledger::in_memory();
    match check_admissibility(&syscall, &call, &state, &ledger, now) {
        Ok(()) => Ok(()),
        Err(reason) => {
            let tag = serde_json::to_value(&reason)
                .expect("RejectReason serialises")
                .get("reason")
                .and_then(|v| v.as_str())
                .expect("RejectReason carries a `reason` tag")
                .to_string();
            Err(tag)
        }
    }
}

#[test]
fn the_fixture_is_a_real_case_set() {
    let doc: Value = serde_json::from_str(FIXTURE).expect("fixture parses");
    let cases = doc["cases"].as_array().expect("cases is an array");
    assert!(
        cases.len() >= 30,
        "expected at least 30 parity cases, found {}",
        cases.len()
    );
    // Every rule must be represented, or parity is partial and silent about it.
    for rule in [
        "rule 1", "rule 2", "rule 3", "rule 4", "rule 5", "rule 6", "rule 7", "rule 8", "rule 9",
        "rule 10", "rule 11", "rule 12",
    ] {
        assert!(
            cases
                .iter()
                .any(|c| c["name"].as_str().is_some_and(|n| n.starts_with(rule))),
            "no parity case covers {rule}"
        );
    }
}

#[test]
fn rust_kernel_matches_every_parity_case() {
    let doc: Value = serde_json::from_str(FIXTURE).expect("fixture parses");
    let now = Utc::now();
    let mut failures: Vec<String> = Vec::new();
    for case in doc["cases"].as_array().expect("cases is an array") {
        let name = case["name"].as_str().unwrap_or("<unnamed>");
        let expect_ok = case["expect"]["ok"].as_bool().expect("expect.ok");
        let expect_reason = case["expect"]["reason"].as_str().map(str::to_string);

        match (run_case(case, now), expect_ok, expect_reason) {
            (Ok(()), true, _) => {}
            (Err(tag), false, Some(want)) if tag == want => {}
            (got, _, want) => failures.push(format!(
                "{name}: expected {} {:?}, got {}",
                if expect_ok { "ok" } else { "refusal" },
                want,
                match got {
                    Ok(()) => "ok".to_string(),
                    Err(tag) => format!("refusal {tag}"),
                }
            )),
        }
    }
    assert!(
        failures.is_empty(),
        "the Rust kernel disagreed with {} parity case(s):\n  {}",
        failures.len(),
        failures.join("\n  ")
    );
}
