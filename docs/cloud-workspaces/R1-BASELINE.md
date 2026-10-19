# R1 scoped baseline

Observed 2026-10-18T03:10:11.213649+00:00. Static evidence preparation only. Repository: `/Users/mohameddiomande/Developer/foundry-integration/source`.

Recorded branch: `codex/foundry-integration-20261016`. Recorded base/HEAD: `cf27ac662730bb98a509af8d1d1ebea4342eef7a`. Read-only current branch: `codex/foundry-integration-20261016`; HEAD: `cf27ac662730bb98a509af8d1d1ebea4342eef7a`. Both match the recorded baseline: True. No isolated branch or clean worktree was created. The shared dirty checkout is the actual scope; HEAD is not the identity of all current source bytes.

`BASELINE.json` SHA-256: `5ceb272267482590857225b2f0c906a7f17b572fa7ba3405b17869f4b6dfb089`. It records 261 file hashes and 42 status lines. Its hashes describe its capture, not ownership, a complete repository manifest or a clean starting delta. Current targeted source hashes and exact evidence paths are in R1-FINDINGS.json. No blanket attribution of concurrent changes is possible.

This lane owns exactly:

- `/Users/mohameddiomande/Developer/foundry-integration/source/docs/cloud-workspaces/R1-BASELINE.md`
- `/Users/mohameddiomande/Developer/foundry-integration/source/docs/cloud-workspaces/R1-FINDINGS.json`
- `/Users/mohameddiomande/Developer/foundry-integration/source/docs/cloud-workspaces/R1-PROJECT-READINESS.json`
- `/Users/mohameddiomande/Developer/foundry-integration/source/docs/cloud-workspaces/R1-CAPACITY.json`
- `/Users/mohameddiomande/Developer/foundry-integration/source/docs/cloud-workspaces/R1-REVIEW.md`

No other files are owned or changed by R1. Existing documents, tests, caches, dependencies, build-jobs/build-runtime and other agents' untracked source are preserved. No cleanup, rollback, commit, push, merge or service action is authorized. New files use exclusive creation; all original receipts remain in place. No task ledger, memory, heartbeat or background work was created outside the assigned files.

## Recorded dirty boundary (verbatim paths/status from BASELINE.json)

```text
 M packages/artifacts-port/src/git.ts
 M packages/artifacts-port/src/port.ts
 M packages/compute-authority/src/agent.test.ts
 M packages/compute-authority/src/agent.ts
 M packages/compute-authority/src/authority.test.ts
 M packages/compute-authority/src/authority.ts
 M packages/compute-authority/src/dashboard.ts
 M packages/compute-authority/src/executor.test.ts
 M packages/compute-authority/src/executor.ts
 M packages/compute-authority/src/matching.test.ts
 M packages/compute-authority/src/matching.ts
 M packages/compute-authority/src/placer.test.ts
 M packages/compute-authority/src/placer.ts
 M packages/compute-authority/src/registry.test.ts
 M packages/compute-authority/src/registry.ts
 M packages/compute-authority/src/snapshot.test.ts
 M packages/compute-authority/src/verifier.test.ts
 M packages/compute-authority/src/verifier.ts
?? packages/compute-authority/README.md
?? packages/compute-authority/src/durable/
?? packages/compute-authority/src/local-journey.test.ts
?? packages/compute-authority/src/reference-regressions.test.ts
?? packages/compute-authority/src/test-artifacts.ts
?? packages/epoch-chain/
?? packages/epoch-dispatch/
?? packages/epoch-inbox/
?? packages/epoch-jobs/
?? packages/library-catalog/
?? packages/library-checkpoint/
?? packages/library-gcs/
?? packages/library-jobs/
?? packages/library-recovery/
?? packages/library-revocation/
?? packages/stacks-events/
?? packages/storage-broker/
?? packages/worker-client/
?? packages/worker-enrollment/
?? packages/worker-runtime/
?? tools/foundry-library-bridge/
?? tools/foundry-pilot/
?? workers/compute/
?? workers/library-broker/
```

## Read-only current status before R1 output creation

```text
 M README.md
 M package-lock.json
 M package.json
 M packages/artifacts-port/src/git.ts
 M packages/artifacts-port/src/port.ts
 M packages/compute-authority/src/agent.test.ts
 M packages/compute-authority/src/agent.ts
 M packages/compute-authority/src/authority.test.ts
 M packages/compute-authority/src/authority.ts
 M packages/compute-authority/src/dashboard.ts
 M packages/compute-authority/src/executor.test.ts
 M packages/compute-authority/src/executor.ts
 M packages/compute-authority/src/matching.test.ts
 M packages/compute-authority/src/matching.ts
 M packages/compute-authority/src/placer.test.ts
 M packages/compute-authority/src/placer.ts
 M packages/compute-authority/src/registry.test.ts
 M packages/compute-authority/src/registry.ts
 M packages/compute-authority/src/snapshot.test.ts
 M packages/compute-authority/src/verifier.test.ts
 M packages/compute-authority/src/verifier.ts
 M tsconfig.json
 M vitest.config.ts
 M workers/gate/src/decide.ts
 M workers/gate/src/merge.ts
 M workers/gate/src/pipeline.ts
?? .vitest/
?? docs/cloud-workspaces/
?? node_modules
?? packages/build-jobs/
?? packages/build-runtime/
?? packages/compute-authority/README.md
?? packages/compute-authority/src/durable/
?? packages/compute-authority/src/local-journey.test.ts
?? packages/compute-authority/src/reference-regressions.test.ts
?? packages/compute-authority/src/test-artifacts.ts
?? packages/epoch-chain/
?? packages/epoch-dispatch/
?? packages/epoch-inbox/
?? packages/epoch-jobs/
?? packages/library-catalog/
?? packages/library-checkpoint/
?? packages/library-gcs/
?? packages/library-jobs/
?? packages/library-recovery/
?? packages/library-revocation/
?? packages/stacks-events/
?? packages/storage-broker/
?? packages/worker-client/
?? packages/worker-enrollment/
?? packages/worker-runtime/
?? tools/foundry-library-bridge/
?? tools/foundry-pilot/
?? workers/compute/
?? workers/epoch-inbox/
?? workers/epoch-pipeline/
?? workers/library-broker/
?? workers/library/
```

The second snapshot includes other concurrent work and docs/cloud-workspaces/ containing BASELINE.json. It is not an R1 change list. The baseline status is narrower than current status; preserve both. No diff reverse-application or source hash reset is safe to infer from either snapshot.

## Evidence and review boundary

Primary review: `/Users/mohameddiomande/Developer/foundry-integration/evidence/r2-integration/FINDINGS.json` and FINAL-REVIEW.md. Independent later G1/G2 review: `/Users/mohameddiomande/Developer/foundry-integration/validation/reviews/2026-10-17-batch-01-g1-g2/REVIEW.md`. Implementer repair claims in the handoff package do not override that HOLD. Catalog input: `/Users/mohameddiomande/Documents/Codex/2026-10-15/ran-command-inventory-review-package-contents/foundry-project-library-2026-10-17/catalog-r3` and locally delivered gzip source manifests under `/Users/mohameddiomande/Documents/Codex/2026-10-15/ran-command-inventory-review-package-contents/fleet-gcp-copy-2026-10-17`. All evidence is local; no live cloud existence/generation or authentication check occurred.

Structure and Content: static review only. Compilation, runtime Integration, User Journey and Deployment: DEFERRED pending explicit approval. Mac metadata reads are narrowly authorized observations, not software execution validation. Tests, new tests, builds, typechecks, imports/probes, installs, services, cloud writes/reads/spend, credential changes and Git publication were not performed.
