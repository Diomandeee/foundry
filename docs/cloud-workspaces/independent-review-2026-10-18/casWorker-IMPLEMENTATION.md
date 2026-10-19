Edited only these five assigned files:

- [mac-cas.py](/Users/mohameddiomande/Developer/foundry-integration/source/packages/build-storage/native/mac-cas.py): fresh, bounded accounting of actual root-private objects; authenticated peer, nonce, and installed-runtime identity.
- [mac-isolated-store.ts](/Users/mohameddiomande/Developer/foundry-integration/source/packages/build-storage/src/mac-isolated-store.ts): shared pinned store, validated census responses, bounded serialization through actual client closure.
- [index.ts](/Users/mohameddiomande/Developer/foundry-integration/source/packages/build-storage/src/index.ts): census/store type exports.
- [mac-vm-worker.ts](/Users/mohameddiomande/Developer/foundry-integration/source/packages/build-runtime/src/mac-vm-worker.ts): same storage pins resolve the adapter and liveness store.
- [liveness.ts](/Users/mohameddiomande/Developer/foundry-integration/source/packages/build-runtime/src/liveness.ts): safely merges cache bytes, rejects overlapping roots, checks the merged admission total, and reports missing accounting as unknown/incomplete.

Source reasoning covers renewal/publication concurrency, aborts, stale pins, overflow, and scan failure. Accounting measures apparent object bytes, including partial creates—not reclaimable space. Scan limits or stalled I/O can prevent admission.

Structure, source integration, content, and journey reviewed inline. **Compilation, execution, and deployment remain pending.** No tests authored/run or helpers/services invoked; no runtime-success claim.
