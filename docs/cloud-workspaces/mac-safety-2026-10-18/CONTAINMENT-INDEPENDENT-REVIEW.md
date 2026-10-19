# Independent Mac containment and readonly storage source review

Date: 2026-10-18. **Rating: REQUEST_CHANGES.**

Independent inspection of the actual working source, including concurrent additions to guest-job binding. This is not an atomic checkout or a review of a completed commit. No scoped staged diff was present when inspected; the implementations themselves were reviewed. Line references describe the source read during this review and may move as the other workers finish.

## Resolved during review: R1, challenge interval mismatch

Initial severity: HIGH — P1, protocol correctness. **Disposition: resolved by a concurrent worker; source-only re-read.**

The initial source pair disagreed: Swift sent creation plus 1 second while TypeScript required 500 ms. This was reported early. On the final read, `mac-vm.ts:127` requires `1000000000n`, matching `mac-vm-host.swift:392,398`. The deterministic first-challenge rejection is therefore no longer an open finding. No execution was performed to validate the change.

Timing interpretation remains important: the wire deadline is the 1-second expiration bound; nonce supersession is separately enforced at 500 ms (`391,417–419`). A permit must satisfy both. The fix retains an exact duration check rather than accepting arbitrary bounds.

## Review: packages/build-runtime/native/mac-vm-host.swift:120–130

**Severity**: HIGH — P1, fail-open ACL proof

**Issue**: R2. `noACL` treats a successful `acl_to_text` rendering of only `!#acl 1` as proof of no entries. Apple's implementation skips an entry with `continue` if qualifier/tag/flag/permission extraction fails, then can return the header and newline successfully. In particular, `acl_get_qualifier` allocates memory and can fail. An ACL containing a single entry can therefore appear empty to this check under that failure condition. This defeats the intended refusal on indeterminate permissions for ancestry, artifacts and shared input. The failure condition was established from Apple source, not reproduced on this host. See Apple's [ACL renderer](https://github.com/apple-oss-distributions/Libc/blob/main/posix1e/acl_translate.c#L606-L617) and [qualifier implementation](https://github.com/apple-oss-distributions/Libc/blob/main/posix1e/acl_entry.c#L139-L162).

**Fix**: Inspect presence and entries directly, as the C guard already does: require successful `fstatx_np`, query `FILESEC_ACL` presence, and, when present, obtain the ACL and inspect its first entry. Refuse entry existence and all indeterminate outcomes. Darwin reports an existing entry with **0**, and empty/out-of-range with **-1/EINVAL**; capture errno before freeing. Do not substitute Linux's 1/0 iteration convention or use a presentation string as security evidence. Apple's [entry implementation](https://github.com/apple-oss-distributions/Libc/blob/main/posix1e/acl_entry.c#L109-L136) and [filesec implementation](https://github.com/apple-oss-distributions/Libc/blob/main/gen/filesec.c#L294-L328) support that distinction.

## Review: packages/build-runtime/src/mac-vm.ts:46–53,87

**Severity**: MEDIUM — P2, native executable policy

**Issue**: R3. The VM launcher's pin check proves regular-file metadata and matching bytes, but never checks that those bytes are a native executable. A root-installed executable `#!` script with a matching owner pin passes the check and starts its interpreter before any Swift platform, channel, configuration or permit validation can run. This requires an incorrect trusted provisioning/pin choice; it is not an arbitrary unprivileged replacement attack. Nevertheless, the stated pinned-Mach-O-only contract is not enforced, unlike the storage seal's native-magic refusal. Direct process spawn does not prevent the kernel from selecting a script's interpreter. Apple's [execve documentation](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/execve.2.html) describes this behavior.

**Fix**: Reject interpreter/script and unsupported executable formats from the already-open pinned descriptor before reservation or spawn. At minimum enforce native Mach-O/fat magic consistently with the storage client, while retaining the exact binary digest, secure placement and owner signing requirements. Format checking alone does not attest a signature or reviewed implementation.

## Review: packages/build-storage/src/mac-readonly-seal.ts:125–137

**Severity**: MEDIUM — P2, deadline/API liveness

**Issue**: R4. The whole-operation timer and abort listener reject `fatal`, but prelaunch `await verifyHelper(signal)` is not raced against that promise. If a helper-path `lstat`, `access`, open, read, stat or close remains pending, the public operation remains pending after deadline/abort, despite its poisoned state. Signal checks between awaits do not interrupt an already-pending filesystem request. Helper-path validation does not first establish that every lookup is on responsive local storage. Later phases do race against `fatal`, making the deadline behavior phase-dependent. No stalled I/O was induced during this review.

**Fix**: Allow the public operation to settle on fatal/deadline while retaining explicit state for an outstanding verification and its eventual descriptor close. Keep verification separate from process launch, keep the instance poisoned, consume late rejection, and require the existing fatal/abort check immediately before any spawn. If retaining the current lifetime behavior deliberately, narrow the API's whole-operation-deadline claim to disclose that preflight I/O completion is unbounded.

## Source findings on the requested safety boundaries

These observations describe code paths, not a pass for containment in operation:

- **Launch fencing and stop proof:** Swift has one `vm.start` site behind terminal, generation and continuous-time checks (`434–441`). Admission metadata and guest-job digest work run on `artifactQueue` (`428–430`); stdin parsing and initial traversal run off main. Start/stop pending flags clear in another main-queue turn after their completion callbacks return. `driveStop` waits for both flags, requires an attempted start, observes `.stopped`, and retains the VM/descriptors for uncertain transitions (`481–505`). These paths do not infer stopped from EOF or process disappearance. Framework configuration and attachment construction still execute synchronously on main (`352–379`); source inspection supplies no bounded-latency guarantee for those calls.
- **Duplicate control, EOF and stale permits:** The flat parser rejects duplicate keys before constructing configuration/control objects. Permit key sets are exact; a consumed nonce becomes nil. Generation rollover, `expired`, and activation recheck reject stale work. STOP seals admission before touching VZ; terminal input cannot reopen it. EOF without a prior terminal stop becomes a fault; EOF after STOP does not poison that stop. No additional source-level reopen/false-stop path was identified in these branches.
- **Devices and entitlements:** Configuration contains two writable guest block-device images and one `readOnly:true` directory share, with network/socket/serial/audio/graphics/input devices explicitly empty (`366–375`). These are not writable host directory shares. The entitlement file contains only `com.apple.security.virtualization` (`5–6`); this entitlement is not evidence of signing, sandboxing, installation or current authority.
- **Filesystem truth:** The C guard requires actual descriptor/path read-only/local flags and root mounting identity (`172–194`), then rejects nested mounts and same-source/fsid aliases (`196–220`). Root-owned ACL-free ancestry is walked descriptor-relatively; symlinks, special descendants and regular-file hardlinks are refused. Its first-entry ACL check (`71–89`) uses the correct Darwin result convention. Readonly behavior comes from `MNT_RDONLY`, not its scan, advisory locking or retained root FD. Apple documents the flag and mounting-owner field in [statfs(2)](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/statfs.2.html).
- **Readonly lifetime/failure:** The storage client pins a native helper, passes explicit identity and nonce, requires READY before callback, retains stdin during a still-pending callback after failure, and requires RELEASED plus clean child close before success (`139–221`). Failure permanently poisons the instance; it does not retry, unmount, kill, or claim rollback. This is a reasonable fail-closed policy for uncertain state; generic retry/backoff would be inappropriate here. R4 concerns settlement during the earlier verification phase.
- **Read-side API composition:** `ManagedReadonlyTreeSeal` is separate from writable `ManagedTreeSeal` (`types.ts:42–51`). The optional `readSeal` is selected by output collection (`packaging.ts:44`), v1 source packaging (`snapshots.ts:56`), and v2 source packaging (`project-inputs.ts:46`); exports and `ProjectInputPackagingPorts` carry the addition. No catch-based retry through the writable seal occurs when a provided read seal fails. Omitting `readSeal` preserves the pre-existing trusted exclusive-seal path; that optional compatibility branch does not itself supply Mac containment. Restore/materialization and local CAS keep their separate writable capability.
- **Provisioning and authority limits:** Swift's static input check is root-owned 0555 directories / 0444 files, not a kernel readonly mount proof. Its pathname-based VZ attachment is conditional on the owner maintaining that protected static hierarchy. The C guard has the stronger readonly-volume contract. Neither proves immutable image backing, excludes root administration/raw block access, attests quotas, or turns guest-owned output into an ingestible root-owned static tree. Those are explicit provisioning boundaries, not silently implemented capabilities. `NativeMacAdapter` still denies prepare/start (`adapters.ts:19–25`); authority still rejects Xcode placement (`build-jobs/src/authority.ts:43`). The experimental VM primitive and a generic readonly collector do not establish a VM output-intake path or a production RuntimeAdapter.

## Review evidence and limits

Read applicable `AGENTS.md`, `PROTOCOLS.md`, and `SOUL.md` values. Applied evidence-first reporting, preservation of concurrent work and the explicit one-file ownership boundary. Reviewed Swift host/entitlements, C guard, readonly TypeScript factory, parent types/packaging/snapshots/project-input IO/project-inputs/index, with source-only supporting reads of filesystem/publication, VM client/guest-job binding, native adapter and authority denial. Apple primary sources were consulted for ACL, executable and filesystem semantics.

| RTD level | Evidence/status |
| --- | --- |
| Structure | Named implementations and exported interfaces inspected in working source. |
| Compilation | **DEFERRED by user.** No compilation, import or syntax/runtime probes. |
| Integration | Manual source comparison only; initial R1 mismatch was fixed concurrently and re-read. R2–R4 remain open. |
| Content | Branches, API semantics, identity, capability separation and failure paths inspected. |
| User journey/runtime | **DEFERRED by user.** No tests authored/run, helpers/VMs/services started, or filesystem races exercised. |
| Deployment | **DEFERRED by user.** No install, credentials, cloud/spend, commit, deployment or cleanup. |

Only this report was written. No product source, other report, ledger or memory file was changed by this reviewer. No blanket validation, host eligibility, successful build, successful stop, immutable live tree, or release readiness is asserted. R2–R4 require owner/worker resolution or explicit disposition; this reviewer did not implement fixes. R1 was fixed concurrently by another worker and is recorded above as resolved.
