# Mac CAS and liveness local regression validation — 2026-10-18

Result: **46 tests passed in 2 files; scoped TypeScript compilation passed.** No production fix is requested by this slice. No tests are skipped or marked expected-failure.

Repository: `/Users/mohameddiomande/Developer/foundry-integration/source`
Branch: `codex/foundry-integration-20261016`
HEAD: `cf27ac662730bb98a509af8d1d1ebea4342eef7a`

This is a shared dirty checkout. HEAD identifies the base, not all tested bytes. Existing changes were preserved. The parent's nonce Buffer conversion and liveness dependency compiler repairs were already present for the successful run. This worker authored only:

- `packages/build-storage/src/mac-isolated-store.test.ts`
- `packages/build-runtime/src/liveness.test.ts`
- This report, `docs/cloud-workspaces/validation-2026-10-18/MAC-TESTS.md`

Read before work: `~/AGENTS.md`, `~/SOUL.md`, `~/PROTOCOLS.md`, the independent-review README, and the relevant CAS, liveness, controller, storage-inventory, discovery, host, capability, transport and contract interfaces. No deployment skill was used. Task-specific restrictions override standing cron/background/commit instructions.

## Scope and assertions

### Mac CAS — 24 tests

The real `createMacIsolatedContentStore` implementation and local validation/hash/ref modules run against mocked child-process and filesystem imports. File contents are synthetic in-memory bytes. macOS/nonroot identity is simulated; neither installed pin files nor root-private storage is read. Fake child streams implement the client protocol; no subprocess is created by the product code.

Assertions cover:

- Fresh 32-hex-character nonce per census; exact fixed helper argv/environment; actual hashing of synthetic pinned bytes; closure of pin file handles.
- Preserving nonzero retained-byte and object-count observations rather than replacing them with zero.
- Rejecting nonce mismatch, wrong namespace, incomplete scan, wrong Python/helper receipt pins, and extra receipt fields.
- Rejecting negative/fractional/over-budget byte counts, object-count overflow, unsafe/unknown free bytes, and bytes greater than declared object capacity.
- Rejecting changed pin bytes, writable paths, symlink paths and unknown access errors before any fake helper spawn.
- Reusing the installed singleton and rejecting changed configuration pins.
- Removing an aborted queued caller; enforcing four waiting slots; admitting a later caller after cancelled waiters leave.
- A 20-second logical deadline kills the fake child but retains occupancy until its actual `close` event, including factory reconstruction.
- A caller abort during unresolved pin I/O retains occupancy until that physical read settles and its fd closes.
- An oversized response kills the fake child but cannot release the lane before `close`.

Pending child/I/O cases are explicitly settled. Fake timers avoid elapsed waits. Promise-job draining is bounded and assertions establish that the intended physical operation actually started before cancellation.

### Liveness — 22 tests

The real `NodeWorkerLiveness`, canonical config serialization, hash logic and authority-source validation run locally. Storage census/inventory/discovery, durable sequence reservation/commit, VM capability observation, filesystem statfs, CPU/RAM observation, clock/wait, and transport are fakes. The transport captures outgoing census bodies for assertions and returns a matching synthetic authority receipt; it does not contact an authority or prove server acceptance.

Assertions cover:

- Adding controller and private CAS retained bytes exactly once, preserving workspace bytes and returning the bound authority receipt.
- Rejecting idle admission for unavailable CAS, incomplete/unknown controller cache, negative cache values and unsafe combined sums. Unknown accounting is reported as `null`/incomplete; absent CAS headroom is conservatively zero.
- A VM with omitted installed CAS pins remains unknown, rather than appearing to have an empty cache.
- A failed second observation does not reuse the first successful census; census sequence advances.
- Active-job telemetry may report unknown storage honestly, without claiming idle admission readiness.
- The combined 20-GiB cache admission boundary accepts exactly the limit and rejects one byte above it.
- Headroom is `min(controller, VM attempts, CAS)`, including equal observations representing one shared volume and each independently limiting volume. Equal observations are never added together. This does not detect physical volume identity or prove downstream job headroom eligibility.
- Controller roots overlapping the private CAS namespace fail before store construction.
- A wrong authority epoch cannot commit the census sequence.
- Cancellation during private storage observation prevents census publication.
- Concurrent refresh is rejected while the first observation is physically pending; refresh recovers after settlement.

## Commands and results

All commands below ran from the repository root using the existing `node_modules`. No package installation was performed.

Report directory:

```sh
mkdir -p /Users/mohameddiomande/Developer/foundry-integration/source/docs/cloud-workspaces/validation-2026-10-18
```

Owned tests only:

```sh
node_modules/.bin/vitest run packages/build-storage/src/mac-isolated-store.test.ts packages/build-runtime/src/liveness.test.ts --exclude 'docs/**' --no-cache --configLoader runner
```

- First invocation: exit 1; 45 passed, 1 failed, 479 ms. The missing-pin test incorrectly supplied an explicit `undefined` property, which real canonical config validation correctly rejected with `non-inert-data`. The fixture was repaired to omit the optional property; no production change was made.
- Final invocation: exit 0; **2 files passed, 46 tests passed**, 400 ms, Vitest 5.0.3, start 13:23:57 local. No unhandled errors were reported. `--no-cache` and the runner config loader avoid result-cache writes and bundled config emission. Only the two named test suites ran.

Scoped compiler command, with two explicit test roots and their imported dependencies; no output emission:

```sh
node_modules/.bin/tsc --ignoreConfig --noEmit --target ESNext --module ESNext --moduleResolution Bundler --lib ESNext --types node,@cloudflare/workers-types --strict --skipLibCheck packages/build-storage/src/mac-isolated-store.test.ts packages/build-runtime/src/liveness.test.ts
```

Result: **exit 0, no diagnostics**, TypeScript 7.0.2. This intentionally scopes compilation to the owned test roots; it does not replace the parent's root-config/alias or overall-suite checks. Dependency declaration checking is skipped, as in the root configuration.

An earlier attempt to use the old TypeScript JavaScript compiler API failed before compilation. The installed TypeScript 7 package root exposes version information rather than `ts.sys`; no files were emitted. Exact attempted command:

```sh
node --input-type=module <<'JS'
import ts from 'typescript';
const configPath=ts.findConfigFile(process.cwd(),ts.sys.fileExists,'tsconfig.json');
const read=ts.readConfigFile(configPath,ts.sys.readFile);
const parsed=ts.parseJsonConfigFileContent(read.config,ts.sys,process.cwd());
const rootNames=['packages/build-storage/src/mac-isolated-store.test.ts','packages/build-runtime/src/liveness.test.ts'];
const program=ts.createProgram({rootNames,options:{...parsed.options,noEmit:true,incremental:false}});
const diagnostics=[...(read.error?[read.error]:[]),...parsed.errors,...ts.getPreEmitDiagnostics(program)];
if(diagnostics.length) console.log(ts.formatDiagnosticsWithColorAndContext(diagnostics,{getCurrentDirectory:()=>process.cwd(),getCanonicalFileName:p=>p,getNewLine:()=> '\n'}));
console.log(`Scoped test-root compilation: ${diagnostics.length} diagnostics`);
process.exitCode=diagnostics.length?1:0;
JS
```

Result: exit 1, `TypeError: Cannot read properties of undefined (reading 'fileExists')`. Recovered using the successful installed compiler CLI above.

Structure/content checks:

```sh
git diff --check -- packages/build-storage/src/mac-isolated-store.test.ts packages/build-runtime/src/liveness.test.ts
rg -n '^(<<<<<<<|=======|>>>>>>>)|it\.(skip|todo)|describe\.(skip|todo)' packages/build-storage/src/mac-isolated-store.test.ts packages/build-runtime/src/liveness.test.ts
```

The diff check exited 0, but the new files are untracked, so it is not sufficient on its own. The search returned no matches (exit 1, expected). The following direct file check passed for both new files:

```sh
python3 - <<'PY'
from pathlib import Path
paths=[Path('packages/build-storage/src/mac-isolated-store.test.ts'),Path('packages/build-runtime/src/liveness.test.ts')]
for path in paths:
    text=path.read_text()
    assert text.endswith('\n'),path
    assert all(line==line.rstrip() for line in text.splitlines()),path
    assert not any(line.startswith(('<<<<<<<','=======','>>>>>>>')) for line in text.splitlines()),path
    print(f'{path}: structure/whitespace/conflict-marker checks passed')
PY
```

Final path verification:

```sh
ls -la /Users/mohameddiomande/Developer/foundry-integration/source/packages/build-storage/src/mac-isolated-store.test.ts /Users/mohameddiomande/Developer/foundry-integration/source/packages/build-runtime/src/liveness.test.ts /Users/mohameddiomande/Developer/foundry-integration/source/docs/cloud-workspaces/validation-2026-10-18/MAC-TESTS.md
```

## Captured source/test fingerprints

Computed with `shasum -a 256` after the successful run:

| File | SHA-256 |
|---|---|
| `packages/build-storage/src/mac-isolated-store.ts` | `d857712e30981fe40ffdc45a70462bab237e0a86c77818693fb9451d0de2080c` |
| `packages/build-runtime/src/liveness.ts` | `433aa73342f7ee03e3641671f2c899af998656a8be5868c0ce3016bf9bfd5dba` |
| `packages/build-storage/src/mac-isolated-store.test.ts` | `02551a8e149164be0c89e37679c0a58f59dcc2d779662fe7035139a7ed062515` |
| `packages/build-runtime/src/liveness.test.ts` | `104c5996e5d547db018534ab5382b6420619fc1fb98f1654ae9ae43caa3dad9c` |

These fingerprints cover the named files only; this is not an immutable snapshot of the entire shared tree.

## RTD disposition and limits

1. **Structure:** Both assigned test files exist in the assigned source directories; direct whitespace/conflict-marker checks passed. Report exists at the assigned path.
2. **Compilation:** Scoped no-emit check passed; Vitest transformation passed. Parent owns top-level config and complete repository compilation.
3. **Integration:** Real local CAS/liveness modules and validation code exercised through dependency fakes. Physical-operation lifecycle is modeled with controlled I/O promises and child events. Real service/journal/authority integration was not run.
4. **Content:** 46 passing assertion-bearing tests, no skipped/todo/expected-failure tests or placeholder success claims. Unknown/incomplete accounting is asserted explicitly.
5. **User journey:** Local failure/recovery cases cover queued aborts, deadline/close ordering, pending pin I/O, replay/mismatched receipts, unavailable storage, capacity boundaries, overlapping inventory, cancellation and concurrent refresh. No actual build, guest, installed client, or owner acceptance journey was performed.
6. **Deployment:** **NOT AUTHORIZED and not attempted.**

These tests cannot establish kernel containment, root authentication in a real helper, installed binary ownership/pins, APFS state, scan completeness over an actual private namespace, real free-space headroom, VM execution, or service correctness. Nonce/count tests validate the client-side interpretation of synthetic responses; partial creates are represented only by returned accounting totals. No proof that the native service counts real partial files is claimed.

No installation, provisioning, cloud/remote calls, spend, secrets access, product helper invocation, VM/container/mount execution, real Docker, service activation, deployment, publication, commit/push/merge, cron, or cleanup of originals was performed. No production file or top-level config was edited by this worker. No parent production-fix request is outstanding from these tests.
