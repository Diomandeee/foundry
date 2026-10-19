# Deferred validation protocol — NOT EXECUTED

User has not authorized tests, typechecking, builds, trial restores or service starts. This file defines later evidence; no item is a result.

## Gate A — Static receipt acceptance

Review exact diff/base/source hashes, inherited findings, trusted host port contracts, native stop containment, dependency policy and broker capacity. Source acceptance does not authorize runtime, merge or deployment.

## Gate B — Local software validation (requires explicit authorization)

Use installed dependencies only. Run appropriate package/root typechecking and relevant existing/newly authorized regression checks. Do not reinstall dependencies or alter lockfiles automatically. Record exact commands, source hashes, environment and failures; no acceptance from fixture-only or fake-provider passes.

Scenarios:
- Owner approvals bind exact input/profile/project; browser cannot submit argv, authority URLs, credentials, destination paths or recipes.
- Two workers race for one queued job; only one active attempt/slot commits. A legacy reservation and build cannot occupy one host simultaneously.
- Changed payload under an idempotency key rejects. Latest census replay does not refresh liveness. Old renewal/census sequence cannot refresh after successor acceptance.
- Lease renews beyond 60 seconds while enrollment heartbeat stays fresh. Maximum duration remains absolute. Cancellation/lost renewal initiates physical stop.
- Expiry commits even on rejected requests; clock reversal cannot revive work. Old attempts cannot mutate a successor or a terminal receipt.
- Journal restart at each activation/HTTP boundary never repeats execution. Lost response preserves request identity; uncertain state quarantines.
- Worker revocation/rotation/epoch change during input read, execution, output write, broker read or verification denies stale work/results.
- Required outputs must all exist; no empty success manifest. Every chunk generation/hash/size and complete file hash must match actual bytes. Larger files reassemble from bounded chunks. Empty file representation is explicit, never omitted.
- Read grants cannot cross project/attempt/worker/ref scope. Browser receives verified chunks without broker grants or credentials. No output is accepted merely from worker-reported exit code.
- Broker namespace count/byte limits reject before publication. Failed/unknown operations retain reservations/history; no reset or pruning pretends to regain capacity.
- Path traversal, symlinks, Unicode/case collisions, parent replacement, hardlinks, mode changes, unsafe ownership and existing destinations fail closed.
- Uncooperative provider/credential/stream ports cannot deliver late success or erase held occupancy after caller timeout.

## Gate C — Real restores and builds (additional installation/provider/spend approvals)

1. Restore one selected source snapshot on Mac1, then Mac4/Mac5 using actual scoped access. Verify byte/mode lineage and no overwrite. Do not rely on Mac1 relay for final acceptance.
2. Reconcile required assets, lockfiles, submodules, LFS and preloaded dependencies; reject an intentionally incomplete project. Preserve history independently before claiming full repository recovery.
3. On approved Linux host, run an offline bounded build using pinned image and captured immutable inputs. Record actual stop/inspection and independently verified artifacts.
4. On a compatible Mac with adequate headroom and approved account/containment, run one unsigned Xcode build with exact Xcode build number and SDK. Verify outputs and debug symbol handling where applicable. This proves compilation only, not functional correctness or release readiness.
5. Exercise kill-mid-lease and network loss with actual processes, including native descendant uncertainty. No re-placement until stop confirmation or explicit owner reconciliation.
6. Demonstrate browser project selection → input/profile → placement → submit → attempt → verified artifact download on each Mac. Check stale/disconnected/disabled/error states and request retry identity.

## Gate D — Storage reclamation (separate approval)

D1: approved cleanup of identified regenerable data may be needed before the native build in Gate C; it requires its own exact-target approval. D2: removal of original project copies remains after successful recovery evidence. Inventory current ownership and activity again. Propose exact regenerable targets and independently preserved originals. Show bytes, what is excluded, restore evidence, active-work checks and rollback limits. Approve before deleting anything. Do not equate du estimates to immediately reclaimable APFS capacity. Preserve release archives, debug symbols, histories, active caches and unknown ownership.

## Gate E — Integration and activation

Inherited merge-gate HOLD findings must be resolved or explicitly dispositioned under existing governance. Run required gate checks only after authorization, then obtain merge/deployment approval. Record real publication generations, installed client versions, worker identities, authority epoch/profile hashes, actual endpoints and next stop. No gate is satisfied by this document.
