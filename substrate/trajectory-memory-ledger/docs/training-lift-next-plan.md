# Next Training-Lift Plan

The first adapter-conditioned executable result was negative: three Gemma 3 1B MLX LoRA adapters all scored 0/6. The stronger Gemma 4 lane changed the picture. Gemma 4 E2B QAT scored 3/6 as a base model, Gemma 4 12B QAT scored 5/6 as a base model, and the Gemma 4 E2B 512-row/4096-token adapter run scored `random` 3/6, `reward_selected` 5/6, and `full_ledger` 2/6. The 60-task replication then rejected the broad E2B adapter claim while proving a stronger router/planner result. The next useful proof is therefore not "train a bigger adapter by default." It is base agent versus base+TML planner on real repository issues.

## Diagnosis

The failed adapter run should be interpreted as a weak training/generation setup:

- base model: `mlx-community/gemma-3-1b-it-4bit`
- selected rows per condition: 96 total, 86 train / 10 validation
- max sequence length: 256
- generation cap: 1024 tokens
- executable result: `random` 0/6, `reward_selected` 0/6, `full_ledger` 0/6

The stronger local baselines show the held-out executable set is not impossible:

| Lane | Condition | Training context | Passed | Pass rate |
|---|---|---:|---:|---:|
| Gemma 4 E2B QAT base | `gemma4_e2b_qat_base` | n/a | 3/6 | 50.00% |
| Gemma 4 12B QAT base | `gemma4_12b_qat_base` | n/a | 5/6 | 83.33% |
| Gemma 4 E2B adapter | `random` | 4096 | 3/6 | 50.00% |
| Gemma 4 E2B adapter | `reward_selected` | 4096 | 5/6 | 83.33% |
| Gemma 4 E2B adapter | `full_ledger` | 4096 | 2/6 | 33.33% |

## Next Gate

The next valid downstream-lift claim requires a SWE-bench-style real-repo issue gate before any broader adapter claim. Use `docs/real-repo-issue-gate.md` and `scripts/prepare_real_repo_issue_gate.py` to compare:

- `base_agent`
- `base_agent_tml_planner`

with the same model, same budget, same timeouts, same instance ids, and same official harness.

Current execution state:

- A public-safe 50-row Verified Mini manifest is frozen at
  `examples/evaluation/swebench-verified-mini-public-manifest-2026-06-11.jsonl`.
- Local official harness execution is blocked: free disk is about `6.10 GiB`,
  `docker` is not installed, and the Python `swebench` module is not importable.
- Prediction-generation dry-run is wired for all 50 instances:
  `scripts/generate_real_repo_issue_predictions.py --dry-run` writes 100
  private prompt files and no predictions.
- Repo-prep smoke is wired for one real instance:
  `scripts/generate_real_repo_issue_predictions.py --dry-run --prepare-repos --max-instances 1`
  prepares condition-specific `django__django-11790` worktrees at the base
  commit, but writes no predictions and runs no harness.
- One-instance Codex real prediction smoke is complete:
  `scripts/generate_real_repo_issue_predictions.py --prepare-repos --max-instances 1`
  with `codex-gpt-5.4` generated one base prediction and one TML-planner
  prediction for `django__django-11790`. The gate preflight validates same ids
  and same model name, but reports `waiting_for_official_harness_results`.
- Local official harness scoring remains blocked even with predictions present:
  free disk is about `6.02 GiB`, Docker is missing, and Python `swebench` is not
  importable. Mac4 has Docker but only about `13 GiB` free and no `swebench`;
  the official SWE-bench README recommends roughly `120GB` free storage for
  Docker evaluation and notes ARM support is experimental.
- The one-instance predictions are packaged for an official scorer:
  `scripts/prepare_real_repo_harness_handoff.py` writes an ignored private
  bundle under `output/private-swebench/scorer-handoff-codex-real-smoke-1` and a
  public report
  `benchmarks/real-repo-harness-handoff-codex-real-smoke-2026-06-11.json`.
  The report records SHA-256 fingerprints for the manifest and prediction
  JSONL files, and the private runner verifies them before the harness starts.
  This is still only a handoff, not a harness run.
- Official result admission is prepared:
  `scripts/prepare_real_repo_official_result_admission.py` verifies the frozen
  handoff fingerprints and writes
  `benchmarks/real-repo-official-result-admission-codex-real-smoke-2026-06-11.json`.
  Current status is `waiting_for_official_reports`, with all three handoff
  inputs verified and no performance claim allowed.
- Scorer-target audit is now recorded:
  `scripts/audit_real_repo_scorer_targets.py` writes
  `benchmarks/real-repo-scorer-target-audit-2026-06-11.json`, with redacted
  cloud identifiers. Current status is `no_ready_official_scorer`.
- Scorer bootstrap packet is now prepared:
  `scripts/prepare_real_repo_scorer_bootstrap.py` writes
  `benchmarks/real-repo-scorer-bootstrap-codex-real-smoke-2026-06-11.json` and
  ignored private scripts for bootstrapping an x86_64 Docker scorer, syncing the
  handoff, running the handoff, and referencing the Modal path.
- Patch-apply smoke is complete:
  `scripts/check_real_repo_prediction_patch_apply.py` validates that the
  one-instance base and TML-planner patches both apply cleanly to the
  `django__django-11790` base commit. This is not test execution or issue
  resolution.
- Local public-test smoke is complete:
  `scripts/run_real_repo_local_test_smoke.py` runs the two changed Django auth
  form tests in the patched base and planner worktrees; both conditions pass.
  This is not the full Django suite, hidden SWE-bench tests, or official issue
  resolution.
- Incremental four-instance real-prediction packet is complete:
  `scripts/select_real_repo_manifest_subset.py` selected `django__django-11815`
  then `django__django-11848`, then `django__django-11880` as the next
  public-safe rows, `scripts/merge_real_repo_prediction_batches.py` merged the
  first four private Codex batches, and the four-instance packet has gate/handoff/
  admission reports plus patch-apply status. Both base and planner patches
  apply on all four instances; official scoring is still unrun.
- Full base and planner prediction JSONL files still need to be generated for
  the 50-row Verified Mini subset on, or transferred to, the machine that will
  run the official harness.

Only continue adapter work if one of two things happens:

1. The TML planner beats base on a real-repo pilot and the failures show a trainable pattern.
2. The planner fails, but the failed traces produce high-quality repair episodes that are clearly useful for adapter training.

If the real-repo gate ties or loses and the traces are not useful, stop the adapter chase.

## Adapter Replication Protocol

If the real-repo gate justifies more training, the next adapter experiment should replicate the reward-selected advantage on a larger executable task set and, ideally, a stronger model family.

Minimum protocol:

1. Keep base-model candidate generation as a reported control.
2. Train matched `random`, `reward_selected`, and `full_ledger` conditions from the same eligible private pool.
3. Use at least 4096-token training context; prefer 8192 if stable.
4. Use hundreds or thousands of rows per condition, not 86 train rows.
5. Prefer Gemma 4 E4B locally if it trains cleanly; otherwise move the 12B-class training proof to a cloud GPU stack.
6. Match per-condition token budgets so `full_ledger` is not advantaged only by volume.
7. Keep held-out executable prompts and hidden verifier tests separate.
8. Allow public-only repair checks: syntax, importability, public starter definitions, and public prompt/example consistency. Do not feed hidden verifier failures back into generation.
9. Report candidate-generation failures separately from hidden-test failures.
10. Report executable pass rate, confidence intervals, and per-task failures for every condition.

## Training Scale

Recommended staged runs:

| Stage | Rows per condition | Context | Purpose |
|---|---:|---:|---|
| Smoke | 512 | 4096 | Catch trainer/model incompatibility quickly |
| Main local | 2048 | 4096 or 8192 | First meaningful local lift attempt |
| Cloud proof | 4096+ | 8192+ | Stronger QLoRA/LoRA run if local MLX training cannot handle Gemma 4 12B |

If local MLX adapter training does not support the selected Gemma 4 model cleanly, do not fall back to Gemma 3 1B. Move the training run to a cloud GPU stack and keep Mac5 for generation/evaluation.

## Evaluation Scale

The six-task Python stdlib set is useful as a fast sanity gate, but it is too small for a final lift claim. The next executable set should have at least 50 tasks, and preferably 100+, with:

- deterministic stdlib tasks,
- multiple files where appropriate,
- public prompt/starter split,
- hidden verifier tests,
- no leakage from private training prompts,
- a mix of parsing, collections, graph, state-machine, filesystem-safe, and text-processing tasks.

Success criteria for a real downstream-lift claim:

- `reward_selected` beats `random` on executable pass rate for the same model family.
- The lift remains after public-only repair is held constant across conditions.
- The result is not only validation-loss improvement.
- The report has `synthetic_rows=0`.
- The report records `hidden_tests_sent_to_model=false`.

Current honest claim: Trajectory Memory Ledger can record, score, export, train from, and evaluate coding-agent trajectories; the small Gemma 3 adapter lane failed downstream; the stronger Gemma 4 E2B adapter lane shows a positive reward-selected downstream lift signal on a six-task executable gate. The next step is replication at E4B/12B-class scale and 50-100 held-out executable tasks.
