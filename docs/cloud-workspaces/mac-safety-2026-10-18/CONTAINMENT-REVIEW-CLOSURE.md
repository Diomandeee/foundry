# Containment review closure — 2026-10-18

**Rating: APPROVE for this bounded source delta. R5 closed; its alleged reachable runtime incompatibility is retracted. No new findings in this repair.** This supersedes the R5 finding and resulting REQUEST_CHANGES rating in `CONTAINMENT-REVIEW-FINAL.md`. Earlier reports remain preserved.

## Review: packages/build-runtime/src/parent-profile.ts:29; packages/build-runtime/src/mac-vm-job.ts:7,67; packages/build-runtime/src/mac-vm.ts:78

**Severity**: INFO — correction and disposition

**Issue**: The previous review compared the encoder's explicit 1 MiB check against Swift's 256 KiB bound without accounting for the earlier `canonicalData(job)` call. That function already rejects encoded data over **262,144 bytes**. The same restriction is present in the saved `preimages/packages/build-runtime/src/parent-profile.ts.before:29`. Therefore the asserted encoder-accepted job above 256 KiB was not reachable through that path. The prior counterexample and its MEDIUM runtime-failure characterization were incorrect. The conflicting explicit limit was a clarity/contract inconsistency, not evidence of an actual oversized-job launch.

**Fix**: Verified in source. The exported `MAC_VM_JOB_MAX_BYTES = 262144` is used by the encoder and launcher; native host and guest retain the same byte bound. The launcher enforces the explicit budget before helper pinning, durable reservation or process launch. No remaining change is requested for R5.

| Layer | Source evidence | Bound |
| --- | --- | --- |
| Encoder | `mac-vm-job.ts:7,67`: exported constant and explicit encoded-byte check after canonical serialization. `parent-profile.ts:29` independently enforces the same bound. | 262,144 bytes inclusive |
| Launcher | `mac-vm.ts:10,78`: imports the constant and checks `Buffer.byteLength(guestEncoded)` before helper pin (`91`), reservation (`93`) and spawn (`95`). Existing canonical-job digest binding remains immediately after the byte check (`79–81`). | 262,144 bytes inclusive |
| Guest reader | `mac-vm-guest.py:85–98,235`: `read_regular(..., 262144, ...)` validates the file size before reading, then checks EOF and stable metadata. | 262,144 bytes inclusive |
| Native host | `mac-vm-host.swift:235,283–284`: both artifact opening and descriptor-based job hashing retain `262144`. | 262,144 bytes inclusive |

The checks measure encoded bytes/file size, not JavaScript character count or declared metadata. Canonical serialization and digest binding remain in the inspected path; the repair does not negotiate a larger job format or weaken native admission.

## Scope and closeout

This follow-up was restricted to the byte-contract repair and the serialization prerequisite needed to correct R5. It did not reopen the protocol, ACL, executable-format, readonly lifetime, host-capacity or authority reviews. R1–R4 remain source-closed as recorded in the previous final report; those dispositions are carried forward, not newly runtime-validated. No unrelated product edits were made or requested by this reviewer.

Only this closure report was written. The exact report directory was created with `mkdir -p`; the report is verified with `ls -la` after writing. No product code or earlier report was changed.

RTD: structure/integration/content checked by bounded source inspection. Compilation, runtime/user journey and deployment remain **DEFERRED by user**. No tests authored/run, compilation/import/probes, helper/VM/service starts, installation, cloud/spend, secrets, commit, deployment or cleanup. Source approval of this repair is not production admission or evidence of operational containment. **Review closed.**
