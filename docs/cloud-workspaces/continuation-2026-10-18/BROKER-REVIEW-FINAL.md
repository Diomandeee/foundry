# Independent broker review — final bounded pass

**Rating: APPROVE — bounded static review only.** The three residual findings from Round 2 are addressed in the current source. No additional actionable broker-boundary finding was identified in the new post-claim input resolver. This is not compilation/runtime validation or permission to activate a service, deploy, or pass the existing static hold.

Repository: `/Users/mohameddiomande/Developer/foundry-integration/source`.

Scope: the optional signal-aware `BrokerHost.read` contract, inactive-namespace history/selection, HTTP refresh cancellation, and `claim-inputs.ts` strictly at its broker authority/credential/namespace boundary. Also confirmed the previously restored combined output/manifest reservation remains present. Input-format and hydration correctness belong to the independent input reviewer and are not approved here.

## Residual finding closure

| Round 2 finding | Current source evidence | Disposition |
| --- | --- | --- |
| Missing `BrokerHost.read` declaration | `workers/library-broker/src/index.ts:7–15` now declares `read?(principal, request, signal): Promise<Uint8Array>`. The handler uses it at line 68, retaining the legacy reader fallback. `build-host.ts:118–120` supplies the typed signal-aware implementation. | Addressed. The previously undeclared member now has a matching source contract. No typecheck was run. |
| An inactive namespace aborts unrelated selection | `build-host.ts:220` reads immutable reservation history without calling `active()`. `build-namespace-set.ts:30–32` searches every approved history before capacity selection, rejects ambiguous receipts, and explicitly rejects a recovered operation bound to an inactive namespace. Fresh selection at line 35 skips inactive candidates before calling approval/admission methods. `isActive()` at `build-host.ts:221` distinguishes disabled/expired policy from exceptions; history, database and clock errors are not swallowed. | Addressed. An unrelated inactive namespace no longer poisons selection, and an operation already debited in its own inactive namespace cannot roll over into a new one. |
| HTTP refresh ignores caller cancellation | `index.ts:57–62` rejects an already-aborted request before incrementing refresh admission, links `request.signal` to the refresh controller, rechecks cancellation before invoking the refresh port, and races the tracked promise against cancellation/deadline. The request listener and timer are cleaned up. The outstanding-refresh decrement remains attached to the underlying refresh promise's settlement. The read receives `request.signal` at line 68; line 69 rejects cancellation before a successful response. | Addressed. Caller cancellation now reaches the preliminary authority operation as well as the online reader; cancellation does not itself release an unsettled refresh slot. |

The nested access client retains its own admission through physical operation cleanup as previously reviewed. Linked cancellation is a request to stop and a guard against late success; it is not proof of remote/provider/process termination.

## Post-claim resolver: broker boundary

`workers/library-broker/src/claim-inputs.ts:28–41` accepts a finite set of explicitly approved slots and namespace templates. Policies are copied and validated, and templates must match the policy environment, authority, server profile and project and must not permit publication. Resolver construction does not create a broker, issue a grant, resolve a managed credential, or contact compute/storage.

On resolution, lines 43–51 require a controller-branded `BuildAttemptContext`, reject cancellation, select exactly one policy for the actual job/input/profile/worker/epoch/generation/incarnation, and verify source authority plus workload/attempt/lease and local recipe bindings. The controller's brand is checked by the private WeakSet at `packages/build-runtime/src/controller.ts:45–48`; the context is created and registered only after claim lineage/fence validation at lines 161–179. It carries a capability digest, not the raw capability.

Only after those checks do resolver lines 52–56 fill the actual compute binding into the supplied templates and construct the namespace set. A bound slot cannot later accept a different compute tuple. Construction initializes only the supplied DB handles; no new DB path, credential, namespace fallback or grant is manufactured. Subsequent issuance continues through the existing explicit reservation and online authorization ports. The resolver returns `{scope,routing}`, rather than raw broker config, provider credentials or owner transport credentials. Storage integration calls it after checking the actual context (`packages/build-runtime/src/storage-integration.ts:45–55`).

**Broker-boundary disposition:** no additional actionable finding in these inspected bytes. This conclusion does not extend to input completeness, source selection, materialization, or overall worker execution readiness.

## Retained capacity correction

`packages/build-storage/src/packaging.ts:65–73` still reserves output chunks plus one manifest slot and bounded manifest bytes before the first provider publication. Lines 127–129 reuse exactly `c.reservation` for the manifest without a second reserve/debit. The combined-admission correction remains intact; the superseded split-manifest finding is not reopened.

## Verification boundary

This was a bounded source pass under the previously read `PROTOCOLS.md` and historical continuation hash baseline. Reviewed structure, static integration/content, and source-level journeys for inactive-history recovery, caller cancellation, post-claim authority binding and receipt reuse. No tests, builds, typechecks, product imports/execution, probes, services, cloud operations, Git operations, subagents or product edits were performed. Only this final report was written; earlier reports remain as historical receipts. Compilation, runtime, end-to-end and deployment checks remain deferred and forbidden for this task.

## Reviewed source identities

The parent is implementing concurrently. This approval applies only to the bounded review scope and inspected SHA-256 identities below; later changes do not inherit it.

| Path | SHA-256 |
| --- | --- |
| `workers/library-broker/src/index.ts` | `7c30efeb647a8052d2c87f5aa6f1802b58742bc3e1f42d2fbf217e2a04203c1e` |
| `workers/library-broker/src/build-namespace-set.ts` | `19f8a82b893f5e4be260c208cff563ae1a045ef13612bfaf6188cc8f5304243f` |
| `workers/library-broker/src/build-host.ts` | `194bb279a70354793a8c8d26a8ae936621c541f8931ff906c6ef6b750937b45e` |
| `workers/library-broker/src/claim-inputs.ts` | `c003927e7978e79dcdf65bdecae431d03f3886072b99e7e84f78242a898fe711` |
| `workers/library-broker/src/gcs-build-host.ts` | `e94efdfca28f7873670e1615b6379d89a931afb816d76ee6579df7617c0a804f` |
| `workers/library-broker/src/build-online.ts` | `37b4f73177c4b3df6512fdf63603b798bf9e7ccccd1a3f8c98439e93db974ee3` |
| `packages/storage-broker/src/index.ts` | `73c224012bcb10d2cfc8f07306e71bdf54b87a09ae2c23aaaa7e384f496a6346` |
| `packages/storage-broker/src/types.ts` | `693c5bb414402e741b7f9c7a280a0228a68b07640a971f7607a9770ef28858af` |
| `packages/build-runtime/src/controller.ts` | `319f430ba8caa2d2e6f35a533587d9b308d783cdd7c7aebb0a08515df786bdbf` |
| `packages/build-runtime/src/storage-integration.ts` | `e50520b09163ef808e264773e88f7c45004aad5e2f5de7fdea192c909f61e6d5` |
| `packages/build-storage/src/packaging.ts` | `4cf09dde219f571cab1f30dbdae962be429295b130819a0c6e88a259b91751b4` |
