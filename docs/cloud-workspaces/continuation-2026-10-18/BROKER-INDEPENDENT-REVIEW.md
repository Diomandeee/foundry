# Independent broker continuation review

**Rating: REQUEST_CHANGES.** Source-only review of the current continuation, including the parent's latest access-client abort race and GCS composition. The existing static hold remains in effect; this report grants no validation, deployment, or activation approval.

Repository: `/Users/mohameddiomande/Developer/foundry-integration/source`.

Read `/Users/mohameddiomande/PROTOCOLS.md` and the historical `docs/cloud-workspaces/continuation-2026-10-18/BASELINE.json` (`at: 2026-10-18T07:55:50.880629+00:00`). The three available scoped historical preimages match their baseline SHA-256 values. Used focused textual differences, not giant preimage dumps. The new host/client/composition files have no entries in that historical baseline.

No tests, builds, typechecks, product imports/execution, probes, services, cloud operations, Git operations, subagents, or product edits were performed. Only this report was written; no separate memory or task-ledger write was made. Supporting source reads establish integration behavior; they do not expand the product-change review beyond the requested broker continuation and `/v1/builds/access` addition.

## Review: workers/library-broker/src/build-host.ts:105–108

**Severity**: HIGH

**Issue**: Temporary enrollment-heartbeat staleness becomes an irreversible grant revocation. `authorize()` calls `deny()` for every `authorized:false` decision, and reconciliation repeats the same conversion at lines 194–195. The authority reports `valid:false` when enrollment freshness has elapsed even if the build lease is still live (`packages/build-jobs/src/authority.ts:52–57`). A fresh enrollment heartbeat can restore validity without changing the attempt's compute binding. For example, let the enrollment heartbeat become stale while the attempt remains RUNNING and its lease has ample runway; one read/reconciliation installs a local tombstone. A subsequently accepted heartbeat does not remove that tombstone: `build-host.ts:86` prevents any further remote recheck or issuance replay. The latest `build-online.ts:59–62` correctly treats a valid observation with insufficient remaining lease runway as uncertainty, but `valid:false` caused by temporary heartbeat staleness still returns `authorized:false` at line 63. Network exceptions are also correctly kept uncertain; authenticated negative observations still need finer classification.

**Fix**: Separate current denial/uncertainty from permanent revocation in the access decision. Return a classified reason backed by authoritative state. Fail the current operation for stale heartbeat and other recoverable conditions without installing a tombstone, retaining the new short-runway uncertainty handling. Persist revocation only for an explicit irreversible event or superseded immutable binding, and apply the same classification in reconciliation. Preserve fail-closed reads throughout; do not clear existing revocation history or automatically renew authority.

## Review: workers/library-broker/src/build-host.ts:125–130

**Severity**: HIGH

**Issue**: Losing a reservation receipt permanently consumes capacity with no replay/recovery API. Every successful `reserve()` generates a fresh random ID and includes every previous reservation in the lifetime totals. Consider a crash after the insertion/commit but before the caller receives or durably retains that receipt, before any provider call. Reopening succeeds, but retrying the same reservation creates another debit; a request that already reserved the full namespace byte or artifact limit cannot retry at all. The current API accepts only `{projectId,namespaceRef,artifacts,bytes}`, with no stable operation key, and exposes no trusted receipt recovery lookup. The latest explicit reservation parameters at lines 135,147,162 fix the earlier shared-selection/restart problem **when the caller retains its receipt**. They do not recover the lost-reply case. Higher-level collectors/importers also call `reserve()` afresh when restarted rather than recovering admission.

**Fix**: Give reservation requests a stable operation identity with exact-payload receipt replay, and carry/recover that identity across restart in the calling publication/import flow. Alternatively expose a narrowly bound trusted recovery lookup that unambiguously identifies the original operation. Reuse existing debits without refunding, pruning, or resetting history, and keep the new explicit reservation binding. This finding concerns replay of known durable admission, not automatic retry of an ambiguous provider side effect.

## Review: workers/library-broker/src/build-host.ts:175–177,210–212

**Severity**: MEDIUM

**Issue**: The caller's cancellation signal stops at the online broker boundary. Issuance calls `broker.admin.issue(grant)` without the supplied signal; the online API has no signal parameter (`packages/storage-broker/src/types.ts:76–79`) and creates its own controller (`index.ts:53–61`). The host's reader likewise checks cancellation only before and after `broker.reader.read()`. If its caller aborts while the initial remote check is pending, the core can subsequently start a provider read and obtain provider credentials after that abort (`index.ts:205–218,177`). Issuance can install a grant after cancellation before the host notices. The latest access-client cancellation implementation cannot prevent these operations because it receives only the broker's independent signal. Bytes are withheld by the final host check, but new work still starts beyond the caller's semantic stop boundary.

**Fix**: Add signal-aware online issuance/read entry points, propagate caller cancellation to remote authorization and provider work, and check it before committing issuance or starting provider I/O. Keep the synchronous legacy API unchanged. For shared read flights, cancel an individual waiter's reply without incorrectly cancelling another live waiter; retain resource occupancy until actual settlement and preserve durable evidence for work already started. Do not claim that abort proves physical termination.

## Review: workers/library-broker/src/build-host.ts:99–103

**Severity**: MEDIUM

**Issue**: The host manufactures a revocation receipt for a command it never delivers or journals. After the first revocation of a grant, every subsequent command for that grant reloads and submits the first stored command to the core. The returned receipt then has its `key` and `evidenceId` replaced with those of the new command. Thus command B receives an apparently B-bound receipt derived from A's durable journal entry. Reusing A's key with a different evidence/reason also bypasses the core's exact-command conflict check because only A is passed to it. The grant stays denied, but acknowledgments and crash/audit evidence no longer represent the operation actually recorded.

**Fix**: Keep the durable per-grant deny marker separate from the command journal. Validate and persist each accepted command by key with exact payload binding, pass that command to `broker.admin.revokeGrant`, and return its actual receipt unchanged. Replaying the same key must replay exactly or reject a payload conflict. Preserve the existing safety property that local deny commits before cross-database delivery; bound the extra receipt history independently.

## Review: packages/storage-broker/src/index.ts:205–206

**Severity**: MEDIUM

**Issue**: The online-only recheck changes the legacy observation schedule because `current(grant,principal)` after the semicolon runs even when `remote` is absent. This has a concrete existing regression in the unchanged source test at `packages/storage-broker/src/index.test.ts:86–89`: its authority revokes on observation six and expects the first waiter to succeed and the second to be fenced. Static tracing of the new code gives observations 1/2/3 for the first caller's entry/extra check/reservation, 4/5 for the second caller's entry/extra check, and 6 during sealing. Consequently the shared flight rejects and both waiters reject. In the historical code, sealing was observation 4 and the individual reply fences were 5 and 6. This is a source-derived regression prediction, not a claimed test result. The synchronous issuance signature and legacy persisted binding are otherwise preserved.

**Fix**: Put the additional pre-read check inside the online branch, for example `if (remote) { await online(grant); current(grant,principal); }`. Retain the original shared-flight and per-waiter fences for synchronous mode. Revisit the unchanged regression test only during separately authorized validation; do not silently redefine its expected legacy behavior as part of adding online mode.

## Other scoped conclusions

- The current broker persists `authorizationMode` and `namespaceId` (`index.ts:71`) and compares the exact binding on recovery before initializing an unfamiliar schema. The host also persists its approval/scope binding. No namespace-binding finding remains against these reviewed bytes. Host provisioning still owns the documented requirement to provide distinct durable databases; no filesystem or database runtime checks were performed here.
- Issuance has four bounded admission slots and an explicit deadline. The latest `build-online.ts:29–71` races abort/deadline for the caller while holding its four admission slots through operation cleanup. Earlier concerns about merely signalling abort without racing the pending operation do not apply to this version. The latest host passes reservation receipts explicitly, and the client classifies short remaining runway as uncertainty; the findings above were narrowed to account for those concurrent fixes.
- New reads, cached replay, and individual waiters receive online checks as well as local tombstone checks. The report does not assume that a later revocation can recall previously delivered bytes. The permanent-denial classification issue above is distinct from that distributed linearization boundary.
- The access route echoes the nonce and authority/environment/epoch source after authenticated body processing (`workers/compute/src/authority.ts:129–144`). The client binds that nonce/source and the project/profile/complete compute tuple (`build-online.ts:53–63`). The route delegates to the existing owner-only `observeFence`; its broader preliminary role list does not by itself grant executor access to that observer.
- `gcs-build-host.ts:12–17` checks the logical project and composes the existing pinned reader and create-only writer. Source inspection found no embedded credential, worker-visible provider credential, ambient SDK/cloud identity lookup, or service startup in this composition. Managed credential resolvers remain trusted host ports.
- Revocation denial is durably recorded before broker delivery; grant intent precedes async issuance, and object capacity is charged before provider writes. These are useful evidence boundaries. They do not resolve the receipt or reservation recovery findings, and they do not establish process stop, provider stop, runtime containment, or readiness to activate.

## RTD evidence and limits

Structure, static integration, content, and source-level user-journey traces were reviewed: construction/reopen, reserve/publish/issue, import/read/replay, revocation/reconciliation, cancellation, and accepted-result access. The current tests were read only where needed to identify the legacy regression. **Compilation, runtime execution, tests, typechecks, and deployment validation were deferred and forbidden for this review.** No successful execution or deployment inference is made from source review or the pre-existing static hold.

## Reviewed source identity

The parent is implementing concurrently. Findings and line numbers apply to these inspected SHA-256 identities; subsequent product changes need reconciliation against this report, not an inherited approval.

| Path | SHA-256 |
| --- | --- |
| `packages/storage-broker/src/index.ts` | `fb001245afa68b2a1dd2c92357617ea26bf457039979b97df61abaf4017c71a1` |
| `packages/storage-broker/src/types.ts` | `d11f50d31a71c27babefc3787173ebe2657403a36df4bc4bdfceded81d896aa4` |
| `workers/library-broker/src/build-host.ts` | `d464ca9271b5b558cc482b9df1f18e548d3bbf0c9a25268123a916eb45493276` |
| `workers/library-broker/src/build-online.ts` | `b6d9e3fb09b5592bc32f9fe18bb0ff1469dd687d5b36832dde7fdd298a004d95` |
| `workers/library-broker/src/gcs-build-host.ts` | `e94efdfca28f7873670e1615b6379d89a931afb816d76ee6579df7617c0a804f` |
| `workers/compute/src/authority.ts` | `8b2488828901c47b8e1303d2ea7daf42a9dd3115ed03033f2f88f44b8e4f1836` |
