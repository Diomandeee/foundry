# Independent inputs review — round 2

**Rating: APPROVE for the bounded static fix review. No new actionable concrete bugs found.**

Reviewed on 2026-10-18 against the actual on-disk source identified below. Scope is limited to the four round-1 fixes and the new `workers/library-broker/src/claim-inputs.ts` resolver. Adjacent namespace constructors, durable binding and existing input helpers were read only to trace those fixes. This does not certify broker grant authority or other parent changes. No Git command was used; no commit/diff identity is asserted.

## Disposition of the four findings

| Round-1 finding | Source disposition |
| --- | --- |
| Input ports needed an unknown pre-claim fence | Addressed. `StorageWorkerConfig.projectInputs.resolve` receives the branded context after claim (`storage-integration.ts:25–26,45–55`). Exact project/compute binding precedes destination creation. The concrete resolver validates the finite owner policy before constructing the selected namespace hosts (`claim-inputs.ts:43–56`). |
| Independent verifier missed npm/cargo working source | Addressed. `verifyAt` performs the same actual-byte and lineage verification for `/input` and, when required by `approvalFor(plan).recipe`, `workRoot/source` (`receipts.ts:41–48`). The recipe decision comes from the approved plan rather than a receipt declaration. |
| Controller byte cap arrived after hydration | Addressed. Controller supplies its cap as the fifth restoration argument (`controller.ts:21,198`). The composition validates both caps, computes their minimum, and supplies it to population and materialization (`storage-integration.ts:49–51,65–71`). Population checks root totals before fetching source objects (`project-inputs.ts:108–120`); destination creation now follows population. |
| V2 receipt allowed split manifest/local-root hashes | Addressed. Before version dispatch, verification requires both the approved manifest SHA and the authenticated manifest-byte digest to equal `snapshotHash` (`receipts.ts:33–37`). The local-root binding and actual tree checks remain (`39–48`). The equal-length A/B counterexample no longer passes. |

## New resolver: bounded integration review

`claim-inputs.ts:28–42` limits slots to 1–3 and namespaces per slot to 1–512, copies each exact policy and namespace approval, validates the fixed identifiers/hashes/fence values, and rejects publication templates and mismatched environment/authority/profile/project bindings. Provider functions and already supplied DB handles remain host ports.

At resolution, the WeakSet context check and cancellation check precede policy matching. Matching includes the supplied input's canonical hash, exact job/project, server/local profile hashes, worker, epoch, generation and incarnation; zero or multiple matching slots fail. Source environment/authority, compute authority/workload, plan attempt/lease and local recipe hash are checked before namespace construction (`43–51`). Config assembly fills compute from the validated actual context (`52–55`), rather than manufacturing a pre-claim fence.

The bound-slot cache only returns for identical canonical compute; another compute fails (`53`). This check and assignment have no intervening `await`. For restart handling, the constructed host's persisted binding includes the complete approval and compute, and an existing DB requires exact equality (`build-host.ts:70–78`). This supports the stated refusal to rebind a durable namespace to a different attempt after resolver reconstruction; no database or restart behavior was executed during this review.

No additional finding is raised against these changes. This disposition closes the four cited source defects, not broader runtime or deployment readiness.

## Verification boundary

Applicable instructions and `/Users/mohameddiomande/PROTOCOLS.md` were already read in this review session; applicable instructions under the newly inspected worker paths were checked. Work stayed inline. Only this requested round-2 report was written.

RTD completed only as source inspection: structure, static integration, content and source-traced journey. Runtime, compilation and deployment remain **DEFERRED / FORBIDDEN**. No tests, test authoring, builds, typechecks, product imports/execution, probes, services, cloud access, spend, credential inspection, Git, deletion or product edits were performed. **All limits remain operationally unvalidated.**

The parent's combined output-admission correction remains outside this round's fix scope; no superseded split-admission claim is revived.

## Source hashes (SHA-256)

Paths are relative to `/Users/mohameddiomande/Developer/foundry-integration/source`. These identify reviewed file contents, not an atomic repository snapshot.

```text
c003927e7978e79dcdf65bdecae431d03f3886072b99e7e84f78242a898fe711  workers/library-broker/src/claim-inputs.ts
e50520b09163ef808e264773e88f7c45004aad5e2f5de7fdea192c909f61e6d5  packages/build-runtime/src/storage-integration.ts
b1105f8e8852404f7ddd7638a92010ea5ca2498195e28845ef3d56a0a66886d3  packages/build-runtime/src/receipts.ts
319f430ba8caa2d2e6f35a533587d9b308d783cdd7c7aebb0a08515df786bdbf  packages/build-runtime/src/controller.ts
19f8a82b893f5e4be260c208cff563ae1a045ef13612bfaf6188cc8f5304243f  workers/library-broker/src/build-namespace-set.ts
e94efdfca28f7873670e1615b6379d89a931afb816d76ee6579df7617c0a804f  workers/library-broker/src/gcs-build-host.ts
194bb279a70354793a8c8d26a8ae936621c541f8931ff906c6ef6b750937b45e  workers/library-broker/src/build-host.ts
5e4b16cf33eb94f0461b6b0e167374a951da96afe4a78c53ddd0dae9cfaa6372  packages/build-storage/src/project-inputs.ts
0e60572734cd16b0c6e6944ed727854d54fc50531d4942c10a991b19cd8fc283  packages/build-runtime/src/plans.ts
```

## Final scope extension: post-claim result-storage integration

**Rating remains APPROVE for this bounded static review. No new actionable concrete integration bugs found.** This section adds the requested result-storage type/call-shape check and supersedes the earlier identities/line references for `storage-integration.ts` and `claim-inputs.ts`; the earlier hash block records the initial round-2 pass.

- `StorageWorkerConfig.packaging` now requires only `local` and `seal`; its publication members are optional (`storage-integration.ts:18–31`). The new resolver's declared return is `{scope, ports: Pick<PackagingPorts, 'writer' | 'issuer' | 'capacity'>}`. The object returned by `createClaimResultResolver` has that structural shape (`claim-inputs.ts:69–75`). No pre-claim publication scope or dummy ports are needed by this configuration path. This is a source-level type/call-shape assessment, not a typecheck.
- Controller publication passes the original frozen, branded attempt context after confirmed completion/stop (`controller.ts:169–179,202–210`). The storage composition checks the context, source, profile hashes, authority/worker and workload/lease/attempt binding before invoking `resolveResultStorage(job, plan, context, signal)` (`storage-integration.ts:109–117`). Returned scope must match the job project and actual compute, and actual publication ports are required before output collection (`118–122`).
- The factored binder retains finite exact policy matching and the compute-keyed cache (`claim-inputs.ts:28–55`). The read wrapper selects `publication=false`; the result wrapper selects `publication=true`, requires exactly one namespace per slot, validates the job and its plan/profile binding, and resolves using the job's exact input hash/project plus the actual context (`59–75`). It supplies the actual compute only after those checks. Namespace construction remains behind resolution.
- Legacy `resultScope` plus full packaging still follows the existing callback shape: with no result-storage resolver, scope comes from `resultScope` and publication ports from the configured packaging object. Missing scope/ports fail the explicit checks. A thrown post-claim resolver error is not silently retried through the legacy path (`storage-integration.ts:117–120`).
- One concrete `PackagingPorts` object combines the selected publication ports with the configured seal/local receipt wrapper. That same object is passed to both `collectOutputs` and `writeResultManifest` (`122–125,140–141`), preserving their collection/manifest call pairing. Packaging limits, reservation sizing, provider behavior and grant authority were not broadened into this pass.

The input fixes remain present in this revision: fifth-argument controller cap, minimum cap before hydration, post-claim input binding before destination creation, pre-dispatch manifest digest binding, and approved-recipe verification of the working-source copy. Refactoring the resolver did not remove these checks.

**Native remains BLOCKED.** No tests, typechecks, builds, imports/execution, runtime probes, services, cloud operations or product edits were performed. Compilation/runtime/deployment remain deferred and forbidden here; all limits remain operationally unvalidated. Only the requested review report was updated. The changed broker-host hash below is context identity, not an extension into the parent's grant-authority review.

Final inspected SHA-256 identities for this extension:

```text
d306426adce08be6e013920ea58741c6b48c969fe0c7243fd08482d61f942d1b  workers/library-broker/src/claim-inputs.ts
24a3acf8cacfa1d2f569232db4f0249dd0f7e5c8893dc949215d4b885030fc14  packages/build-runtime/src/storage-integration.ts
319f430ba8caa2d2e6f35a533587d9b308d783cdd7c7aebb0a08515df786bdbf  packages/build-runtime/src/controller.ts
b1105f8e8852404f7ddd7638a92010ea5ca2498195e28845ef3d56a0a66886d3  packages/build-runtime/src/receipts.ts
17674f3e33ee1ef64e2b31f1ae93b10f91b327d2c033ad30f3ceb3d9b1fd0008  packages/build-runtime/src/index.ts
5d3c5fe821b8a211e97a2f7ed4475fb2728ff5ba55af23430f1c43ee7a673b7b  packages/build-storage/src/types.ts
19f8a82b893f5e4be260c208cff563ae1a045ef13612bfaf6188cc8f5304243f  workers/library-broker/src/build-namespace-set.ts
07688f36ea9721b5634659b0ca5d2adc5bb45925f56c798ce2eca5946391610c  workers/library-broker/src/build-host.ts
```
