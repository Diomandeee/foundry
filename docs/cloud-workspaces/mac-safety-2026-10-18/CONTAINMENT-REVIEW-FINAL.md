# Final independent containment follow-up — 2026-10-18

**Rating: REQUEST_CHANGES — one new MEDIUM compatibility finding (R5). R1–R4 are closed by source inspection.** No new containment bypass or false stop-proof path was identified in this bounded follow-up. This is a working-source receipt during concurrent editing, not compilation, runtime validation or production admission. The earlier independent report is preserved.

## Review: packages/build-runtime/src/mac-vm-job.ts:37,65; packages/build-runtime/native/mac-vm-host.swift:233,282

**Severity**: MEDIUM — P2, job-artifact compatibility

**Issue**: R5. The encoder accepts a canonical guest job up to **1,048,576 bytes**, but the native helper admits and hashes `input/job.json` only up to **262,144 bytes**. The launch client checks the branded job's digest but not this smaller native limit before reserving/spawning. Consequently an encoder-accepted, correctly provisioned job between these bounds is deterministically refused by Swift, leaving an unknown/quarantined attempt instead of running. The range is reachable: the encoder permits 1,024 files and `plans.ts:15–16` permits 240-character relative paths. Their path strings plus 64-character digests alone can exceed 256 KiB while remaining below 1 MiB after ordinary record encoding. This is fail-closed incompatibility, not an execution escape; no example was generated or executed.

**Fix**: Choose one explicit job-byte budget across encoder, launcher, native artifact admission/hash, and guest reader. Prefer rejecting oversized canonical jobs in the encoder and checking the same budget before durable reservation/spawn. Keep the native bound. Changing only the hash-read bound leaves the artifact-open bound inconsistent.

## Prior-finding dispositions

| Finding | Disposition and source evidence |
| --- | --- |
| R1 — challenge duration mismatch | **Closed.** Swift `400–407` emits a one-second deadline delta; TS `129–134` checks exactly `1000000000n`. The 500 ms nonce generation is a separate enforced bound. |
| R2 — ACL rendering as emptiness proof | **Closed.** Swift `120–139` requires successful `fstatx_np` plus `filesec_query_property`, distinguishes absent ACLs, rejects nil/sentinel ACL handles, obtains the first actual entry and captures errno before freeing. Existing entries (`0`) are refused; only the Darwin empty/out-of-range result (`-1/EINVAL`) is accepted after successful free. The security decision no longer uses `acl_to_text`. This matches the directly inspected C guard's approach (`mac-tree-guard.c:71–89`). |
| R3 — interpreter scripts accepted as VM helper | **Closed.** TS `mac-vm.ts:47–57` checks four bytes of native Mach-O/fat magic on the already-open FD, hashes that FD, and compares stable descriptor/path metadata. It completes before the reservation and spawn (`90–94`). This closes the identified script-format gap; it does not independently prove signing or reviewed binary provenance. |
| R4 — preflight deadline could not settle the caller | **Closed.** `mac-readonly-seal.ts:134–143` races verification against fatal/deadline, handles both late outcomes and tracks `verificationPending`. Verification contains no spawn; the sole spawn remains after the failed/abort check (`145–147`). Poison prevents reuse (`118,125–128`), even while verification/FD cleanup remains pending. `state()` exposes that retained uncertainty (`15–16,116`). `active:false` alone is not a claim of resource completion. |

The ACL interpretation was established in the first pass against Apple's [entry implementation](https://github.com/apple-oss-distributions/Libc/blob/main/posix1e/acl_entry.c#L109-L136) and [filesec presence query](https://github.com/apple-oss-distributions/Libc/blob/main/gen/filesec.c#L294-L328). This follow-up inspected the changed application source; it did not exercise Darwin APIs.

## Actual updated VM protocol and closure compatibility

| Direction / message | Fields and source agreement |
| --- | --- |
| Parent → helper: initial config | Swift `92` requires exactly 18 fields, including `guestJobSha256`; its flat parser permits 18 (`55`). TS configuration includes the digest (`14–17`), compares the canonical branded job digest (`78–80`), then sends configuration on the existing channel. The owner-installed `input/job.json` is opened and hashed by Swift before admission and again before start. R5 concerns the inconsistent artifact byte budget, not the digest binding. |
| Helper → parent: challenge | Exactly `event`, `identity`, `nonce`, `generation`, `createdContinuousNs`, `deadlineContinuousNs`. Swift `400–407` emits and TS `129–134` validates the one-second delta, sequential generation and nonce shape. |
| Parent → helper: permit | Exactly `event`, `identity`, `nonce`, **`validForMs`**. TS `143–146` obtains current `remainingMs`, rejects nonfinite or sub-millisecond runway, floors it and caps it at 1,000. Swift `421,429–434` requires these four keys and an unsigned integer from 1 through 1,000. |
| Parent → helper: stop | Exactly `event`, `identity`; Swift `417–419` accepts it and permanently closes admission. Parent sends it then ends stdin (`mac-vm.ts:110–114`). EOF after STOP does not reopen or poison the clean terminal path. Unexpected EOF remains a fault. |
| Helper → parent: started / stopped | `event` and `identity` only. Parent checks order/key count (`147–155`); started requires an issued permit. A returned session may still be starting. Stopped is not inferred from process disappearance. |

**Permit expiry:** Swift computes `min(challengeCreated + validForMs × 1,000,000, challengeDeadline, runDeadline)` and refuses it if already elapsed (`431–432`). Using challenge creation, which precedes the parent's current-budget observation, is conservative: channel/queue delay does not add authorized time. Generation supersession at 500 ms, one-use nonce consumption, terminal status, and `expired()` still apply. Metadata/job verification completes off main, then the only physical start rechecks generation and expiration on the VZ queue (`441–454`). A late permit or completed verification cannot reopen terminal admission. This relies on the trusted `currentFence()` implementation actually reporting the controller's current continuous-time lease/deadline budget and checking cancellation; the helper does not query authority itself.

**Actual closure:** Swift seals admission first (`486–492`), waits for both `startPending` and `stopPending` to clear on a subsequent queue turn, and requires an attempted start plus actual `.stopped` observation (`494–504`). It emits STOPPED before exiting; a fault produces exit 2. The parent requires a valid terminal frame, no parser/diagnostic fault, exit 0, no termination signal and no trailing partial frame (`mac-vm.ts:169–173`). It then awaits durable journal finish under the stop observation deadline (`171–183`). Late clean closure cannot upgrade an already-resolved unknown outcome. The host slot stays quarantined even after confirmed stop. No output/result intake, build success, release or reusable host slot follows from this proof.

The sender and helper schemas now agree on `validForMs`. The public fence callback changed from returning void to returning `{remainingMs:number}` (`mac-vm.ts:68–69`); old callers and old three-key-permit helpers are incompatible and must be updated together. There is no fallback negotiation or implicit authorization from a protocol version number. Deploying a changed helper still requires the owner's actual rebuilt/signed/pinned artifact, outside this review.

## Final host/capacity admission delta covered here

The prior guest review predates this delta. **This follow-up explicitly read it:** `mac-vm.ts:86–90` now calls the imported concrete `validateHost(plan)` before helper pin/reservation/spawn. `host.ts:23–32` checks the dedicated UID/GID, activation permission, canonical private provisioned roots, attempt-specific work path and actual work-volume free space. The client then reads `statfs(dirname(c.bootDisk))`, requires `bavail × bsize >= max(50 GiB, approved minFreeBytes)`, and reads actual `freemem()` requiring guest RAM plus 1 GiB. These are real observation API calls in source, not injected capacity verdicts. Fence checks follow the awaited observations, and the existing post-pin/post-journal cancel/fence checks remain.

These checks are admission observations, not durable disk/RAM reservations or APFS quota evidence. This review did not call `statfs`, `freemem`, `validateHost` or the launcher, and makes no claim about this machine's current capacity or provisioned paths. No new source finding was identified in this admission delta.

## Readonly storage and remaining authority boundary

The native readonly guard still bases its promise on kernel `MNT_RDONLY`, root-mounted local volume identity, ACL-free protected ancestry, and owner-maintained static backing. READY precedes the callback; EOF releases only after callback settlement; native postflight/released plus clean child close are required for success. The new preflight race supplies prompt failure settlement without inventing cancellation of outstanding I/O. Restore/CAS retain a separate writable seal; no provided-read-seal failure falls back to it. Root administration, writable backing/raw device access, mutable live trees and quota proof remain outside this capability.

The VM API remains experimental and separate from `RuntimeAdapter`. Owner provisioning and a pinned native binary remain prerequisites; no writable host directory share/network or VM output-intake path is introduced by these fixes. The prior source-observed native adapter and authority denial are not relaxed by this follow-up.

## Verification boundary and freeze receipt

Only source reads, the previously consulted Apple primary-source evidence, and this report write were used. R1–R4 dispositions are source-level closures; R5 remains an open source compatibility finding at the final read. Concurrent product edits were preserved. Only `CONTAINMENT-REVIEW-FINAL.md` was written in this follow-up; its directory was created with `mkdir -p` and the report is verified with `ls -la` after writing.

RTD: **Structure / integration / content — bounded static inspection only. Compilation / runtime / user journey / deployment — DEFERRED by user.** No tests authored/run; no compile/import/probes; no helper, VM or service starts; no installation, cloud/spend, secret access, commit, deploy or cleanup. This receipt does not claim successful containment, stop, capacity admission, build, or production readiness in operation.
