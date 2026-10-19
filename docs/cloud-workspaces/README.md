# Foundry cloud workspaces and remote Mac builds

**Local implementation candidate. Operational validation and activation remain gated.**

Current continuation: **[continuation-2026-10-18](continuation-2026-10-18/README.md)** contains the new broker/input/native changes and their current receipt. Root-level CHANGE-RECEIPT/SOURCE-HASHES/FINAL-SUMMARY/CHANGES.patch remain the prior frozen checkpoint, not hashes of the extended tree.

Read in order:
1. `MASTER-CHECKLIST.md` — exact feature route and current stopping point.
2. `ARCHITECTURE.md` — authority, source, runtime, artifact and retention boundaries.
3. `SOURCE-REVIEW.md` — cumulative static findings/dispositions and residual prerequisites.
4. `R1-REVIEW.md` — inherited HOLD, baseline, project inventory and capacity observations.
5. `LIBRARY-REVIEW.md`, `RUNTIME-REVIEW.md`, `BUILD-STORAGE-REVIEW.md` — actual implementation and limits.
6. `DEFERRED-VALIDATION.md` — future protocol, not successful test evidence.
7. `ACTIVATION-AND-COST.md`, `RESOURCE-PROPOSAL.json` — exact resource/identity/spend gates and rollback.
8. `CHANGE-RECEIPT.json`, `SOURCE-HASHES.json`, `CHANGES.patch` — final scoped source identity and reviewable task delta.

Product source is in `packages/build-jobs`, `packages/build-runtime`, `packages/build-storage`, the existing `tools/foundry-library-bridge`, compute/broker route additions and the existing pilot operator. No duplicate control plane, live filesystem sync, automatic canonical merge, or source deletion was introduced.

The three main packages are inert at import with respect to services/jobs/provider operations. Actual invocation still needs approved host configuration, real storage/auth/current-state ports, owner recipe/input approvals and adequate disk. Native process containment requires a supported attestor; absent evidence quarantines. Preparing a provider adapter is not creating its credentials or infrastructure.

The source library remains a frozen collection of captured variants. Existing transferred originals/cloud generations are untouched. Snapshot and build code does not establish complete Git history, dependency availability, restore success, app functionality, signing or production readiness.

No tests, builds, typechecks, trial restores, imports/probes, services, installations, provisioning, new provider operations, spending, secret changes, commits, pushes, merges, deployment or cleanup were performed. Read-only metadata/source observations and local source/document/receipt edits are the evidence in this folder. Pricing research used public documentation; no project billing balance was read.

`BASELINE.json` identifies pre-edit hashes and existing dirty/untracked boundaries. `PREIMAGE-RECOVERY.json` records exact hash-matched pre-edit bytes recovered from prior reviewed packages or reversed additive edits; hashes had to match before a preimage was accepted. Preimages have inert `.before` suffixes so they are not compiled as product code. Final patch is scoped to this task, rather than pretending the already-dirty checkout began at HEAD.

The patch requires the full pre-existing integration candidate identified by BASELINE.json and DEPENDENCY-HASHES.json. It is not a standalone patch against commit cf27ac6. The existing candidate includes uncommitted dependencies; their integration HOLD is preserved.
