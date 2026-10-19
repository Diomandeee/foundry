# M3 source review

Verdict: **M3 source scope closed; operational readiness HOLD**. Six inline passes by the implementing Codex agent, followed by an inline counterexample pass. This is not independent review and not executed verification. No compilation, tests or imports were used to establish these findings.

## 1. Structure and contract reading

Read `mac-vm-worker.ts`, `mac-vm-adapter.ts`, `controller.ts`, `types.ts`, `host.ts`, public exports and sibling storage boundaries. The concrete factory uses authenticated Node transport, real liveness, the approved profile and one VM adapter; no fake RestoreReceipt is passed through the legacy writable restore verifier. Existing Linux ports retain their required interface. A private host reservation is branded against the exact RuntimePlan, and `observeStop` cannot release it.

Cross-read TypeScript/Swift/Python schemas: host v2 has 19 fields (including bootSha256); guest job v2 adds guestCapabilityHash/guestRunnerSha256; result v3 checks both fields. All producers/consumers in this path were updated together. Old v1/v2 guest artifacts are intentionally not accepted by the new path. Types were read manually, not typechecked.

## 2. Authority, identity and transaction boundaries

Read additive immutable `build_vm_approvals` schema, `approveVm`, current enrollment/profile checks, claim projection, renewal, stop/stage/verify, and the authenticated HTTP wrapper. VM approval is a separate owner command; worker census cannot self-approve. Exact revision/profile/capability binding is checked at placement and again at controller preparation. Changed/stale census cannot renew a VM attempt. The authority's verifier remains independent of executor and submitter. No memory/model or Pi authority was introduced.

## 3. Lifetime, cancellation and recovery

Read supervisor reservation, initial/periodic renewal, request-start expiry, deadline, cancellation signal, startup timeout and late-return stop handling. Adapter preparation, owner waits, VM permits, intake and publication carry this scope. The native helper records actual callback-drained stop; the supervisor owns final release only after hooks return. Failed/late work keeps quarantine. Standalone containment calls still quarantine their own reservation. No restart replay/automatic unlock was added.

Counterexample: adapter.start ignores cancellation and returns later. The scope closes, the slot remains quarantined and the supervisor requests late stop; a new current permit cannot be issued. Counterexample: provider finishes publication after deadline. The controller's subsequent lease fence rejects staging and retains ambiguity. A stage already admitted just before timeout remains an owner-reconciliation case, never fabricated as success.

## 4. Filesystem and data integrity

Read source verification, private job brands, mailbox, staging guard, native boot hash and output FD binding, root copy/mount helper, intake and packaging. Requests are create-only and synced; public receipt publication is atomic/exclusive. Worker never invokes root Python/hdiutil/sudo. Receipt bytes are bounded and descriptor-read; actual readonly trees must still pass full content/provenance verification. Root helper intermediates remain private; originals and previous evidence are untouched.

Counterexample: forged receipt or mount identity. Concrete native guard and byte/provenance checks refuse mismatches. Counterexample: helper exit zero with no guest success. Adapter completion waits for accepted stop-gated result; no success derives from helper exit. Counterexample: different boot image/toolchain. Native exact boot hash, runner self-hash, actual toolchain observation and result binding reject the drift.

Apple's public header documentation lists the exclusive rename flag value used for receipt publication: [VFS_RENAME_EXCL](https://developer.apple.com/documentation/kernel/1646220-anonymous/vfs_rename_excl). This source check is not evidence the Python helper has executed successfully on a Mac.

## 5. Operator journey and honest state

Followed source flow from placement/profile selection through authenticated claim, exact snapshot, two operator I/O requests, VM/guest stop, actual artifact publication, staged-awaiting-verifier and independent result retrieval. Worker view labels guest and host toolchains separately. Durable request metadata is discoverable in the host inventory. No UI button or default grants activation. The pilot remains explicitly operator-mediated; no daemon/installer is pretended.

Counterexample: poll immediately refreshes census again before claim. Added signal-aware one-second pacing and refresh serialization; neither request is represented as reused freshness. Counterexample: empty metadata work roots hide VM disk usage. VM attempt storage is included, the lower free-space value is used, incomplete inventory blocks new admission and private/nested mounts are not counted as empty.

## 6. Governance and deployment boundary

Compared source edits with fresh preimages; preserved dirty baseline and the frozen M1/M2 evidence. No test files authored/changed for this batch. No external mutations, credentials, installed paths or live configuration created. The route distinguishes implementation/source review from validation/activation. Generic writable CAS, inherited integration HOLD, actual resources/accounts/images/binaries, M4 and R7 remain explicit blockers. Existing gate behavior was not changed by M3.

## Remaining acceptance, not inferred proof

TypeScript/Swift/Python compatibility, kernel/VZ behavior, root helper receipt publication, guest image boot/SDK compatibility, cancellation/restart races, real authority migration/HTTP/schema interaction, actual broker capacity/grants and final independent verification must all be exercised only after approval. Read `DEFERRED-ACCEPTANCE.md` and the inherited review registers. Source review does not remove these requirements.
