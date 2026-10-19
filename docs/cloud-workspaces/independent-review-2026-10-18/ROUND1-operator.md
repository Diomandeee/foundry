# Independent operator review

**REQUEST_CHANGES — source findings only; no merge or activation verdict.**

## Review: /Users/mohameddiomande/Developer/foundry-integration/source/packages/build-runtime/src/liveness.ts:65–68

**Severity**: MEDIUM  
**Issue**: Mac census does not account for the concrete privileged CAS.

**Failing path / impact**: `createMacVmBuildWorkerController` constructs an adapter that stores objects under `/Library/Foundry/CAS/objects`, while liveness measures only the separately configured, controller-owned `cacheRoot`. An empty auxiliary directory can therefore produce `cacheBytes: 0` and `complete: true` despite retained CAS objects. Pointing `cacheRoot` at the actual CAS instead fails the scanner’s ownership/access requirements: that namespace is root-owned and private. Operators cannot configure an accurate CAS census through this factory.

**Fix**: Supply bounded, fresh, root-authenticated CAS accounting and combine it with other managed storage before publishing census. Missing accounting must produce unknown/incomplete status.

**Evidence / uncertainty**: [Factory wiring](/Users/mohameddiomande/Developer/foundry-integration/source/packages/build-runtime/src/mac-vm-worker.ts:21), [CAS ownership](/Users/mohameddiomande/Developer/foundry-integration/source/packages/build-storage/native/mac-cas.py:153), and [scanner ownership checks](/Users/mohameddiomande/Developer/foundry-integration/source/packages/build-runtime/src/storage-inventory.ts:48). The CAS independently enforces its own quota; this finding concerns incomplete admission accounting and misleading operator telemetry. Source-derived; not exercised.

## Review: /Users/mohameddiomande/Developer/foundry-integration/source/tools/foundry-pilot/operator/builds.js:18–19

**Severity**: MEDIUM  
**Issue**: Recovering an existing submission incorrectly requires eligibility for a new build.

**Failing path / impact**: A submission reaches authority, its response is lost, and the worker claims the job. After page reload—or the periodic refresh clearing `preview`—the operator must preview placement again. Line 18 disables submission unless a worker is eligible, but the existing job now makes that worker busy. Consequently, the UI cannot reach the server’s durable same-selection recovery path. For the supported single-attempt Linux pilot, eligibility need not return after completion because the root slot remains retained.

**Fix**: Expose an authenticated recovery/acknowledgment action for existing durable intents, independent of new-job placement eligibility. Preserve the original job/request identity and prohibit that recovery action from creating another attempt.

**Evidence / uncertainty**: [Refresh resets preview](/Users/mohameddiomande/Developer/foundry-integration/source/tools/foundry-pilot/operator/builds.js:8); [server recovery already exists](/Users/mohameddiomande/Developer/foundry-integration/source/tools/foundry-pilot/build-submission.ts:20); [placement rejects occupied workers](/Users/mohameddiomande/Developer/foundry-integration/source/packages/build-jobs/src/authority.ts:60). This blocks UI recovery, not the underlying server deduplication. Source-derived; not exercised.

**Accepted operational gates:** Owner installation/configuration, actual pins and resources, Mac stage/intake, Linux retained-resource reconciliation, G3 policy selection, schema migration, validation, and activation remain explicitly gated. Lack of automatic Linux reuse is an accepted limitation. K11 claims remain carried external evidence; no enrollment or runtime acceptance is inferred.

**RTD:** Structure, source integration, content, and operator journeys inspected only. Compilation, tests, lint, builds, runtime probes, and deployment were not run. No files were written and no subagents were used.

