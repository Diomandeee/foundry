# Real-Repo Issue Gate

The honest downstream proof for Trajectory Memory Ledger is not another local
stdlib task suite. It is same-agent issue resolution on real repositories.

The gate compares:

- `base_agent`: the coding agent without TML planner memory.
- `base_agent_tml_planner`: the same agent, model, budget, timeout, and patch
  harness, with TML planner/retrieval allowed before patch generation.

Everything else stays fixed. The official evaluator applies each generated
patch inside repository containers and judges whether the issue is resolved.

## Evidence Ladder

| Stage | Size | Purpose | Claim allowed |
|---|---:|---|---|
| Fixture preflight | 2 synthetic rows | Validate schema, coverage, and claim guard | No performance claim |
| Verified Mini or frozen Verified pilot | 50 real issues | Decide whether the planner generalizes at all | Pilot only |
| SWE-bench Lite | 300 real issues | Cheaper paper-grade issue-resolution result | Broad real-repo claim if positive |
| SWE-bench Verified | 500 real issues | Stronger human-validated result | Strongest issue-resolution claim |

## Contract

- Same instance ids for both conditions.
- Same base model and agent loop.
- Same wall-clock, token, turn, and patch-generation budget.
- Same SWE-bench harness version, dataset, split, timeout, and workers.
- Hidden tests and harness reports are not available during generation.
- The TML planner may use ledger memory, skillgraph packages, and public issue
  context before patch generation.
- The TML planner may not use the base condition's harness failures to repair
  the planner condition inside the same comparison.

## Prepare Or Summarize

The script accepts official SWE-bench prediction JSONL files:

```json
{"instance_id":"sympy__sympy-20590","model_name_or_path":"same-agent-model","model_patch":"diff --git ..."}
```

Preflight without harness reports:

```bash
python3 scripts/prepare_real_repo_issue_gate.py \
  --dataset-name princeton-nlp/SWE-bench_Verified \
  --subset-label verified-mini-50 \
  --instances-jsonl output/private-swebench/verified-mini-50-instances.jsonl \
  --base-predictions output/private-swebench/base-agent.predictions.jsonl \
  --planner-predictions output/private-swebench/tml-planner.predictions.jsonl \
  --output benchmarks/real-repo-issue-gate-preflight.json
```

Freeze the public-safe Verified Mini manifest:

```bash
python3 scripts/fetch_swebench_verified_mini_manifest.py
```

This writes
`examples/evaluation/swebench-verified-mini-public-manifest-2026-06-11.jsonl`
and a report under `benchmarks/`. The manifest keeps only public generation
fields such as `repo`, `instance_id`, `base_commit`, `problem_statement`,
`hints_text`, `created_at`, `version`, and `environment_setup_commit`. It omits
`patch`, `test_patch`, `FAIL_TO_PASS`, and `PASS_TO_PASS`.

Check local harness readiness:

```bash
python3 scripts/preflight_real_repo_issue_gate_env.py
```

The checked local `2026-06-11` preflight is blocked:

- free disk is `6.10 GiB`, below the configured `10.00 GiB` floor,
- `docker` is not installed,
- the Python `swebench` module is not importable,
- the public manifest exists,
- base/planner prediction JSONL files do not exist yet.

This is not a failure of TML. It says the official harness run belongs on a
Docker-capable machine with enough disk and generated prediction files.

Prepare prompts for both conditions:

```bash
python3 scripts/generate_real_repo_issue_predictions.py --dry-run
```

The checked dry-run writes 100 private prompt files under
`output/private-swebench/raw-agent-output`: 50 for `base_agent` and 50 for
`base_agent_tml_planner`. It writes no prediction JSONL files and allows no
performance claim.

Generate real prediction files by providing an external agent command:

```bash
python3 scripts/generate_real_repo_issue_predictions.py \
  --model-name same-agent-model \
  --agent-command 'your-agent --prompt-file {prompt_file}'
```

The same command, model name, timeout, and instance order are used for both
conditions. The only difference is that `base_agent_tml_planner` receives
retrieved TML skill memory in its prompt. The command must output a unified diff
to stdout or `{raw_output_file}`.

For real agent context, add `--prepare-repos`. The wrapper creates separate
condition-specific worktrees under ignored `output/private-swebench` and checks
each one out at the instance `base_commit`.

```bash
python3 scripts/generate_real_repo_issue_predictions.py \
  --dry-run \
  --prepare-repos \
  --max-instances 1 \
  --report benchmarks/real-repo-prediction-generation-repo-prep-smoke-2026-06-11.json
```

The checked smoke prepares `django__django-11790` for both conditions and still
writes no predictions. It exists to prove repository-context plumbing only.

The first real prediction smoke uses the same wrapper with Codex:

```bash
python3 scripts/generate_real_repo_issue_predictions.py \
  --prepare-repos \
  --max-instances 1 \
  --model-name codex-gpt-5.4 \
  --timeout-s 1800 \
  --output-dir output/private-swebench/codex-real-smoke-1 \
  --raw-dir output/private-swebench/codex-real-smoke-1/raw-agent-output \
  --report benchmarks/real-repo-prediction-generation-codex-real-smoke-2026-06-11.json \
  --agent-command 'codex exec --ephemeral --sandbox danger-full-access --model gpt-5.4 --cd "{repo_worktree}" --output-last-message "{raw_output_file}" - < "{prompt_file}"'
```

That checked smoke generated one base prediction and one TML-planner prediction
for `django__django-11790`. Both prediction files are under ignored
`output/private-swebench/codex-real-smoke-1`. The public report records patch
sizes and command status, but not the private raw model traces.

Validate the one-instance smoke inputs:

```bash
python3 scripts/prepare_real_repo_issue_gate.py \
  --instances-jsonl examples/evaluation/swebench-verified-mini-public-manifest-codex-smoke-1-2026-06-11.jsonl \
  --base-predictions output/private-swebench/codex-real-smoke-1/base-agent.predictions.jsonl \
  --planner-predictions output/private-swebench/codex-real-smoke-1/tml-planner.predictions.jsonl \
  --output benchmarks/real-repo-issue-gate-codex-real-smoke-2026-06-11.json \
  --subset-label verified-mini-codex-real-smoke-1 \
  --base-run-id tml_base_codex_real_smoke_1 \
  --planner-run-id tml_planner_codex_real_smoke_1
```

The checked gate report has `preflight.ok=true`, same prediction ids, same model
name, SHA-256 fingerprints for the manifest and prediction files, and
`performance_claim.status=waiting_for_official_harness_results`.

Package the same predictions for a Docker scorer:

```bash
python3 scripts/prepare_real_repo_harness_handoff.py \
  --instances-jsonl examples/evaluation/swebench-verified-mini-public-manifest-codex-smoke-1-2026-06-11.jsonl \
  --base-predictions output/private-swebench/codex-real-smoke-1/base-agent.predictions.jsonl \
  --planner-predictions output/private-swebench/codex-real-smoke-1/tml-planner.predictions.jsonl \
  --output-dir output/private-swebench/scorer-handoff-codex-real-smoke-1 \
  --report benchmarks/real-repo-harness-handoff-codex-real-smoke-2026-06-11.json \
  --subset-label verified-mini-codex-real-smoke-1 \
  --base-run-id tml_base_codex_real_smoke_1 \
  --planner-run-id tml_planner_codex_real_smoke_1
```

The checked handoff report has
`status=handoff_ready_waiting_for_official_harness`, validates the one instance,
records same ids/model, and writes an ignored private runner at
`output/private-swebench/scorer-handoff-codex-real-smoke-1/run_official_harness.sh`.
It also writes `input-fingerprints.json`; the private runner verifies the
manifest and both prediction files before launching the official harness. It
still does not run SWE-bench or allow a performance claim.

Prepare official result admission:

```bash
python3 scripts/prepare_real_repo_official_result_admission.py \
  --handoff-dir output/private-swebench/scorer-handoff-codex-real-smoke-1 \
  --report benchmarks/real-repo-official-result-admission-codex-real-smoke-2026-06-11.json \
  --subset-label verified-mini-codex-real-smoke-1 \
  --base-run-id tml_base_codex_real_smoke_1 \
  --planner-run-id tml_planner_codex_real_smoke_1
```

The checked admission report has `status=waiting_for_official_reports`,
verifies all three handoff input fingerprints, and records the missing base and
planner official report directories. When those reports exist, the same script
runs `prepare_real_repo_issue_gate.py` and emits the official comparison.

The first partial official Mac4 scorer result is preserved separately:

```bash
python3 scripts/prepare_real_repo_official_result_admission.py \
  --handoff-dir output/private-swebench/scorer-handoff-codex-real-mini-4 \
  --report benchmarks/real-repo-official-result-admission-codex-real-mini-4-partial-mac4-2026-06-11.json \
  --base-report output/private-swebench/official-mac4-codex-real-mini-4/summaries/codex-gpt-5.4.tml_base_codex_real_mini_4.json \
  --planner-report output/private-swebench/official-mac4-codex-real-mini-4/summaries/codex-gpt-5.4.tml_planner_codex_real_mini_4.json \
  --failure-log-dir output/private-swebench/official-mac4-codex-real-mini-4/planner-run-logs \
  --subset-label verified-mini-codex-real-mini-4 \
  --base-run-id tml_base_codex_real_mini_4 \
  --planner-run-id tml_planner_codex_real_mini_4
```

That report has
`status=partial_official_reports_waiting_for_counterpart`: the base official
SWE-bench run completed and resolved `4/4` Django instances, while the planner
official report is absent. The planner run logs are fingerprinted and
classified as Docker/containerd infrastructure failure before tests, including
image build/pull failures and containerd I/O errors. This is valid one-sided
official evidence, but it is not a base-vs-planner comparison and still sets
`performance_claim_allowed=false`.

Grow the scorer packet incrementally:

```bash
python3 scripts/select_real_repo_manifest_subset.py \
  --input examples/evaluation/swebench-verified-mini-public-manifest-2026-06-11.jsonl \
  --output examples/evaluation/swebench-verified-mini-public-manifest-codex-smoke-2-2026-06-11.jsonl \
  --report benchmarks/swebench-verified-mini-public-manifest-codex-smoke-2-2026-06-11.json \
  --count 1 \
  --exclude-predictions output/private-swebench/codex-real-smoke-1/base-agent.predictions.jsonl
```

The checked two-instance packet adds `django__django-11815`, merges the first
two private Codex prediction batches, packages a fingerprint-locked two-instance
handoff, verifies admission is still waiting for official reports, and confirms
both base and planner patches apply on both instances. It still does not run
SWE-bench or allow a performance claim.

The checked three-instance packet adds `django__django-11848`, merges the first
three private Codex prediction batches, packages a fingerprint-locked
three-instance handoff, verifies admission is still waiting for official
reports, and confirms base `3/3` plus planner `3/3` patch applicability. It
still does not run SWE-bench or allow a performance claim.

The checked four-instance packet adds `django__django-11880`, merges the first
four private Codex prediction batches, packages a fingerprint-locked
four-instance handoff, verifies admission is still waiting for official
reports, and confirms base `4/4` plus planner `4/4` patch applicability. It
still does not run SWE-bench or allow a performance claim.

The four-instance scorer bootstrap report records the handoff metadata parsed
from `run_official_harness.sh`, including the `tml_base_codex_real_mini_4` and
`tml_planner_codex_real_mini_4` run IDs plus all four instance IDs. The private
Docker runner and Modal reference therefore point at the same four-instance
input set.

The post-four live scorer audit is
`benchmarks/real-repo-scorer-target-audit-post-four-instance-2026-06-11.json`.
It reported `no_ready_official_scorer` before the Mac4 HD2 bootstrap: local had
only `4.56 GiB` free and no Docker or `swebench`; Mac4 had Docker but only
`12.45 GiB` free on internal storage and no global `swebench`; Mac5 was
reachable but had only `16.04 GiB` free, no Docker, and no `swebench`;
cloud-vm remained unreachable. The later storage-candidate audit found HD2 on
Mac4 and enabled the partial official base run, but Docker/Colima still wrote
through the nearly full internal containerd storage and failed before planner
tests.

The same four patched worktree pairs also passed selected local public/touched
Django tests:

- `django__django-11790`: base passed, planner passed
- `django__django-11815`: base passed, planner passed
- `django__django-11848`: base passed, planner passed
- `django__django-11880`: base passed, planner passed

Those reports are
`benchmarks/real-repo-local-test-smoke-codex-real-mini-4-django-*-2026-06-11.json`.
They are supporting evidence only: no hidden tests, full Django suite, or
official SWE-bench scorer ran, so no resolved-rate or planner-lift claim is
allowed.

Audit available scorer targets:

```bash
python3 scripts/audit_real_repo_scorer_targets.py \
  --output benchmarks/real-repo-scorer-target-audit-2026-06-11.json \
  --gcloud-account <account> \
  --gcloud-project <project>
```

The checked storage-candidate audit reports `no_ready_official_scorer`: local,
Mac4, Mac5, and Mac2 are blocked by disk/package/Docker gaps, cloud-vm is
unreachable, and local cloud CLIs are not ready to submit an official job.
Cloud account/project identifiers are redacted in the public report. Mac2 was
explicitly checked after the partial Mac4 run; it has only about `13.43 GiB`
free, no Docker, no `swebench`, and no external volume, so it can hold small
artifacts but is not a scorer target. Mac4 still has HD2 space, but its
internal Docker/Colima storage hit containerd I/O errors during the planner
run, so do not run more official Docker scoring there until Docker storage is
repaired or moved.

Prepare bootstrap scripts for a future scorer:

```bash
python3 scripts/prepare_real_repo_scorer_bootstrap.py \
  --handoff-dir output/private-swebench/scorer-handoff-codex-real-smoke-1 \
  --output-dir output/private-swebench/scorer-bootstrap-codex-real-smoke-1 \
  --report benchmarks/real-repo-scorer-bootstrap-codex-real-smoke-2026-06-11.json
```

The checked bootstrap report has `status=scorer_bootstrap_packet_ready`. The
private ignored packet contains scripts to bootstrap an x86_64 Docker scorer,
sync the existing private handoff, run the handoff, and reference the Modal
`--modal true` path. It does not run or submit anything.

Check whether the generated patches apply to the real base commit:

```bash
python3 scripts/check_real_repo_prediction_patch_apply.py \
  --instances-jsonl examples/evaluation/swebench-verified-mini-public-manifest-codex-smoke-1-2026-06-11.jsonl \
  --base-predictions output/private-swebench/codex-real-smoke-1/base-agent.predictions.jsonl \
  --planner-predictions output/private-swebench/codex-real-smoke-1/tml-planner.predictions.jsonl \
  --private-dir output/private-swebench/patch-apply-check-codex-real-smoke-1 \
  --report benchmarks/real-repo-patch-apply-codex-real-smoke-2026-06-11.json
```

The checked report has `status=patch_apply_check_passed`: both the base and
planner patches apply to `django__django-11790` at the base commit. This is
patch applicability only; no repository tests or official harness ran.

Run the narrow local public-test smoke:

```bash
python3 scripts/run_real_repo_local_test_smoke.py \
  --instance-id django__django-11790 \
  --repo django/django \
  --base-worktree output/private-swebench/repo-worktrees/worktrees/base_agent/django__django-11790 \
  --planner-worktree output/private-swebench/repo-worktrees/worktrees/base_agent_tml_planner/django__django-11790 \
  --dependency-path output/private-swebench/django-test-deps \
  --test-label auth_tests.test_forms.AuthenticationFormTest.test_username_field_max_length_matches_user_model \
  --test-label auth_tests.test_forms.AuthenticationFormTest.test_username_field_max_length_defaults_to_254 \
  --report benchmarks/real-repo-local-test-smoke-codex-real-smoke-2026-06-11.json
```

The checked report has `status=local_test_smoke_passed`: both the base and
planner patched worktrees pass the two changed Django auth form tests. This is
not a full repository test suite and not the official SWE-bench harness.

Run the official harness for both prediction files:

```bash
python -m swebench.harness.run_evaluation \
  --dataset_name princeton-nlp/SWE-bench_Verified \
  --split test \
  --predictions_path output/private-swebench/base-agent.predictions.jsonl \
  --max_workers 1 \
  --timeout 1800 \
  --run_id tml_base_verified_mini

python -m swebench.harness.run_evaluation \
  --dataset_name princeton-nlp/SWE-bench_Verified \
  --split test \
  --predictions_path output/private-swebench/tml-planner.predictions.jsonl \
  --max_workers 1 \
  --timeout 1800 \
  --run_id tml_planner_verified_mini
```

On macOS ARM, the official SWE-bench README notes that `--namespace ''` should
be added so Docker images build locally instead of pulling Linux images.

Summarize after both official reports exist:

```bash
python3 scripts/prepare_real_repo_issue_gate.py \
  --dataset-name princeton-nlp/SWE-bench_Verified \
  --subset-label verified-mini-50 \
  --instances-jsonl output/private-swebench/verified-mini-50-instances.jsonl \
  --base-predictions output/private-swebench/base-agent.predictions.jsonl \
  --planner-predictions output/private-swebench/tml-planner.predictions.jsonl \
  --base-report evaluation_results/tml_base_verified_mini \
  --planner-report evaluation_results/tml_planner_verified_mini \
  --output benchmarks/real-repo-issue-gate-verified-mini.json
```

## Checked Fixture

The repository includes a synthetic two-row fixture under
`examples/evaluation/real-repo-gate/`. It exists only to prove that the script
validates same-instance coverage, parses reports, computes planner delta, and
refuses a performance claim when rows are synthetic.

```bash
python3 scripts/prepare_real_repo_issue_gate.py \
  --dataset-name fixture/SWE-bench-style \
  --subset-label synthetic-fixture \
  --instances-jsonl examples/evaluation/real-repo-gate/fixture-instances.jsonl \
  --base-predictions examples/evaluation/real-repo-gate/base-predictions.fixture.jsonl \
  --planner-predictions examples/evaluation/real-repo-gate/planner-predictions.fixture.jsonl \
  --base-report examples/evaluation/real-repo-gate/base-results.fixture.json \
  --planner-report examples/evaluation/real-repo-gate/planner-results.fixture.json \
  --allow-synthetic-fixture \
  --output benchmarks/real-repo-issue-gate-fixture-2026-06-11.json
```

Expected claim status:

```text
synthetic_fixture_not_performance_evidence
```

## Current Status

As of this artifact, TML has generated four real Codex prediction pairs for
`django__django-11790`, `django__django-11815`, `django__django-11848`, and
`django__django-11880`. The gate validates same-instance/same-model coverage;
all base and planner patches apply; and both conditions pass the selected
local public/touched Django smoke tests for each instance.

The first official SWE-bench evidence is partial. Mac4 completed the base
condition through the official harness with `4/4` resolved and `0` errors. The
planner condition did not produce an official report because the scorer failed
inside Docker/containerd before tests. Therefore the real-repo proof is still
incomplete: we have a valid base official result and a valid infrastructure
failure record for the missing planner run, but no official base-vs-planner
resolved-rate comparison.

The next honest decision is simple:

- If the planner beats base on the same 50 real issues, continue to Lite.
- If it ties or loses, stop broad claims and mine failures for better planner
  memory or adapter-training episodes.
- If Lite or Verified is positive under the same contract, then the paper can
  claim real-repo issue-resolution lift.
