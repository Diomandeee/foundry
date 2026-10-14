# Reward Model

The ledger uses a six-signal reward model. Scores are bounded to `[0, 1]` and persisted into `outcome.reward_score` plus per-signal fields.

```text
reward =
  0.25 * outcome
+ 0.22 * process
+ 0.13 * efficiency
+ 0.13 * verification
+ 0.13 * consistency
+ 0.14 * motion
```

## Signals

| Signal | Weight | Measures |
|---|---:|---|
| Outcome | 0.25 | correction, redo, build success, session continuation |
| Process | 0.22 | tool success, bash cleanliness, error density, late failures |
| Efficiency | 0.13 | tool diversity, duration efficiency, file touch rate, sustained work |
| Verification | 0.13 | tests, builds, read-after-write |
| Consistency | 0.13 | read-before-write and low file-edit thrashing |
| Motion | 0.14 | retry loops, read waste, bash failure loops, undo patterns |

## Interpretation

The reward is not a human preference label. It is an observable process-quality proxy. Its value is in selection, ranking, ablation, and routing:

- select high-advantage trajectories for SFT
- identify weak domains or skills
- compare reward components by ablation
- keep live collector output scored at emit time

Historical backfills may have sparse outcome labels, so outcome defaults can be neutral. This is a data availability limitation, not evidence that outcome feedback is useless.

