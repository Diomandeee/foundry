# Foundry continuation — broker, project inputs and Mac evidence

**Current stop: R6 local source candidate, HOLD integration/operational acceptance.** Broker and larger-input source is implemented and reviewed. Complete native termination is NOT delivered; placement explicitly blocks Xcode profiles. R7 remains unstarted.

Read in order:

1. `CUMULATIVE-REVIEW.md` — actual supported/blocked behavior, twelve source findings and exact stop.
2. `BROKER-REVIEW.md` — implementation, authority boundaries and approvals still needed.
3. `PROJECT-INPUTS.md` — v2 format, bounds and historical sidecar receipt; parent updates below supersede its integration/split-admission notes.
4. `MAC-ATTESTATION.md` — actual Apple collector/client, evidence limits and native blocker.
5. `BROKER-INDEPENDENT-REVIEW.md`, `BROKER-REVIEW-ROUND2.md`, `BROKER-REVIEW-FINAL.md` — preserved independent review lineage.
6. `INPUTS-INDEPENDENT-REVIEW.md`, `INPUTS-REVIEW-ROUND2.md` — preserved independent input review and repair coverage.
7. `DEFERRED-VALIDATION.md` — future acceptance, NOT RUN.
8. `CHANGE-RECEIPT.json`, `SOURCE-HASHES.json`, `CHANGES.patch` — current scoped source identity and continuation delta after freeze.

`BASELINE.json` and inert `preimages/**/*.before` preserve the pre-continuation candidate. The delta depends on the prior uncommitted integration candidate and earlier cloud-workspaces freeze, not merely HEAD cf27ac6. Root-level prior receipts are preserved, not overwritten with new counts.

Current integration: `createClaimInputResolver` resolves actual scope-bound input ports only after the branded claim. `createClaimResultResolver` likewise binds actual result writer/issuer/capacity ports after claim, without placeholder preclaim ports. The runtime applies the smaller configured/controller cap before hydration, binds both root-ref hash and bytes to snapshotHash, and independently verifies actual npm/cargo working-source copies. Combined output+manifest capacity is admitted before writes and reused at staging; the historical sidecar split admission is superseded.

V2 structural limits: 8,192 explicit selected files, 512 metadata segments, 4GiB source bytes, 64MiB per file; exact actual capacity remains lower and depends on approved finite namespaces (32 grants/8MiB each). Authority approval still permits at most 128 required paths. Candidates never self-approve completeness; dependencies/assets/history are not automatically recovered.

No tests or test authoring, builds, typechecks, imports/probes, trial restores/jobs, service starts, installation, provider operations, provisioning, spending, secret changes, Git commit/push/merge, deployment, publication or cleanup occurred. All internal agents are closed at final freeze. No automation or service was installed or started. Source readback/hashes establish artifact identity only.
