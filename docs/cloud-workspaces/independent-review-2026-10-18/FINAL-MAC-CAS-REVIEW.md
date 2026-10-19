**APPROVE — narrow source acceptance** of the final Mac CAS accounting repair against the supplied preimages. No concrete actionable finding survived the bounded round-two challenge.

- **Authentication/freshness:** root-peer authentication, fresh nonce, exact response shape, and startup-captured runtime pins reject mismatched or stale receipts. [mac-cas.py:358](/Users/mohameddiomande/Developer/foundry-integration/source/packages/build-storage/native/mac-cas.py:358), [mac-isolated-store.ts:117](/Users/mohameddiomande/Developer/foundry-integration/source/packages/build-storage/src/mac-isolated-store.ts:117).
- **Accounting:** fresh scans count actual apparent object bytes, including partial creates; entry/time limits and unsafe metadata fail closed. [mac-cas.py:189](/Users/mohameddiomande/Developer/foundry-integration/source/packages/build-storage/native/mac-cas.py:189).
- **Queue/abort:** bounded waiting and shared-store identity preserve client occupancy through pin I/O completion or child closure after cancellation. [mac-isolated-store.ts:60](/Users/mohameddiomande/Developer/foundry-integration/source/packages/build-storage/src/mac-isolated-store.ts:60).
- **Integration:** missing accounting becomes unknown/incomplete; checked addition feeds the merged admission limit; factory wiring supplies identical storage pins. [liveness.ts:105](/Users/mohameddiomande/Developer/foundry-integration/source/packages/build-runtime/src/liveness.ts:105), [mac-vm-worker.ts:22](/Users/mohameddiomande/Developer/foundry-integration/source/packages/build-runtime/src/mac-vm-worker.ts:22).

RTD structure, source integration, content, and journey inspected. **Compilation, operations, and deployment: NOT RUN.** No tests authored or executed; no files changed or subagents spawned. Blocking filesystem I/O remains an availability limitation, not a proven hard-time bound.

This is source approval only, **not a gate verdict**.
