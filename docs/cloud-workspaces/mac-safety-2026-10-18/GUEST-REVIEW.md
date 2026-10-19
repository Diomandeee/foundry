# Independent source review — macOS VM primitive

2026-10-18. Rating: **REQUEST_CHANGES** for the source findings below. No execution, activation, production-adapter approval, or stop/build attestation is granted.

## Scope and evidence

Reviewed only these product sources, as current working-file contents, not a staged-diff review:

| Source | SHA-256 at review |
| --- | --- |
| `packages/build-runtime/native/mac-vm-guest.py` | `a6078cafe0029dfd0f8ac41dde181d9bd3587360d57151b7c1270779f9260531` |
| `packages/build-runtime/src/mac-vm-job.ts` | `e782964620ee66c363d7fab25e8260f0fa5f5df8e96389a8dbfc37c4aeae2587` |
| `packages/build-runtime/src/mac-vm.ts` | `0092c1f24d4c0ca360f12efd1ecb84bf766f0b3082539a1f33f54bfbfcb19d01` |

Line references below belong to these versions; concurrent parent edits can supersede them. Read applicable ancestor AGENTS.md, PROTOCOLS.md and SOUL.md values. Stayed inline and wrote only this report: no task ledger, memory write, subagent, tests/test authoring, compilation, product imports, runtime probes, helper/VM launch, installation, provider operation, spending, credential access, commit, deployment, cleanup, or product edit. Imported implementation dependencies and the Swift helper are outside this review, so their behavior is not established here.

This is an inert guest runner plus an explicitly experimental containment client, not a production RuntimeAdapter. Readonly host virtiofs, no writable hostshares/network, owner-provisioned fixed-capacity boot/output disks, and secret-free images are supplied boundaries. Disk capacity bounds eventual storage consumption; it does not make a copy respect the smaller result budget or make blocking I/O terminate. Existing authority/native launch denial remains the required boundary; changes outside the three reviewed files were not independently checked.

## Review: packages/build-runtime/native/mac-vm-guest.py:202-225

**Severity**: HIGH — P1
**Issue**: Root output collection checks build-owned paths and subsequently reopens them. `resolve`, `lstat`, `digest_file`, and `open(item, 'rb')` operate at different times; the final open follows symlinks. Even `digest_file` protects only the final component with O_NOFOLLOW, not replaced ancestor directories. Successful xcodebuild exit/pipe EOF does not stop detached descendants. A surviving build process can rename an output directory or replace a file after a check, causing the root collector to read outside the selected tree or block opening a FIFO. The final digest comparison occurs after the unsafe read. This is a guest privilege/intake/resource defect; it is not evidence of a VM-to-host escape.
**Fix**: Use descriptor-relative traversal with no-follow checks on every component and validated regular-file descriptors. Copy/hash from the same descriptor, with metadata rechecks, into a root-owned destination tree that the build user cannot alter. Retain independent post-stop host verification; process-group kills cannot close this trust gap.

## Review: packages/build-runtime/native/mac-vm-guest.py:142-149,174-225

**Severity**: HIGH — P1
**Issue**: Copy budgets do not constrain the copy itself. After hashing an output within budget, the collector reopens it and calls `copyfileobj` until EOF. Its `length=1024*1024` is a buffer size, not a total byte limit. A descendant can grow or replace the file after hashing, making the collector fill the output disk or run without reaching EOF. The build deadline is not checked during traversal/copy/fsync. The input path likewise reopens a previously hashed source with `shutil.copyfile` and checks the destination only afterward; a readonly guest mount does not itself prevent host-side mutation. Fixed disk capacities limit damage but do not enforce the advertised result/input budgets or deadline.
**Fix**: Copy from the checked descriptor using a decrementing total-byte allowance; reject growth/extra data, and verify size/digest/stability on that same stream. Apply a deadline across staging, observation and output handling, and require a separately bounded host whole-VM watchdog. Do not rely on Python deadline checks to interrupt an already-blocking filesystem operation. Ensure the host snapshot remains immutable for the mount lifetime.

## Review: packages/build-runtime/src/mac-vm.ts:90-104,122-123,150-153

**Severity**: MEDIUM — P2
**Issue**: Stop requests are not idempotent. `requestStop` sends a stop frame and ends stdin every time, without recording that shutdown was already requested. Repeated `stop()`, abort followed by `stop()`, or a buffered challenge arriving while `phase==='stopping'` can write after `.end()` while the stream is not yet destroyed. That raises a stream error routed through `fail`, poisoning otherwise valid stop evidence as `unknown`. It can leave the caller retaining a reservation despite an orderly helper stop.
**Fix**: Track stop-requested/channel-ended state separately from terminal evidence. Send and end at most once; suppress permits after that point and let subsequent stop requests observe the same settlement without writing another frame. Seal the channel similarly after the helper's terminal event.

## Review: packages/build-runtime/src/mac-vm.ts:86-109,134-154

**Severity**: MEDIUM — P2
**Issue**: The stated observation bound does not settle observation. Only the child `close` handler resolves `settled`. `fail`, startup timeout and maximum timeout merely request stop. There is no stdout EOF/error handling that completes a bounded observation path. A helper that becomes silent, closes stdout while remaining alive, or fails to exit after stop can leave `settled` pending indefinitely. The ten-second race protects explicit `stop()` callers only, and its timeout leaves the reported phase at `stopping` rather than transitioning to `unknown`.
**Fix**: Introduce a single bounded settlement path for observation failure/EOF and for a stop-acknowledgment deadline. Resolve `unknown` and report unknown state when evidence cannot be obtained in time; never turn timeout, EOF, process exit, or group kill into positive stop evidence. Keep the durable reservation held and define how later independent reconciliation can establish an actual stopped VM. Bound observation without killing the helper as a substitute for stopping the VM.

## Review: packages/build-runtime/native/mac-vm-guest.py:205-213

**Severity**: MEDIUM — P2
**Issue**: The output-entry cap is checked after `items.extend(item.iterdir())` has already materialized every entry in a directory. A wide directory can allocate far beyond the intended 20,000-entry cap before rejection. Moreover, popped directories are not included in the counter: a long chain or successive subtrees of empty directories can evade a cumulative entry limit. Traversal has neither a depth cap nor a deadline, and generated descendant path lengths are not bounded like selected roots.
**Fix**: Enumerate incrementally with a cumulative visited-entry counter checked before enqueueing, plus bounded pending entries, depth, relative-path bytes and elapsed time. Count directories as well as files. Reject excessive trees before materializing them.

## Review: packages/build-runtime/native/mac-vm-guest.py:66-70,95-97

**Severity**: MEDIUM — P2
**Issue**: Metadata/tool-output limits are enforced after allocation. `job.json.read_bytes()` reads an arbitrary-sized object before checking its 1 MiB limit and does not require a regular non-symlink file. An invalid staged job can exhaust guest memory or block before validation. `subprocess.run(...stdout=PIPE...)` similarly buffers all toolchain-observation output before the 64 KiB check. The encoder's own 1 MiB output check reduces the normal manifest case but does not make these guest checks bounded against malformed staging. The observation commands are owner-image tools, so their output risk requires a faulty/unexpected image rather than an ordinary project build script.
**Fix**: Open and validate a regular manifest descriptor, read at most limit+1 bytes, reject overflow and verify descriptor stability. Stream observation output with a hard byte limit and timeout, terminating that observation path on overflow instead of checking only after capture.

## Integration gates and completion semantics

- **Encoder lineage remains a caller precondition, not proof.** `mac-vm-job.ts:18-21` explicitly disclaims manifest verification. Lines 29,55-56 check reconstructability, required-path presence and hash syntax, but do not bind every selected path/digest/mode/size to the approved snapshot. No unsupported claim is made here that the encoder already verifies that snapshot. Before any launch integration, require a verified immutable snapshot receipt and complete manifest equality, and bind the canonical encoded-job digest to the attempt/VM configuration and eventual output intake. The encoder's returned digest describes its bytes; it does not prove approval of those bytes. Its returned Uint8Array also remains mutable despite the frozen wrapper, so recheck its digest at actual staging or retain a private copy.
- **Start semantics require helper reconciliation.** `mac-vm.ts:124-127` accepts `started` without tracking that a current-fence permit was previously issued. As written, `running` means only that the pinned helper emitted that event, and `launchMacVmContainment` returns while still starting. Confirm that the Swift helper enforces a fresh, one-use permit immediately before actual start; otherwise add explicit protocol-state validation. Do not treat obtaining a session as proof that the VM started or that the lease remains current. Fence exceptions during challenge handling do fail closed through the parser catch.
- **Stop evidence stays separate.** Positive evidence currently requires a matching terminal event, a clean helper close and no invalid/pending frame (`mac-vm.ts:128-146`). EOF/exit alone is correctly insufficient. The client cannot establish from these files that the helper emits `stopped` only after authoritative VZ whole-VM stop; that is an unreviewed integration contract. A guest result, guest shutdown request, build exit, or process-group kill is never stop proof.
- **Result remains uncollected.** The TS evidence consistently says `result:'not-collected'`; preserve that distinction. After independently proving actual VM stop, independently verify guest result schema, attempt/job/profile/source bindings, complete output allowlist, bounded regular files and sizes/hashes through an approved readonly extraction path. Treat all guest receipts and bytes as untrusted even after stop. No guest self-report alone establishes approved lineage or successful build.
- **Failure diagnostics are insufficient for recovery.** `mac-vm-guest.py:237-248` collapses all failures to one label, silently ignores failure-receipt errors, and does not inspect/bound shutdown completion. Preserve fixed safe stage/error codes without paths, source, argv or arbitrary exception strings. The future host watchdog must retain unknown state/reservation if shutdown or failure reporting fails; do not infer success from runner completion or a missing failure receipt.
- **Pending work remains pending.** Image installation, actual guest toolchains, readonly result extraction, helper/config contract reconciliation and production dispatch are not demonstrated. No automatic retry/start or fallback to native execution is authorized by this review.

## Resolved during concurrent parent edits

The initial client snapshot (`97c328e20cbc66c63d74e95e68ee50243c7ec9ca8966e6e590024cd490a54086`, former lines 63-73) pinned `policy.executable` and reread that mutable property after awaits. Reported early as HIGH/P1. The current reviewed snapshot copies the full policy into private `owner` data at line 71 and consistently pins/spawns `owner.executable` at lines 79,82. That specific mutable-reference gap is **resolved by static inspection**, contingent on the declared canonicalData plain-data contract; its implementation was outside scope. No runtime validation or broader helper approval is implied. The latest source additionally checks helper-path writability and named-file identity; those checks do not resolve the remaining lifecycle findings.

## Six static review lenses

| Lens | Source assessment |
| --- | --- |
| Correctness | Found non-idempotent stop writes. The initial mutable executable selection finding was resolved in the concurrent parent revision. |
| Security | Found root path-reopen races; no shell interpolation, hardcoded secret or SQL operation observed in these three files. This is not a broader security attestation. |
| Resources | Found unbounded copy/traversal/allocation paths and missing whole-operation deadline enforcement. |
| Failure/recovery | Found potentially unbounded settlement; generic guest failures lose safe diagnostic classification. Unknown containment must retain reservation. |
| Integration/lineage | Encoder snapshot verification and Swift start/stop semantics remain explicit unverified contracts. |
| Content/truth | Experimental scope and not-collected result are appropriate; neither runner code nor helper-channel closure proves a completed verified build. |

## RTD verification boundary

| RTD level | Status |
| --- | --- |
| Structure | STATIC REVIEW ONLY: three named sources read with numbered lines and source hashes. No imported implementation inspected. |
| Compilation | DEFERRED BY USER: no compilation, imports, lint, tests, test authoring or executable probes. |
| Integration | STATIC CONTRACT REVIEW ONLY: the three named sources compared; helper/config compatibility, verified snapshot and production integration unverified. |
| Content | STATIC REVIEW ONLY: limits, failure paths, lineage and completion claims assessed. |
| User journey/runtime | DEFERRED BY USER: no helper/VM start or end-to-end execution. |
| Deployment | DEFERRED BY USER: no installation, provider operation, production dispatch, release or deployment. |

Review conventions recorded here: budget before allocation, copy/hash the same safely opened descriptor, preserve unknown containment on lost evidence, separate VM-stop proof from result verification, and treat serialized source hashes as claims until independently bound to approved inputs. No separate memory file was written under the report-only instruction.
