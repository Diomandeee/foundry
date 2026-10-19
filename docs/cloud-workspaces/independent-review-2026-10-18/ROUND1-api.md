# Independent api review

**Rating: REQUEST_CHANGES — source-review advisory only, not a merge or activation verdict.**

## Review: /Users/mohameddiomande/Developer/foundry-integration/source/packages/build-storage/src/project-input-io.ts:86

**Severity**: HIGH  
**Issue**: `projectPublisher.write()` passes `{...route, local, seal}` to `publish()`, whose parameter now accepts only `Pick<PackagingPorts,'writer'|'issuer'|'capacity'>`. The explicitly supplied `local` property fails TypeScript’s excess-property check. This blocks typechecking the shared storage package and its dependent worker path.  
**Fix**: Pass `route` directly; it already supplies the required ports.  
**Evidence/uncertainty**: The call at [project-input-io.ts:86](/Users/mohameddiomande/Developer/foundry-integration/source/packages/build-storage/src/project-input-io.ts:86) conflicts with [publication.ts:23](/Users/mohameddiomande/Developer/foundry-integration/source/packages/build-storage/src/publication.ts:23). Source-level conclusion; no compiler was run.

## Review: /Users/mohameddiomande/Developer/foundry-integration/source/packages/build-runtime/src/linux-isolated-adapter.ts:65–66

**Severity**: MEDIUM  
**Issue**: Caching only the last object repeatedly evicts a segment’s packed small-file blob when small and large files alternate. Each reread increments the router’s admission counter, eventually rejecting valid snapshots with `input-io-object-budget`.

A concrete source counterexample is 8,192 alternating small/large files across 256 segments: 4,096 one-byte files, 512 large files of 1 MiB + 1 byte, and 3,584 of 33 KiB. This stays below 2 GiB but requires **8,961 reader calls**, exceeding the **8,705-call limit**. Staging fails after the durable attempt has been reserved.

**Fix**: Retain the current segment’s packed blob while streaming other objects, following the existing `segmentLocal` approach. Preserve bounded memory and authorization checks.  
**Evidence/uncertainty**: [Producer ordering](/Users/mohameddiomande/Developer/foundry-integration/source/packages/build-storage/src/project-inputs.ts:74), [cache replacement](/Users/mohameddiomande/Developer/foundry-integration/source/packages/build-runtime/src/linux-isolated-adapter.ts:65), and [admission counting](/Users/mohameddiomande/Developer/foundry-integration/source/packages/build-storage/src/project-input-io.ts:64) establish this path. Counterexample was not executed.

**Accepted operational gates:** Owner provisioning, installed pins, one-attempt reconciliation, independent verification, and activation remain prerequisites—not findings.

**RTD:** Structure, source integration, content, and user journey inspected. Compilation/tests and deployment were gated and not run. No files changed; no installed/runtime claims.

