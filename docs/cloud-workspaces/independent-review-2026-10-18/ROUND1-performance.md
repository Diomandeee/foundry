# Independent performance review

**REQUEST_CHANGES — source findings only; not a merge or activation verdict.**

## Review: /Users/mohameddiomande/Developer/foundry-integration/source/packages/build-runtime/src/linux-isolated-adapter.ts:62–66

**Severity**: MEDIUM  
**Issue**: The last-object cache evicts a segment’s packed small-file blob whenever a larger file intervenes. Subsequent small files refetch that blob through `projectObjectReader`, incrementing its operation counter again.

**Failing path / impact**: A valid 256-segment input can contain 32 files per segment: alternate 16 tiny files with 16 larger files, comprising fourteen 64 KiB files and two files of 1 MiB + 1 byte. This is 8,192 files, approximately 736 MiB, and 4,864 data-object entries. Streaming requires 8,704 data reads plus 257 metadata reads—8,961 operations—exceeding the reader’s 8,705-operation ceiling. Preparation fails after private staging and slot reservation despite satisfying the documented input limits.

**Fix**: Retain the segment’s packed blob while streaming intervening large objects, as the existing `segmentLocal` implementation does. Preserve bounded memory and final authority checks.

**Evidence / uncertainty**: Source-derived counterexample; see [cache replacement](/Users/mohameddiomande/Developer/foundry-integration/source/packages/build-runtime/src/linux-isolated-adapter.ts:62), [per-range reads](/Users/mohameddiomande/Developer/foundry-integration/source/packages/build-runtime/src/linux-isolated-input.ts:58), and [operation accounting](/Users/mohameddiomande/Developer/foundry-integration/source/packages/build-storage/src/project-input-io.ts:64). Assumes sufficient approved provider capacity; not executed.

## Review: /Users/mohameddiomande/Developer/foundry-integration/source/packages/build-runtime/native/linux-isolation.py:216–218

**Severity**: MEDIUM  
**Issue**: Admission checks host free space but never checks whether the required working source copy fits inside `maxWorkBytes`.

**Failing path / impact**: An allowed npm/cargo profile with a 256 MiB work image and input above 256 MiB passes this check when host space is sufficient. `end_file()` then copies the input into that image and inevitably encounters ENOSPC. The sole pilot attempt has already reserved its durable slot and created retained resources.

**Fix**: Reject impossible source-copy sizes before reserving the slot. Account for rounded file allocation, directories and inode requirements, and validate usable filesystem capacity before streaming.

**Evidence / uncertainty**: [Allowed image size](/Users/mohameddiomande/Developer/foundry-integration/source/packages/build-runtime/native/linux-isolation.py:117), [input limit](/Users/mohameddiomande/Developer/foundry-integration/source/packages/build-runtime/native/linux-isolation.py:188), and [working-copy writes](/Users/mohameddiomande/Developer/foundry-integration/source/packages/build-runtime/native/linux-isolation.py:358). The byte-capacity contradiction is deterministic; exact metadata overhead remains unmeasured.

## Review: /Users/mohameddiomande/Developer/foundry-integration/source/packages/build-runtime/native/linux-isolation.py:329–332

**Severity**: MEDIUM  
**Issue**: Every incoming file scans and case-folds every previously accepted path.

**Failing path / impact**: The supported 8,192-file input performs 33,550,336 prior-path comparisons, including repeated string allocations, in the serialized privileged broker. This quadratic cost applies even to empty files, so the byte limit does not constrain it.

**Fix**: Maintain bounded case-folded file and directory-prefix indexes, following `ProjectInputPaths`, to detect collisions in work proportional to path depth.

**Evidence / uncertainty**: The comparison count follows directly from the loop. Runtime latency and timeout incidence were not measured.

Accepted operational gates remain separate: owner provisioning, installed-resource validation, one-attempt retention and no automatic reuse are intentional constraints.

RTD: structure, source integration, content and user journey inspected only. Compilation, tests, lint, benchmarks and deployment were **not run**. No files changed; no installed/runtime claims.

