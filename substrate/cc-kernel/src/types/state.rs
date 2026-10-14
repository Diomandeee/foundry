//! Kernel execution state.

use super::{Layer, SnapshotId};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// The execution state maintained by the Kernel.
///
/// This is the "physics" of the system - it determines what is
/// currently admissible.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct KernelState {
    /// Current frontier layer (max layer that has been executed).
    pub frontier: Layer,

    /// Time gates for layer transitions.
    pub time_gates: TimeGates,

    /// Remaining compute budget.
    pub budget: Budget,

    /// Monotone step counter (prevents loops).
    pub monotone_step: u64,

    /// Maximum allowed steps.
    pub max_steps: u64,

    /// Current snapshot of world state.
    pub current_snapshot: SnapshotId,

    /// Kernel start time.
    pub started_at: DateTime<Utc>,
}

impl KernelState {
    /// Create a new kernel state with defaults.
    pub fn new() -> Self {
        Self {
            frontier: Layer::OBSERVE,
            time_gates: TimeGates::default(),
            budget: Budget::new(100_000),
            monotone_step: 0,
            max_steps: 10_000,
            current_snapshot: SnapshotId::zero(),
            started_at: Utc::now(),
        }
    }

    /// Create with custom budget.
    pub fn with_budget(budget_units: u64) -> Self {
        Self {
            budget: Budget::new(budget_units),
            ..Self::new()
        }
    }

    /// Check if we can still make steps.
    pub fn can_step(&self) -> bool {
        self.monotone_step < self.max_steps
    }

    /// Increment the monotone step.
    pub fn step(&mut self) {
        self.monotone_step += 1;
    }

    /// Update the frontier and set time gate for next layer.
    pub fn advance_to(&mut self, layer: Layer) {
        if layer > self.frontier {
            self.frontier = layer;
            // Set time gate for next layer
            let next = Layer(layer.0 + 1);
            let gate_duration = next.time_gate();
            let earliest = Utc::now()
                + chrono::Duration::from_std(gate_duration).unwrap_or(chrono::Duration::zero());
            self.time_gates.set_gate(next, earliest);
        }
    }
}

impl Default for KernelState {
    fn default() -> Self {
        Self::new()
    }
}

/// Time gates tracking when each layer becomes accessible.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct TimeGates {
    /// For each layer, the earliest time it may be entered.
    pub earliest_enter: HashMap<Layer, DateTime<Utc>>,
}

impl TimeGates {
    /// Check if a layer is currently accessible.
    pub fn is_accessible(&self, layer: Layer, now: DateTime<Utc>) -> bool {
        self.earliest_enter
            .get(&layer)
            .map(|&earliest| now >= earliest)
            .unwrap_or(true)
    }

    /// Set the time gate for a layer.
    pub fn set_gate(&mut self, layer: Layer, earliest: DateTime<Utc>) {
        self.earliest_enter.insert(layer, earliest);
    }

    /// Get the earliest time a layer can be entered.
    pub fn get_gate(&self, layer: Layer) -> Option<DateTime<Utc>> {
        self.earliest_enter.get(&layer).copied()
    }
}

/// Compute budget tracking.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Budget {
    /// Total units allocated.
    pub total_units: u64,

    /// Remaining units.
    pub remaining_units: u64,

    /// Units consumed.
    pub consumed_units: u64,
}

impl Budget {
    /// Create a new budget with the given total.
    pub fn new(total: u64) -> Self {
        Self {
            total_units: total,
            remaining_units: total,
            consumed_units: 0,
        }
    }

    /// Consume units from the budget.
    ///
    /// Returns true if successful, false if insufficient budget.
    pub fn consume(&mut self, units: u64) -> bool {
        if units <= self.remaining_units {
            self.remaining_units -= units;
            self.consumed_units += units;
            true
        } else {
            false
        }
    }

    /// Check if we can afford a cost.
    pub fn can_afford(&self, units: u64) -> bool {
        units <= self.remaining_units
    }

    /// Get the percentage of budget consumed.
    pub fn consumed_percent(&self) -> f64 {
        if self.total_units == 0 {
            0.0
        } else {
            (self.consumed_units as f64 / self.total_units as f64) * 100.0
        }
    }
}

impl Default for Budget {
    fn default() -> Self {
        Self::new(100_000)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_kernel_state_step() {
        let mut state = KernelState::new();
        assert!(state.can_step());

        state.step();
        assert_eq!(state.monotone_step, 1);
    }

    #[test]
    fn test_budget_consume() {
        let mut budget = Budget::new(100);
        assert!(budget.can_afford(50));
        assert!(budget.consume(50));
        assert!(!budget.can_afford(60));
        assert_eq!(budget.consumed_percent(), 50.0);
    }

    #[test]
    fn test_time_gates() {
        let mut gates = TimeGates::default();
        let now = Utc::now();
        let future = now + chrono::Duration::hours(1);

        gates.set_gate(Layer::INTERPRET, future);
        assert!(!gates.is_accessible(Layer::INTERPRET, now));
        assert!(gates.is_accessible(Layer::INTERPRET, future));
    }
}

