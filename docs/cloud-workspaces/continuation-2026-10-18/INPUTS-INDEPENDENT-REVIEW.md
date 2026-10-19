# Independent segmented-input/runtime source review

**Rating: REQUEST_CHANGES — 2 HIGH, 2 MEDIUM findings.**

Repository: `/Users/mohameddiomande/Developer/foundry-integration/source`. Candidate label supplied by parent: dirty `@cf27ac6`; no Git command was used to verify that label or establish a diff. Findings apply to the on-disk source hashes below, inspected on 2026-10-18. Product files were not edited.

Scope: `project-input*.ts`, `local-refs.ts`, `local-store.ts`, `restore-file.ts`, `filesystem.ts`, and v2 integration in runtime `storage-integration.ts`, `receipts.ts`, `controller.ts`. Adjacent TypeScript contracts/helpers were read only to trace these boundaries; adapter inspection was limited to the Linux input mounts/working directory. Broker grant authority belongs to the parent reviewer. Native implementation review is excluded; empty-file output receipt semantics are covered narrowly below.

RTD: structure, static integration, content and source-traced user journey only. Runtime, compilation and deployment are **DEFERRED / FORBIDDEN** under this assignment. No tests, test authoring, builds, typechecks, product imports/execution, probes, services, cloud access, spend, credential inspection, Git or deletion were performed. **All limits remain operationally unvalidated.** Counterexamples below are reasoned from source, not executed reproductions.

## Review: packages/build-runtime/src/storage-integration.ts:24,49–57

**Severity**: HIGH

**Issue**: The v2 input configuration requires an already attempt-bound scope and broker ports before the controller has obtained the actual claim. `createStorageBuildWorkerController` constructs its ports before `run`/`pollOnce` (140–141), but `restoreInput` requires exact equality between the configured compute fence and the controller-created context (53–54). The actual attempt ID, generation/incarnation and capability digest enter that context only after the claim reply (`controller.ts:160–179`). Unlike `resultScope`, there is no input-port resolver receiving that context.

**Counterexample**: Construct the controller with approved namespace N and scope for previous attempt P, then claim fresh attempt A. The input snapshot and owner policy can be valid, yet restoration always fails `project-input-scope-binding`. A subsequent claim also cannot use the same unchanged configuration. Successful wiring requires an out-of-band mutation of `config.projectInputs`, for example inside the transport's claim callback, rather than a supported post-claim binding step. The directories have already been created at 46 before this failure.

**Fix**: Resolve the scoped v2 input ports from the validated private `BuildAttemptContext` inside `restoreInput`, analogous to `resultScope`. Keep owner-approved namespace/policy pins immutable, bind the returned scope and every namespace to the actual compute fence, then create destination directories. Do not weaken the equality check or expose the raw capability.

## Review: packages/build-runtime/src/receipts.ts:36–43

**Severity**: HIGH

**Issue**: The independent v2 verifier rechecks only `plan.inputRoot`. For npm/cargo the concrete composition creates a second input copy at `plan.workRoot/source` (`storage-integration.ts:61–62`), and the adapter runs in `/work/source` (`adapters.ts:135–138`). Checking that `workRoot` is a canonical directory does not verify that copy's bytes, required files or absence of undeclared files. The v2 branch returns immediately after checking the other tree.

**Counterexample**: A restoring host port supplies a correct, pinned `/input` tree and the correct local snapshot, but leaves a stale `Cargo.toml` or an extra `.cargo/config.toml` in `workRoot/source`. Every condition in this v2 verifier can pass while cargo consumes the stale or undeclared input. This matters even without dishonest receipts: `materializeProjectInputSnapshot` restores selected files but does not reject all unrelated destination entries (`project-inputs.ts:162–172`); the later independent inventory currently covers only `/input`.

**Fix**: For Linux npm/cargo plans, independently call `verifyLocalProjectInputSnapshot` on the exact working-source copy too, with the same pinned snapshot, byte cap, seal and authority-lineage checks, before preparation is acknowledged or execution starts. Derive whether that copy is required from the approved plan/recipe rather than trusting a receipt flag. Retain the existing `/input` verification.

## Review: packages/build-runtime/src/storage-integration.ts:55–60,140–141

**Severity**: MEDIUM

**Issue**: The concrete importer and materializer enforce `config.projectInputs.maxBytes`, while the controller's independent `maxInputBytes` is not supplied to them. The latter is checked only after `restoreInput` completes (`controller.ts:198–199`; `receipts.ts:40`). Two independently configurable limits can therefore allow source downloads and filesystem writes that the worker policy will inevitably reject.

**Counterexample**: Set `projectInputs.maxBytes` to 128 MiB and the controller cap to 1 MiB. A valid 2 MiB snapshot passes the importer root-total check (`project-inputs.ts:110`), fetches all source objects, fills CAS, restores `/input` and possibly the working copy, then fails the controller verifier's byte-budget check. The tighter cap did not bound hydration or restoration, and partial evidence remains for reconciliation.

**Fix**: Establish one effective cap, `min(projectInputs.maxBytes, controllerMaxInputBytes)`, before hydration and pass it to population, both materializations and independent verification. Alternatively reject inconsistent construction-time policies. The root total should stop an over-cap snapshot before source object reads and destination content writes; bounded root metadata reads may still be necessary.

## Review: packages/build-runtime/src/receipts.ts:33–42

**Severity**: MEDIUM

**Issue**: The v2 verifier never establishes `input.manifest.sha256 === input.snapshotHash`. It authenticates the receipt manifest against `input.manifest`, but binds the separately verified local root to `input.snapshotHash` using only equal byte lengths between the two roots. The v1 branch explicitly checks the receipt-byte digest against `snapshotHash` at 45; the v2 branch skips that check.

**Counterexample**: Let A and B be valid v2 roots of equal encoded length, same project/git/required list and counts, but different segment digests/file contents. An inconsistent approval with `snapshotHash = SHA256(A)` and `manifest = ref(B)` passes the structural `InputApproval` validator. A host receipt containing B's manifest bytes, A's local snapshot and a correctly restored A tree satisfies all current v2 verifier comparisons, although the approved provider ref and verified local snapshot name different roots. The job's input hash can validly hash that inconsistent approval. This is an independent-verifier defect: the concrete `populateProjectInputSnapshot` already rejects this split binding at `project-inputs.ts:107`.

**Fix**: Before version dispatch, require the authenticated manifest-byte digest and `input.manifest.sha256` both to equal `input.snapshotHash`. Keep the local-root digest/length binding and actual tree re-verification. This closes the verifier boundary for alternative `BuildWorkerPorts` implementations as well as the concrete importer.

## Static observations within the requested boundaries

- Packaging copies the request's root/scope and each selected/required item before asynchronous work. Global selected/required path collision checks and the selected-file stat/size/object planning pass precede its first provider publication (`project-inputs.ts:32–64,80`). No additional concrete packaging phase-order defect is asserted here.
- Segment validation checks exact file chunk counts, positive in-object ranges, whole-object coverage without gaps/overlap, cross-segment path/component collisions, totals, and required/missing consistency. Empty input files have zero ranges and must carry SHA256(empty). Population validates all metadata before source-object reads, then rehashes objects and whole files. Independent local verification inventories undeclared entries and rehashes restored bytes for the tree it is actually given.
- Local CAS uses deterministic two-level digest sharding, validates refs, bounds object bytes and sibling enumeration, rejects aliases/symlinks/hardlinks/nested devices, and performs durable byte readback in the concrete store. This is source-level evidence of checks, not capacity or filesystem validation.
- Input operation keys include the immutable scope and content/read-ref identity while excluding ordinal. The routed key reaches `capacity.reserve`; the exact returned reservation is explicitly forwarded to publication and grant issuance (`project-input-io.ts:21–30,72–86,98–105`; `publication.ts:5–13,22–37`). Namespace receipt search/reuse remains a trusted selector contract; broker authority and durability are not certified by this report.
- Actual controller contexts are frozen and WeakSet-branded, contain the capability digest rather than the capability, and are passed privately to restoration (`controller.ts:40–48,169–179,198`). Finding 1 concerns how the host obtains the corresponding input ports, not weakening that context boundary.

## Parent output correction and empty-file semantics

The parent's correction supersedes historical split-admission discussion. Current `packaging.ts:65–73` admits chunks plus the full 1 MiB manifest overhead before provider writes, with one stable output operation key. `writeResultManifest` uses `c.reservation` without a new debit (`127–129`); `CollectedOutputs.reservation` is nonnullable (`types.ts:65–68`). For all-empty outputs, `count + 1` still reserves one actual manifest artifact and its capacity. No zero-byte data object or dummy reservation is required.

Within the permitted receipt check, `receipts.ts:91–112` accepts zero-size regular outputs only with zero chunks, hashes the empty fold, requires real tar framing for tar outputs, and still verifies a nonempty published manifest. No empty-file receipt defect is asserted. This narrow acknowledgment does not extend the review to other output/native behavior.

## Source identity (SHA-256)

Paths are relative to the repository above. Core finding files and input implementation hashes were unchanged between the review reads and pre-report hash pass. `types.ts` changed during the review in line with the parent's correction; its final nonnullable signature was reread and is hashed here. This is a per-file identity record, not a claim of an atomic repository snapshot.

```text
dd8da3430457a0809314b9e0dd75d8bd5c4957ad7bc85825bd15ecb8aa8e7c1c  packages/build-storage/src/project-input-format.ts
f9293e88a0d0d19f0199261540a807e41d59557127bc6b5068ddb9df7e491b86  packages/build-storage/src/project-input-io.ts
3efbce345f16b8d1b431a098336d11036f9dde83444a4a511661ddf9fb6dd000  packages/build-storage/src/project-input-tree.ts
5e4b16cf33eb94f0461b6b0e167374a951da96afe4a78c53ddd0dae9cfaa6372  packages/build-storage/src/project-inputs.ts
834f0d87dae23ced8fa62a1b172953eca3fe62fc3b2639a4edb87d4b26c1a7f7  packages/build-storage/src/local-refs.ts
83d8e75db4580d006364fcc9c48cfa8d006b3ec42ace0bc446c180341fa27500  packages/build-storage/src/local-store.ts
8fb8e63bf559298e851bc58ffb357d9bc6adbabb94e9846867049186317dbdc9  packages/build-storage/src/restore-file.ts
b5e75e35a20009a5c622f586408cc4ec59c1507bea6c29e6d61f435b489689b3  packages/build-storage/src/filesystem.ts
d12e0c31fa04dc31fcbae819f87c3e4d8dd8c665b1c934485cc6bb63359c9ac6  packages/build-runtime/src/storage-integration.ts
d82cf75acb6c00c4be96161085f992bd617e76e15f5f167733b81d3fadb81926  packages/build-runtime/src/receipts.ts
2b4d0cedde9c30c298f7ee9d15df294e5a3076ac334ea1d0540325588284fad5  packages/build-runtime/src/controller.ts
f2f6e16cff143d2c279e5b235908e363cbdc971afc6e14563eff34eb0881e04b  packages/build-storage/src/checks.ts
3a2718eb6354806f381c71f282c7105693f031d54d3e87954ae7e88ec6a9a7e3  packages/build-storage/src/publication.ts
5d3c5fe821b8a211e97a2f7ed4475fb2728ff5ba55af23430f1c43ee7a673b7b  packages/build-storage/src/types.ts
871a85b5ee8f239b25c65fbc44e4df7c68d7d5c688c301c7817ccf45da5b10be  packages/build-storage/src/snapshots.ts
651403373c15460425862b4cbb93bd9c82923b7e365c3822f766a8f8a1f9ab35  packages/build-jobs/src/validation.ts
9dc7adc5d398231ccd6c83533d24b93f4dac5e387c44ae3d087ecdde09dfd27f  packages/library-jobs/src/data.ts
0e60572734cd16b0c6e6944ed727854d54fc50531d4942c10a991b19cd8fc283  packages/build-runtime/src/plans.ts
1601f455b0e867a1939bbc9f88cd6cd6ff9a9271fae78e03a4e7bd459c21062c  packages/build-runtime/src/types.ts
9fcb2cefb308a1212b025d82eb1c4b1099487f9bf78f532746a871661ef9f163  packages/build-runtime/src/parent-profile.ts
93574ed19d7ebadb700d6215ca7bda7dae0b49566431156b285b4a05b1739146  packages/build-runtime/src/adapters.ts
4cf09dde219f571cab1f30dbdae962be429295b130819a0c6e88a259b91751b4  packages/build-storage/src/packaging.ts
```
