# Cloud workspaces master checklist

Status vocabulary: **implemented**, **source-reviewed**, **validation-pending**, **validated**, **activated**, **blocked**. Source review never substitutes for execution evidence. No task in this route is validated or activated by this implementation session.

## R1 — Baseline and evidence
- [x] R1.1 Capture base commit, branch, scoped dirty boundary and pre-edit hashes (`BASELINE.json`).
- [x] R1.2 Reconcile inherited findings without accepting another implementer's claimed closure (`R1-FINDINGS.json`).
- [x] R1.3 Inventory catalog project markers, lockfiles and missing-input uncertainty (`R1-PROJECT-READINESS.json`).
- [x] R1.4 Observe Mac disk/toolchain metadata without builds or cleanup (`R1-CAPACITY.json`).
- [x] R1.5 Establish dependency route and approval boundaries (this file, `ARCHITECTURE.md`).

## R2 — Library and preservation (depends R1)
- [x] R2.1 Extend catalog with conservative reconstructability and explicit source lineage.
- [x] R2.2 Prepare immutable changed-workspace snapshots without uploading or overwriting.
- [x] R2.3 Implement independently authenticated bounded broker reads; retain revoked/cache reauthorization.
- [x] R2.4 Implement unpublished bounded chunk-package preparation and pinned reassembly; never fabricate cloud generations or grants.
- [x] R2.5 Source-review catalog/pull/snapshot/broker flow and record limits.
- [ ] R2.6 **GATED:** validate restores, authorize package publication and device identities, install/activate clients.

## R3 — Durable build authority (depends R1 and R2 contracts)
- [x] R3.1 Add versioned build profiles, approved inputs, worker approvals and exact structured commands.
- [x] R3.2 Add durable jobs/attempts, one-host slots and legacy reservation exclusion in the same authority transaction namespace.
- [x] R3.3 Implement renewable 60-second leases, one-hour execution cap, cancellation, stale-result fencing and explicit stop reconciliation.
- [x] R3.4 Separate staging from independent bounded artifact verification and immutable receipts.
- [x] R3.5 Wire authenticated `/v1/builds/*` routes disabled by default; preserve old short-job route/profile contracts.
- [x] R3.6 Close independent static review findings; carry runtime checks forward unexecuted.

## R4 — Host execution and artifact storage (depends R2/R3)
- [x] R4.1 Implement owner-branded Linux and unsigned native-Xcode execution plans.
- [x] R4.2 Implement durable host lock/pre-run evidence, cancellation/renewal supervisor and restart quarantine.
- [x] R4.3 Implement actual host discovery, toolchain matching and storage admission code, without invoking it.
- [x] R4.4 Implement bounded immutable output packaging, create-only writer and pinned readback verification.
- [x] R4.5 Wire controller to claim/renew/stop/stage with exact input/profile lineage.
- [x] R4.6 Source-review concrete stop-proof boundaries and all deferred dependencies; do not invent containment proof.
- [ ] R4.7 **GATED:** dedicate accounts/roots, install agents/tools, authorize dependencies, provision host and identities.

## R5 — Operator journey (depends R2–R4 interfaces)
- [x] R5.1 Add project/input/profile selection and read-only placement explanation.
- [x] R5.2 Add separately enabled submission/cancellation, preserving uncertain request identities.
- [x] R5.3 Show census/toolchains/capacity, bounded job windows and verification state.
- [x] R5.4 Retrieve independently verified artifacts through scoped server-side reads; no grants/credentials in browser responses.
- [x] R5.5 Source-review UI→handler→authority→runtime→artifact boundaries and honest unavailable states.

## R6 — Review and handover (depends R1–R5)
- [x] R6.1 Freeze scoped source hashes/diff and reconcile baseline drift.
- [x] R6.2 Record cumulative source review, supported operations, residual blockers and deferred validation protocol.
- [x] R6.3 Prepare exact GCP resource proposal, cost/credit verification gate, rollback/shutdown and credential reference inventory.
- [x] R6.4 Update route with exact stop. **STOP before validation or external activation.**

## R7 — Activation and space recovery (all externally gated)
- [ ] R7.1 Obtain validation authorization; run deferred acceptance after required installation/provisioning approvals.
- [ ] R7.2 Publish catalog and activate one client, then all three Macs.
- [ ] R7.3 Provision approved GCP resource and Linux worker; no automatic additional resources.
- [ ] R7.4 Approve specific regenerable cleanup to establish Mac headroom; no assumed reclaimable space.
- [ ] R7.5 Activate one compatible Mac build worker, then a second after acceptance.
- [ ] R7.6 Demonstrate recoverability before requesting removal of individual original project copies.
- [ ] R7.7 Record operating receipts, quotas, identity/fencing evidence, retention approvals and exact next gate.

The original Foundry R2–R7 integration route remains separate: this feature route does not close inherited merge-gate HOLD findings or grant merge/deployment approval.

## Current stop — R6 M3 VM integration implemented and source-reviewed, operational HOLD

The `mac-safety-2026-10-18` batch supersedes the previous native execution direction. Native adapter/client launch now rejects locally. Concrete Swift whole-VM containment, branded guest jobs, bounded guest runner and a separate kernel-read-only volume guard exist as source. The optional read-side packaging capability is wired without claiming a mutable-tree seal. Independent static reviews and scoped receipts describe the exact coverage. No compiler, test or runtime evidence exists for this batch.

The subsequent `guest-io-2026-10-18` batch completes M1/M2 as local source: full snapshot/object/tree verification, protected create-only image assembly, launch-bound input lifetime, actual-stop-gated raw-disk copying and readonly sanitization, independent result-envelope checks, and existing immutable publication composition. Review is six inline source passes by the implementing agent, not independent runtime evidence.

M3 production VM adapter/controller/guest capability wiring is now implemented and source-reviewed. The concrete flow uses one reservation, authenticated stop/stage commands, verified stop-gated intake and separate owner VM activation. No installed or validated Mac worker is claimed. Generic writable CAS/materialization isolation, resources and inherited integration HOLD remain open. M4 and R7 remain gated. See `vm-integration-2026-10-18/README.md` for the exact operator-mediated behavior and stopping point.

No tests, builds, typechecks, runtime imports/probes, trial restores, helpers/VMs/services, installations, provider operations, provisioning, spending, secret changes, commits/pushes/merges, deployments, publication or cleanup were performed. Source/metadata reads, public primary research, source/document edits and local review/hash artifacts are the evidence.

## Authorized continuation tasks (dependencies are explicit)

- [x] C1.1 Preserve fresh baseline/preimages before source edits.
- [x] C1.2 Implement separate online broker mode, nonce/source-pinned access and current denial classification.
- [x] C1.3 Persist exact-key capacity reservations, grant intents, local deny markers and command-bound revocation delivery.
- [x] C1.4 Compose actual existing GCS adapters and finite approved namespace routing; no provider invocation.
- [x] C2.1 After C1 contracts, implement v2 bounded root/segments/packed file blobs and sharded local CAS.
- [x] C2.2 Propagate actual claim context into restoration and independently verify actual local bytes/metadata and undeclared entries.
- [x] C3.1 Add real Apple ES collector source and signed journal verification/recovery diagnostics.
- [ ] C3.2 Full native supervisor, service containment, current-fence physical launch and confirmed termination. **BLOCKED; source protocol is not a supplied supervisor.**
- [x] C4.1 Repair cumulative source-review findings and freeze the new scoped delta/hashes; independent approvals are bounded, and C3.2/native/integration HOLD remains.
- [ ] C4.2 Operational acceptance. **GATED; no tests or activation authorized.**

## Mac safety source substeps — no operational completion implied

- [x] MS1 Preserve fresh source preimages and exact baseline before implementation.
- [x] MS2 Deny incomplete native launch at local API boundaries; retain diagnostic recovery reads and authority denial.
- [x] MS3 Implement concrete whole-VM lifecycle source, one-use continuous-time authority-budget permits, terminal admission closure and callback-drained stop observation.
- [x] MS4 Encode branded guest-job metadata; implement bounded same-descriptor guest staging/build/log/output/receipt handling.
- [x] MS5 Implement root-mounted kernel-read-only volume guard, explicit identity/ACL checks, poisoned uncertainty and separate read-side packaging integration.
- [x] MS6 Repair bounded independent source findings and record final diff/hash/review coverage. Compilation/runtime remain unverified.
- [x] M1 Verified immutable snapshot → complete guest job/input staging. **IMPLEMENTED / SOURCE-REVIEWED / VALIDATION-PENDING.** Concrete offline root helper and guarded client acceptance are supplied; no image was created or staged operationally.
- [x] M2 After actual VM stop, readonly output-disk intake and independent artifact/receipt/lineage verification. **IMPLEMENTED / SOURCE-REVIEWED / VALIDATION-PENDING.** Real publication composition is supplied; no artifact was uploaded or accepted by an authority.
- [x] M3 Production VM adapter/controller and truthful guest capability wiring, reviewed cumulatively. **IMPLEMENTED / SOURCE-REVIEWED / VALIDATION-PENDING.** See `vm-integration-2026-10-18`. Inherited writable isolation/integration HOLD remains a separate prerequisite; no claim of closing it.
- [ ] M4 Compile/test/operational acceptance and activation. **SEPARATELY GATED, NOT STARTED.**

The checked source substeps do not mean R4 or the overall end goal is complete. The standalone VM session reports `not-collected` and retains its slot. The integrated adapter separately verifies guest results and the supervisor finalizes only after the controller hooks; independent authority verification still decides success.

### M1/M2 dependency and evidence detail

- [x] GIO1 Actual context pins inputHash/projectId → immutable manifest/segments → file and packed-object hashes; baseline/preimages preserved.
- [x] GIO2 GIO1 → branded guest job → exact request/hash → root-only create-only image assembler → concrete guard acceptance and fresh verification through launch/stop.
- [x] GIO3 GIO2 + observed startup + actual stop → same-inode raw hash → root-owned raw copy → readonly bounded extraction → root-owned sealed result image.
- [x] GIO4 GIO3 → guest v2 exact lineage/outputs/directories/modes/log checks → private receipt → real broker scope/capacity/writer → independent published-byte verification. No authority-success promotion.
- [x] GIO5 GIO1–4 → six inline source-review passes and repairs → source hashes/diff, findings register, revised route.
- [ ] GIO6 Compile and exercise all deferred acceptance cases with matching approvals. **GATED.** Source review is not runtime validation.


### M3 dependency and evidence detail

- [x] M3.1 One branded host reservation and supervisor-owned finalization; lease runway/cancellation carried into VM permits.
- [x] M3.2 Verified source/job → durable operator I/O mailbox → actual guarded staging → VM → actual stop → owner intake → independently accepted guest outputs.
- [x] M3.3 Concrete authenticated controller factory, real post-claim publication and stop/stage commands; no fake restore receipts or helper-exit success.
- [x] M3.4 Owner-approved image/runner/helper capability pins, guest observation source, fresh census matching/renewal fencing and truthful operator view.
- [x] M3.5 Six inline source-review passes, repaired findings, scoped hashes/diff and updated route.
- [ ] Inherited prerequisites: concrete generic writable CAS/materialization isolation and cumulative integration HOLD. Not closed by this batch.
- [ ] M4 and R7 remain separately gated. Owner I/O and image provisioning are explicit operational steps, not an installed unattended service.


## Writable storage and integration batch — current 2026-10-18 stopping point

- [x] W1 Concrete Mac root-owned immutable CAS and bounded authenticated local client implemented; not installed or executed.
- [x] W2 VM adapter/intake and readonly packaging wired to the concrete store; no fake exclusive seal.
- [x] W3 Original findings re-reviewed; direct short-client authority checks/physical occupancy, relay cancellation occupancy, complete tree diffs, positive absence, exact merge tree/genesis/replay and persisted verification repaired in source.
- [x] W4 K11 rollout receipts/source absorbed and hashed; external lane and natural-canary/Fabric boundaries preserved.
- [x] W5 Six inline source-review passes and corrections; scoped evidence frozen; route updated.
- [ ] Generic Linux writable materialization remains an engineering gap. This is not hidden inside an operational approval gate.
- [ ] G3 strict verification policy selection; actual installed resources/pins/schema, per-project readiness and disk headroom.
- [ ] Independent acceptance, M4 compilation/tests/runtime validation and R7 activation; all still gated.

Current route: `R6-writable-integration-source-reviewed-HOLD`. Detailed evidence and exact supported scope: `writable-integration-2026-10-18/README.md`. This supersedes earlier generic Mac CAS/integration blocker wording without changing frozen historical receipts. No full-fleet completion or operational success is claimed.


## Linux isolation — current source stop, 2026-10-18

- [x] L1 Narrow root broker, private allocated workspace filesystem, fixed recipe policy, durable slot and independent cgroup watchdog.
- [x] L2 Actual broker-admitted v1/v2 source bytes -> bounded stream -> double hash verification -> exact recipe execution -> permanent stop-gated capture.
- [x] L3 Concrete production controller/factory/publication/census integration; legacy shared-UID Linux execution denied.
- [x] L4 Six inline source passes, counterexample repairs, explicit limits and deferred acceptance.
- [x] L5 Updated route and scoped before/after evidence.
- [ ] Independent cumulative source acceptance and approved M4/R6 compilation/tests/runtime validation.
- [ ] Actual owner-approved policy/resources/installed pins and remaining G3/schema/project/Mac capacity prerequisites.
- [ ] R7 activation/provisioning/publication/spending/cleanup approvals and execution.

Current stop: `R6-linux-isolation-source-reviewed-HOLD`. The generic Linux writable-seal gap is superseded for the concrete pilot path, not implemented as a pretend universal seal. The pilot deliberately retains its root slot, disk, cgroup, socket and evidence after one attempt; automatic reuse/reclamation is not supplied. See `linux-isolation-2026-10-18/README.md`. No tests, compilation or operational changes occurred. Historical checked/unchecked rows above remain dated evidence, not current operational completion claims.
