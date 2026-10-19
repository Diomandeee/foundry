# Linux input and census local validation — 2026-10-18

**Result: 62 tests passed across the two assigned files; scoped TypeScript checking passed.** No production fix was needed or made. This is local, fake-backed validation, not kernel-containment or deployment evidence.

Repository: `/Users/mohameddiomande/Developer/foundry-integration/source`.
Observed branch: `codex/foundry-integration-20261016`.
Observed HEAD: `cf27ac662730bb98a509af8d1d1ebea4342eef7a`.
The tree was shared and dirty on entry and remains so; HEAD alone does not identify the tested source. No existing changes were reverted, staged, committed, or cleaned up.

Authored files only:

- `packages/build-runtime/src/linux-isolated-input.test.ts` — 23 tests.
- `packages/build-runtime/src/linux-isolated-census.test.ts` — 39 tests.
- This report.

## Commands and results

All commands below ran from the repository above, with existing `node_modules`. Observed tools: Node `v24.12.0`, Vitest `5.0.3`, TypeScript `7.0.2`.

Created the assigned report directory:

```sh
mkdir -p /Users/mohameddiomande/Developer/foundry-integration/source/docs/cloud-workspaces/validation-2026-10-18
```

Exact targeted test command, run twice:

```sh
node_modules/.bin/vitest run packages/build-runtime/src/linux-isolated-input.test.ts packages/build-runtime/src/linux-isolated-census.test.ts --exclude 'docs/**' --configLoader runner --no-cache --no-fsModuleCache --attachmentsDir docs/cloud-workspaces/validation-2026-10-18/linux-test-attachments --reporter verbose
```

- First run: exit 0, 2 files passed, 62 tests passed, 19.65 s.
- Final run: exit 0, 2 files passed, 62 tests passed, 615 ms. The full-size byte assertions now use exact `Buffer.equals` comparisons instead of costly per-element matcher traversal. The foreign-project case now uses a structurally valid foreign reference so it specifically exercises project binding.
- No full suite, evidence snapshot tests, coverage, watch mode, or product executable was run. The runner config loader and disabled caches avoid bundled configuration/cache writes through the shared dependency tree. No attachments are emitted by these tests.

Exact successful scoped compilation command:

```sh
node_modules/.bin/tsc --ignoreConfig --noEmit --incremental false --target ES2022 --module ESNext --moduleResolution Bundler --types node --strict --skipLibCheck packages/build-runtime/src/linux-isolated-input.test.ts packages/build-runtime/src/linux-isolated-census.test.ts
```

Final result: exit 0, no diagnostics. This checks the two test roots and their transitively imported TypeScript source with the explicit options above; it is not a whole-repository configured build. Declaration-file checking is skipped.

Earlier compiler attempts are accounted for:

1. The same command without `--ignoreConfig` exited 1 with TS5112: this installed compiler requires explicitly ignoring the present config when naming root files on the command line. No config was edited.
2. With `--ignoreConfig`, compilation exited 1 with TS2345 at the mixed-blob fixture: inferred `Buffer<ArrayBuffer>[]` rejected a general `Buffer<ArrayBufferLike>` lookup argument. Explicitly typing the fixture array as `Buffer[]` fixed the test-only error.

Whitespace checks were run separately for both new files:

```sh
git diff --no-index --check /dev/null packages/build-runtime/src/linux-isolated-input.test.ts
git diff --no-index --check /dev/null packages/build-runtime/src/linux-isolated-census.test.ts
```

Both returned 1 for the no-index comparison against a new nonempty file, with no whitespace diagnostics. These are not recorded as exit-0 checks.

## Coverage and evidence

Input tests exercise the real `prepareLinuxInput` and `streamLinuxInput`, metadata decoder, project-input validators, reference checks, SHA-256 hashing, and stream assembly. Object reads are an in-memory map; the broker is a request/response fake. The nominal `LinuxIsolationClient` type is cast only at that fake boundary; `connect` is never called. Runtime plans and attempt contexts are inert test data, not controller-issued authority evidence.

- Mixed full-MiB chunks, shared final tails, small files, an unrelated object and empty files span two segments. Packed final objects occupy indices 0, 2 and 3. Assertions cover reordered file paths, their bound `filesHash`, total bytes, contiguous append offsets, exact reconstructed bytes, ends and final seal.
- Each mixed snapshot consumes exactly one root read, one read per segment and one read per declared data object. A later large file's full chunk does not cause its shared final blob to be reread. Required-input order remains the approved original order while streaming order changes.
- A legal maximum-count fixture has 512 segments and 8,192 files/object slots; it consumes exactly 8,705 reads. The tiny object bytes/references deliberately repeat across slots to keep this structural boundary test inexpensive. This is a read-count assertion, not a unique-object-volume or maximum-byte throughput benchmark.
- Approval changes, approved byte-cap excess, tampered root/segment/data bytes, foreign project refs, invalid generations, overlapping packed ranges, missing required inputs, case collisions, wrong whole-file digests and bad streaming ranges reject with specific errors.
- Lease loss before/after metadata reads, during source reads and after broker replies stops progress. Abort prevents a source read even when the fake broker acknowledges `file`. Incorrect identity on initial `file` or final `seal` rejects; no successful completion is inferred from a seal attempt alone.

Census tests execute the real reader with `node:fs/promises` mocked at the module boundary, a fixed clock and a temporary `process.platform` override restored after each test. No production dependency-injection API exists, and none was added.

- One or two unlinked descriptors (`nlink=0`) are closed before reopen, stale bytes are never read, and the next valid descriptor supplies the returned census.
- Three replacements exhaust the exact retry budget; all three handles close, with no fourth open and no fabricated census.
- Assertions check the exact census path, `O_RDONLY | O_NOFOLLOW`, namespace reads and bounded 4,097-byte read buffer.
- Hard links, foreign owners, writable/nonregular/empty/oversized files, unsafe ancestors, read/stat errors and size drift fail closed and close acquired descriptors.
- Malformed JSON/UTF-8, stale/future timestamps, unsafe accounting values, incorrect completeness, invalid/duplicate/excess profiles, invalid installed hashes and schema errors reject. The exact 15-second freshness boundary is accepted; unknown/incomplete workspace bytes remain `null`, while measured complete zero is preserved as zero.

## RTD verification and limits

| Level | Evidence / limit |
| --- | --- |
| Structure | Both assigned test files and this exact report path exist; explicit `ls -la` verification follows writing. |
| Compilation | Scoped no-emit strict TypeScript check passed. No top-level config changes or repository-wide build. |
| Integration | Actual local production modules run with in-memory storage, broker fakes and filesystem-boundary mocks. |
| Content | Concrete byte, digest, reference, ordering, read-count, retry-count, close-order and error-code assertions; no placeholder pass tests. |
| User journey | Metadata-to-stream-to-seal and census replacement/failure flows are covered at the local API boundary. No live worker journey. |
| Deployment | NOT AUTHORIZED and not performed. |

Tests cannot establish kernel containment. They do not test actual Linux ownership enforcement, `O_NOFOLLOW` semantics, concurrent kernel inode replacement, installed helper pins, AppArmor, user namespaces, cgroups, readonly remounts, Docker, VMs, or a running broker. No real helper/VM/mount/Docker execution, installation, provisioning, service activation, remote/cloud operation, spend, secret access, deployment, publication, commit/push/merge, cron, or cleanup of originals was performed. Read-count tests do not measure the claimed peak heap/cache ceiling. Whole-suite and configured-build ownership remains with the parent.

## Source fingerprints after the final passing run

Computed with `shasum -a 256` on the four files below:

| File | SHA-256 |
| --- | --- |
| `packages/build-runtime/src/linux-isolated-input.ts` | `b3bf115a23a9497c131d70ffc7eb78271a92ec7ab34fa2c1d7e022eb5ecedb89` |
| `packages/build-runtime/src/linux-isolated-census.ts` | `58696515bea50e732abf97c741a89e38ffe5f3cff5834e7a1f53120d0a945eab` |
| `packages/build-runtime/src/linux-isolated-input.test.ts` | `f8d794f286e5a60e9976b7fb543e6bd6537469b9a858c5c4b1165f75199b6220` |
| `packages/build-runtime/src/linux-isolated-census.test.ts` | `792783590ff2a7ab725f94f8b43d1999f188cc014c370e40b48122a74a4775e5` |
