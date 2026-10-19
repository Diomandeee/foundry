# Independent broker review — round 2

**Rating: REQUEST_CHANGES.** Bounded source-only re-review of F1–F5, `build-namespace-set.ts`, storage operation-key interfaces/calls, and the final parent corrections to access-observation maintenance and native eligibility. Three actionable residual/integration issues remain after verifying the parent's restored combined output/manifest admission. This report is separate from `BROKER-INDEPENDENT-REVIEW.md`; the original report was not edited.

Repository: `/Users/mohameddiomande/Developer/foundry-integration/source`.

Read `/Users/mohameddiomande/PROTOCOLS.md` and retained `continuation-2026-10-18/BASELINE.json` as the historical hash baseline (`2026-10-18T07:55:50.880629+00:00`). Reviewed actual current source rather than assuming the described fixes landed. No tests, builds, typechecks, product imports/execution, probes, services, cloud operations, Git operations, or product edits. Only this report was written. Compilation/runtime/deployment remain deferred and forbidden; the static hold is not approval.

## Review: workers/library-broker/src/index.ts:7–14,63–64

**Severity**: HIGH

**Issue**: The new signal-aware HTTP integration uses an undeclared `BrokerHost.read` member. `brokerHandler()` accesses `host.read` twice at line 64, but the complete `BrokerHost` interface at lines 7–14 has no such member or index signature. The explicitly typed host object in `build-host.ts:122–124` also supplies `read`, making this an excess-property mismatch at construction as well as an invalid member access in the handler. This is a direct source-contract inconsistency, not a claimed typecheck result. The intended signal-aware path exists at runtime, but the TypeScript integration is incomplete.

**Fix**: Add the intended optional typed method to `BrokerHost`, for example `read?(principal: string, request: unknown, signal: AbortSignal): Promise<Uint8Array>`. Keep the existing two-argument reader fallback for legacy hosts. Do not silence the discrepancy with `any` or an assertion that hides the missing contract.

## Review: workers/library-broker/src/build-namespace-set.ts:28–35

**Severity**: HIGH

**Issue**: One inactive approved namespace prevents selection from every other valid namespace. Recovery scanning eagerly calls `host.reservation(...)` for all hosts at line 30. That lookup calls `active()` before reading history (`build-host.ts:224`); `active()` throws when that namespace is disabled or its own approval expires (`build-host.ts:84`). Consequently, namespace A's expiration aborts the entire scan even for an exact read approved only by still-valid namespace B, including when B already has the operation's durable receipt. Different expirations and enabled callbacks are allowed by the set constructor. New selection has the same problem through `allowsRef()`/`admission()`, which also throw on inactivity instead of treating an unrelated candidate as ineligible. This is a lifecycle coupling across namespaces, not a request to widen their limits.

**Fix**: Separate immutable reservation-history lookup from permission to perform new work. Search all known operation receipts without requiring each namespace to be active; if the requested operation is bound to an inactive namespace, fail it there without selecting a new namespace. For an operation with no existing receipt, skip explicitly inactive candidates and admit only an active approved candidate. Preserve fail-closed behavior on actual database/history uncertainty; do not catch every lookup error and mistake it for absence.

## Review: workers/library-broker/src/index.ts:56–58

**Severity**: MEDIUM

**Issue**: HTTP cancellation still does not reach the preliminary authority refresh. The new read call correctly forwards `request.signal` at line 64, but `host.refresh()` receives only a separate five-second timer controller. If the request aborts while refresh is pending, the authority request continues holding a refresh slot until it settles or times out. A request already aborted when this block begins can still initiate the authority call and resolve its managed credential. Thus the broker core's new cancellation handling fixes provider/read ownership, but the HTTP journey still starts or continues authority work beyond the known caller stop boundary.

**Fix**: Reject an already-aborted request before dispatching refresh, link `request.signal` to the refresh controller, and race cancellation as well as the deadline. Remove the listener in cleanup. Keep the existing outstanding-refresh accounting tied to underlying settlement so an uncooperative transport cannot regain physical capacity merely because its caller was cancelled. Also check cancellation before constructing a successful response.

## F1–F5 disposition on current source

| Finding | Static disposition | Evidence |
| --- | --- | --- |
| F1: transient denial becomes permanent revocation | Original finding addressed | `build-online.ts:53–63` validates and propagates `permanentlyRevoked`; `build-host.ts:115–117,207–211` denies uncertain reads without tombstoning and records uncertain reconciliation as pending. Authority freshness is excluded from permanent classification at `packages/build-jobs/src/authority.ts:58–59`. |
| F2: lost reservation receipt debits anew | Original replay mechanism addressed; output/manifest follow-up now addressed | `build-host.ts:129–142` persists a unique operation key, replays the exact need/receipt before capacity rejection, and rejects key conflicts. `project-input-io.ts:21–30,65–74` uses the same exported operation key for routing and reservation; `build-namespace-set.ts:30–32` searches existing operations before capacity. Packaging, snapshot package/import, and project-input reserve calls supply stable keys. The restored combined output/manifest admission is verified below; the independent inactive-candidate issue above remains. |
| F3: caller signal stops at broker | Core fix present; HTTP integration incomplete | Online issue/read interfaces require a signal (`storage-broker/src/types.ts:76–80`). Host issuance/direct reads pass it (`build-host.ts:188,229`). Core authorization races cancellation, provider execution has its own linked controller, and online duplicate flights reject busy rather than sharing cancellation ownership (`storage-broker/src/index.ts:53–64,175–207,219–231`). Legacy sharing remains. Missing HTTP host typing and uncancelled preliminary refresh are reported above. |
| F4: substituted revocation receipt | Original finding addressed | `build-host.ts:97–112` separates per-grant `host_denied` from a command-key journal, checks exact command replay, delivers that command, and returns the actual core receipt unchanged. Local deny commits first. Reconciliation retries undelivered commands at lines 201–203. |
| F5: extra legacy observation | Original finding addressed | The additional entry observation is inside `if(remote)` at `storage-broker/src/index.ts:216`. The synchronous entry/reservation/sealing/per-waiter observation schedule no longer includes round 1's extra check. No tests were executed to claim broader compatibility. |

## Final parent corrections: narrow static assessment

**Output/manifest capacity follow-up: addressed in source.** `packages/build-storage/src/packaging.ts:65–73` again admits `count+1` artifacts and `total+CHUNK_BYTES` bytes in one stable-key reservation before any output provider write, including when outputs are all empty. `writeResultManifest()` at lines 127–129 uses exactly `c.reservation` for the manifest's publication; it performs no second reserve. `publication.ts:27–30` still forwards that exact receipt through both writer and issuer. The concrete host enforces the aggregate reservation totals at `build-host.ts:135–141` and charges object count/bytes against the same receipt at lines 147–155. At the pilot maxima, at most 31 output/log chunks plus one manifest consume at most 32 grants, while at most 7 MiB of output/log bytes plus the manifest's 1 MiB upper bound fit the fresh 8 MiB namespace (`checks.ts:5,8–9,42`). Existing occupancy is rejected by combined admission before publication. The earlier separate manifest reservation was superseded; the report no longer carries that capacity finding. This is a static capacity trace, not an executed end-to-end result.

`workers/compute/src/authority.ts:144` now calls `observeFence(context, attemptId, true)` only for `/builds/access`. The observer (`packages/build-jobs/src/authority.ts:52–59`) transactionally commits the clock high-water mark and expiry sweep before loading the attempt and classifying permanent revocation. `clock()` at line 20 uses the persisted maximum; `sweep()` at lines 23–25 makes expiry terminal and retains stop uncertainty. A forward wall-clock observation used to revoke cannot subsequently disappear on a backward clock reading and permit renewal of that same attempt. This addresses the specific ephemeral-observation concern. Legacy `/builds/fence` at compute line 141 still omits the flag, preserving the non-maintaining default. Access observations now deliberately perform maintenance; this report does not describe them as storage-read-only operations.

`packages/build-jobs/src/authority.ts:42–43` adds `native-termination-attestation-not-supported` for **every** `xcode-build-v1` profile, independently of census/toolchain eligibility. The reason makes `match()` ineligible; the shared selection/claim checks use that match result. This is consistent with the current native adapter's unknown stop proof (`packages/build-runtime/src/adapters.ts:46–49`) and the concrete attestor's explicit process-lineage-only/no-`stopped:true` boundary (`mac-attestation.ts:96–97,233–235`). No native containment, XPC/service quiescence, or physical stop confirmation is inferred. This assessment is limited to the newly stated admission boundary, not a runtime audit.

No new nonce/source-binding or credential-containment finding arose in the bounded changed paths. The client retains nonce, source environment/authority/epoch, project/profile/compute bindings and private credential resolution; timeout admission stays held through its tracked cleanup. This is static evidence only, not a service/security certification.

## RTD scope and source identities

Reviewed structure, static integration/content, and source-level user journeys: transient denial/recovery, lost reservation reply/replay, namespace recovery selection, output/manifest reservation calls, cancellation, journal delivery/replay, and legacy branch separation. Compilation, tests, typechecks, runtime, and deployment were not performed. The undeclared interface issue is established directly from source declarations.

The parent is implementing concurrently. These SHA-256 identities identify the reviewed product snapshot, including the final access-maintenance/native-eligibility correction and the subsequent combined output/manifest admission restoration; later edits require reconciliation with these findings. The three remaining findings' source hashes were unchanged during this capacity-only follow-up.

| Path | SHA-256 |
| --- | --- |
| `packages/storage-broker/src/index.ts` | `73c224012bcb10d2cfc8f07306e71bdf54b87a09ae2c23aaaa7e384f496a6346` |
| `packages/storage-broker/src/types.ts` | `693c5bb414402e741b7f9c7a280a0228a68b07640a971f7607a9770ef28858af` |
| `workers/library-broker/src/build-host.ts` | `349c96adb444e23ddce65cbbeb70ea0f385ebf5e2f1d0ef9724e8147388ddd04` |
| `workers/library-broker/src/build-online.ts` | `37b4f73177c4b3df6512fdf63603b798bf9e7ccccd1a3f8c98439e93db974ee3` |
| `workers/library-broker/src/build-namespace-set.ts` | `b1313961acad4c13f8579c36b6f79a51d282b238c13cf2d49546f81a3782a7c8` |
| `workers/library-broker/src/index.ts` | `8722812d3e68cca7455ef86bdb4b4811f78299df7ab45b94f03782a5652f9ddb` |
| `workers/library-broker/src/gcs-build-host.ts` | `e94efdfca28f7873670e1615b6379d89a931afb816d76ee6579df7617c0a804f` |
| `packages/build-jobs/src/authority.ts` | `88db40abbd5e9c11a2a00433d7863426d38a1712421da20039018a56ce624242` |
| `workers/compute/src/authority.ts` | `368f7f1c536bab163bdccaea7304b462b4ddaf5bbf40f6c525f0b4b6cfd11544` |
| `packages/build-storage/src/types.ts` | `5d3c5fe821b8a211e97a2f7ed4475fb2728ff5ba55af23430f1c43ee7a673b7b` |
| `packages/build-storage/src/publication.ts` | `3a2718eb6354806f381c71f282c7105693f031d54d3e87954ae7e88ec6a9a7e3` |
| `packages/build-storage/src/packaging.ts` | `4cf09dde219f571cab1f30dbdae962be429295b130819a0c6e88a259b91751b4` |
| `packages/build-storage/src/snapshots.ts` | `871a85b5ee8f239b25c65fbc44e4df7c68d7d5c688c301c7817ccf45da5b10be` |
| `packages/build-storage/src/project-input-io.ts` | `f9293e88a0d0d19f0199261540a807e41d59557127bc6b5068ddb9df7e491b86` |
| `packages/build-storage/src/index.ts` | `79874d325b70eec88d5f77cbe4a3f23be7a2fcfbcd1ddc5cb6e019abd1b7ed78` |
