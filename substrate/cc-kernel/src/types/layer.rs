//! Layer type for tool privilege stratification.

use serde::{Deserialize, Serialize};
use std::time::Duration;

/// Execution privilege layer (0-4).
///
/// The plus-one rule: a call at layer i can only be followed by
/// a call at layer j where j <= i + 1.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct Layer(pub u8);

impl Layer {
    /// Layer 0: Observe (read-only inspection).
    pub const OBSERVE: Layer = Layer(0);
    /// Layer 1: Interpret (summarize, cluster, propose in memory).
    pub const INTERPRET: Layer = Layer(1);
    /// Layer 2: Structure (create reversible structures).
    pub const STRUCTURE: Layer = Layer(2);
    /// Layer 3: Apply (apply reversible mutations).
    pub const APPLY: Layer = Layer(3);
    /// Layer 4: Transform (high-impact operations).
    pub const TRANSFORM: Layer = Layer(4);

    /// Check if transitioning to target layer is valid.
    pub fn can_transition_to(&self, target: Layer) -> bool {
        target.0 <= self.0 + 1
    }

    /// Get the minimum delay required before entering this layer.
    pub fn time_gate(&self) -> Duration {
        match self.0 {
            0 => Duration::ZERO,
            1 => Duration::from_secs(2),
            2 => Duration::from_secs(5),
            3 => Duration::from_secs(15),
            _ => Duration::from_secs(30),
        }
    }
}

impl Default for Layer {
    fn default() -> Self {
        Self::OBSERVE
    }
}

impl std::fmt::Display for Layer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.0 {
            0 => write!(f, "L0:Observe"),
            1 => write!(f, "L1:Interpret"),
            2 => write!(f, "L2:Structure"),
            3 => write!(f, "L3:Apply"),
            4 => write!(f, "L4:Transform"),
            n => write!(f, "L{}:Unknown", n),
        }
    }
}

/// Range of allowed layers.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LayerRange {
    /// Minimum layer allowed.
    pub min: Layer,
    /// Maximum layer allowed.
    pub max: Layer,
}

impl LayerRange {
    /// Create a new layer range.
    pub fn new(min: Layer, max: Layer) -> Self {
        Self { min, max }
    }

    /// Check if a layer is within this range.
    pub fn contains(&self, layer: Layer) -> bool {
        layer >= self.min && layer <= self.max
    }

    /// Read-only scope (L0 only).
    pub fn read_only() -> Self {
        Self {
            min: Layer::OBSERVE,
            max: Layer::OBSERVE,
        }
    }

    /// Standard scope (L0-L3).
    pub fn standard() -> Self {
        Self {
            min: Layer::OBSERVE,
            max: Layer::APPLY,
        }
    }

    /// Full scope (L0-L4).
    pub fn full() -> Self {
        Self {
            min: Layer::OBSERVE,
            max: Layer::TRANSFORM,
        }
    }
}

impl Default for LayerRange {
    fn default() -> Self {
        Self::standard()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_layer_transition() {
        assert!(Layer::OBSERVE.can_transition_to(Layer::OBSERVE));
        assert!(Layer::OBSERVE.can_transition_to(Layer::INTERPRET));
        assert!(!Layer::OBSERVE.can_transition_to(Layer::STRUCTURE));
    }

    #[test]
    fn test_layer_range() {
        let range = LayerRange::standard();
        assert!(range.contains(Layer::OBSERVE));
        assert!(range.contains(Layer::APPLY));
        assert!(!range.contains(Layer::TRANSFORM));
    }
}

