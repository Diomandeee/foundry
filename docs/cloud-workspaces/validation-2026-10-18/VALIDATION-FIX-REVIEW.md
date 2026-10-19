# Validation fix and independent source review — 2026-10-18

**Current disposition: both local-demo P2 findings are resolved by final source readback; no open actionable finding remains within this review's scope.** Original findings and their historical fingerprints remain below. Root TypeScript checking passed earlier after the owned test fix; that result is not extended to later changes. This is a bounded source review, not runtime or deployment approval.

Repository: `/Users/mohameddiomande/Developer/foundry-integration/source`, shared dirty working tree. Comparisons used the actual current files against corresponding files under `docs/cloud-workspaces/validation-2026-10-18/preimages/`, not against HEAD. Other contributors' changes were not reverted or edited.

## Owned fix and compilation

The reported `Buffer.equals` assertion was still present at `packages/build-runtime/src/linux-isolated-input.test.ts:116`. Replaced:

```ts
expect(restored.get(path)?.equals(bytes), path).toBe(true);
```

with:

```ts
expect(restored.get(path), path).toEqual(bytes);
```

This preserves full expected-versus-actual buffer comparison and also fails if the restored file is absent. It removes reliance on `Buffer.equals` from the merged Cloudflare/Node declaration surface. No production files or top-level configs were edited in this pass.

Ran exactly this compilation command from the repository root after the edit:

```sh
node_modules/.bin/tsc --noEmit
```

Result: **exit 0, no diagnostics**, using the actual root `tsconfig.json`, including its mixed Cloudflare/Node types. No `--ignoreConfig` or type override was used. No tests, product imports/probes, native compiler commands, helpers, services, containers, mounts, remote calls or other operational checks were run in this pass.

The earlier `LINUX-TESTS.md` records a historical passing test run and its then-current fingerprints. Its `Buffer.equals` performance note and input-test hash no longer describe the current test file. Runtime tests were not rerun for this assertion-only change, per this pass's compilation-only instruction. The original deep-buffer assertion passed in the initial 62-test run, but that is not represented as a new run.

## Independent review

### Worker status authorization and callers

Reviewed production diffs in `workers/compute/src/authority.ts`, `packages/worker-client/src/index.ts`, `tools/foundry-pilot/transport.ts` and `tools/foundry-pilot/worker-host.ts`. Read the unchanged supporting authentication, enrollment and outer worker dispatch implementations, plus current route/client/transport tests as source only.

- `authority.ts:155` includes `/v1/worker/status` in the read-only authentication set; its body is required to be exactly `{}`. Authentication runs again after the asynchronous bounded body read (`:167`), so revocation during body streaming does not retain the first authentication result.
- `authority.ts:168` keeps `/v1/status` owner-only. The separate worker route requires both executor role and an enrollment binding. A static executor token without enrollment cannot pass the worker route, including when enrollment is disabled. Owner credentials cannot use the executor-only route.
- `WorkerEnrollment.authenticateDigest` checks nonrevocation, expiry and current credential revision. Read-only authentication uses the observed monotonic time. It deliberately does not require an already-fresh heartbeat for status discovery, allowing the worker to authenticate before its first heartbeat. Work admission still applies its existing freshness checks.
- Worker status returns the same narrow authority metadata fields as owner status; no inventory, credential, lease capability or command surface is added. The outer worker forwards to its configured authority and has no conflicting route allowlist.
- `AuthorityTransport.workerStatus` requires an existing authority pin, uses the fixed-origin bounded transport, verifies environment and authority identity, and validates a positive safe-integer epoch. The general worker checks that epoch against its configured epoch. Owner `status` and owner discovery retain `/v1/status`, including the existing captured-token binding path.
- The general host's explicit fetch allowlist includes the new worker status route. `boundedStep` uses it before heartbeat admission, again before execution and before upload, checking all configured pins and epoch. Status denial has no fallback to the owner route. Terminal journal replay still returns the already-recorded summary without new work.
- The edge-host path is unchanged by this repair; this review does not treat it as newly validated or expand the fix's scope to it.

No actionable defect identified in this change set. Current source tests cover worker/owner role separation, revocation, malformed body, binding mismatches, fixed routes and preserved owner transport behavior. Those tests were inspected, not executed by this reviewer.

### Relay invalid JSON sanitization

Reviewed `packages/library-revocation/src/http.ts:33` against its preimage and read the surrounding operation/cleanup path. The new inner catch covers both fatal UTF-8 decoding and `JSON.parse`, replacing their exception text with `HttpFailure(400, 'relay-invalid-json')`. It does not interpolate response bytes into the error. Existing byte/chunk bounds, outer deadline, descriptor cancellation and physical occupancy accounting remain in place. Other transport failures are outside this narrow sanitization change.

`ignoreBOM:false` explicitly supplies the prior decoder default; it does not itself tighten BOM handling. The malformed-response test asserts HTTP 400. This source review finds no sanitization regression; it does not claim the current tests exhaustively prove nondisclosure for all transport exception sources.

### Swift ACL casts

Reviewed the exact two-line change in `packages/build-runtime/native/mac-vm-host.swift:136`: `ACL_FIRST_ENTRY` now passes its raw value converted to `Int32`, and the ACL pointer is explicitly converted to `UnsafeMutableRawPointer` for `acl_free`. The cast changes preserve the existing selector, pointer address, call order, captured errno and fail-closed acceptance predicate. No ACL permission check was removed or made conditional on compile success.

The parent's existing `native-link-repair.json` records a successful Swift link command. That is inherited evidence only; no Swift compilation or helper execution was repeated here. Source review of these casts cannot establish filesystem ACL enforcement or containment.

### Source-only root configuration

Compared `tsconfig.json` and `vitest.config.ts` to their preimages. TypeScript compiler settings and aliases are unchanged apart from formatting; the semantic addition is the explicit `packages/**/*.ts`, `workers/**/*.ts`, `tools/**/*.ts`, and `vitest.config.ts` include list. Vitest adds the corresponding three source-root `*.test.ts` patterns. Historical evidence below `docs/` is excluded from root discovery by construction.

A read-only `rg --files` inventory of `.ts`, `.tsx`, `.mts` and `.cts` found no current TypeScript files outside the admitted source roots/root Vitest config after excluding `docs/` and `node_modules/`, and no non-`.ts` TypeScript files inside those source roots. Thus no current discoverable source file was identified as silently dropped by these additions. Future new source roots or extensions must be added deliberately; transitive imports can still pull files into a TypeScript program regardless of root discovery patterns.

## RTD and authority boundary

| Level | Result |
| --- | --- |
| Structure | Owned assertion and review report exist at assigned paths; report verified with `ls -la` after writing. Actual preimages/current files compared. |
| Compilation | Root `node_modules/.bin/tsc --noEmit` passed after the owned fix. |
| Integration | Static tracing across server authorization, enrollment, host allowlist, transport and client; no new runtime integration claim. |
| Content | Exact buffer comparison retained; concrete checks reviewed for role/pin/epoch binding and fixed parse errors. |
| User journey | Source-traced status → heartbeat → poll → execution → upload and denial/revocation paths; no new executed journey. |
| Deployment | Not authorized and not performed. Tests/source review cannot establish kernel containment. |

No new production repair is requested from the parent based on this bounded review. Parent retains overall-suite and operational acceptance ownership.

## Reviewed current fingerprints

SHA-256 captured from local bytes after review; the shared tree is not an atomic frozen snapshot.

| File | SHA-256 |
| --- | --- |
| `packages/build-runtime/src/linux-isolated-input.test.ts` | `60bf953b7a62204a6d2b32612dd6e676ccdcdf9075f686579a0c6c19fb9cb80e` |
| `workers/compute/src/authority.ts` | `83dec19805e6dccf1e8c1e0ae699bc3b54a485ad29d50703f4d6d3392f501068` |
| `packages/worker-client/src/index.ts` | `207934f75ee67ce2cc2ccef311ee730dccae463e54a1b7f9724c8138de322cba` |
| `tools/foundry-pilot/transport.ts` | `9d9dd92334c7ce6089aba1adfab735815d665a36887148553654680e3f0c5a2d` |
| `tools/foundry-pilot/worker-host.ts` | `23b5616ce13efc686732f5c4480a818a29b8e3749e45a73fc87e5446339bf05e` |
| `packages/library-revocation/src/http.ts` | `b2e2c4cb0c73be7edb1ec16469cb221b32e545864661f1261c1680bd699627a5` |
| `packages/build-runtime/native/mac-vm-host.swift` | `1b8b068cc89de558dc854e1730143f8d284220f75b499f44d917d22f7582137d` |
| `tsconfig.json` | `aaaed6f36cfaad7f04b39ff2bbbcb5adeecba9f635788d18f23414667197c1a8` |
| `vitest.config.ts` | `7694f8b08e774f1a96dd793acfb46d7fadb644740712359e2c14d0dd9c178b0e` |

## Addendum: local verification receipts and non-destructive demo roots

Source-only review of the new `tools/local-verification-store.ts` (no validation preimage) and the actual diffs for `tools/gate-runner.ts`, `tools/graphvc-demo.ts` and `package.json` against their validation preimages. Also read the receipt producer, gate pipeline, Git adapter, hook template and current helper/demo tests. No tests, compiler, bundle, demo, Git mutation, activation or remote operation was executed in this addendum. The parent owns the executing full suite.

### Actionable findings

Historical findings at the addendum snapshot; both are source-verified resolved in the final readback below. The original descriptions are preserved for traceability.

**P2 — Reject corrupt UTF-8 bytes instead of comparing lossy decoded strings.** `tools/local-verification-store.ts:32` checks `bytes.toString('utf8') === encoded`. This is not exact-byte readback: Node's nonfatal UTF-8 decoder replaces malformed sequences with U+FFFD. A valid receipt can contain U+FFFD in a run name or other unrestricted string. If its persisted `EF BF BD` bytes are corrupted to the three-byte incomplete sequence `F1 80 80` immediately before the next ASCII character, decoding consumes that malformed sequence as the same single replacement character. File length and decoded text still match, so the existing corrupt receipt is accepted and synced. The hash check at function entry checks the supplied in-memory body, not the persisted bytes. This violates the helper's corrupt/collision refusal semantics even without assuming a hostile process or defeating filesystem ownership. Fix by comparing the actual byte buffer to the expected UTF-8 bytes, or by combining fatal decoding with the equality check; retain the create-only behavior. Parent regression case: a valid receipt containing U+FFFD, existing same-length malformed UTF-8 at its digest-named file, refusal with original bytes/inode preserved. This is a source-derived case, not an executed reproduction.

**P2 — Update the existing demo test to pass an uncreated child root.** The new `tools/graphvc-demo.ts:28` intentionally rejects every existing explicit root via nonrecursive `mkdir`, but `tools/graphvc-demo.test.ts:22` still creates its root with `mkdtempSync` and passes that same existing directory as `--root` at line 25. Consequently the existing end-to-end test now rejects with `EEXIST` before exercising the gate. Keep the new production refusal; change the fixture to own a temporary parent and pass a nonexistent child as the demo root, retaining cleanup only for its owned parent. This finding is based on the current test source, not a report of the parent's still-running suite. Do not restore recursive deletion or silently reuse an existing root to make the test pass.

### Reviewed behavior with no additional finding

- **Durability ordering:** newly created receipts are written and fsynced before close. Both creation and existing-file retry then reopen/read back, fsync the file descriptor, fsync the receipt directory and fsync its immediate parent before returning. The gate awaits `recordVerification` before any merge. Sync/read/close failures propagate; only an initial create collision is treated as a retry. This is the intended local filesystem durability sequence, not a power-loss experiment or a promise about unsupported filesystems.
- **Collision and partial-write handling:** `O_CREAT | O_EXCL` prevents overwrite; `created` prevents a later write/sync/close failure from being swallowed as `EEXIST`. Empty/truncated files fail the size check. Same-size differing ASCII content fails readback. An identical complete receipt can be confirmed and synced on retry without replacement. Concurrent creation can conservatively refuse a reader that sees a partial file; it cannot turn that partial file into success. The UTF-8 exception above is the identified gap.
- **Symlinks and scope:** the receipt directory itself is checked with `lstat` for directory type, current UID and private permissions. Receipt opens use `O_NOFOLLOW`; existing hard links fail `nlink === 1`. Directory fsync opens also use `O_NOFOLLOW` on their final component. These checks do not constitute recursive ancestor validation, directory-descriptor-relative traversal, or protection from same-UID rename races. The file remains owner-writable (`0600`); immutability here is the helper's create-only contract, not a kernel-enforced seal. Those limitations fit the explicitly trusted local hook scope and are not reported as new containment defects.
- **Gate delegation:** `JsonlDecisionStore.recordVerification` now delegates to the helper under `decisions.jsonl.verification`. The existing pipeline builds a bounded digest-bound receipt and awaits storage before merge, closing the missing local-store method integration gap. No verifier is enabled merely by adding this method: the local default still records `checked:false` when no verifier is supplied, under the existing policy.
- **Fresh-root behavior:** absent `--root`, `mkdtemp` creates a unique directory. A supplied nonempty root is created exclusively, so existing directories/files/symlinks refuse before demo setup; recursive deletion of the old root is removed. The package script drops its fixed `/tmp/foundry-graphvc` argument so the default follows this fresh-root path. The script still bundles the runner before starting the demo. Neither the script nor demo was invoked here.

### RTD addendum

Structure: actual new helper and preimage-backed integration/config diffs inspected; this report updated in its assigned path. Compilation: not rerun; the earlier root result predates this added helper and must not be extended to it. Integration/content/user journey: source-traced receipt-before-merge ordering, file state/error handling and fresh-root caller compatibility, with the two findings above. Deployment/activation: not authorized and not performed. No kernel-containment claim.

### Addendum source fingerprints

Local SHA-256 values captured during review; shared-tree changes after capture require reevaluation.

| File | SHA-256 |
| --- | --- |
| `tools/local-verification-store.ts` | `2e380888ac54f277610c054ac77d1f15d928c0b671337aa46c5da5b20b13d715` |
| `tools/gate-runner.ts` | `866737481ee403e5454cd5eb44b47e1952c5ffdaec70388efdc38696c45ff655` |
| `tools/graphvc-demo.ts` | `2ed4ce2f6e4fc55e057b3d6be8c71c2b8d0aea01686af6abea96e0d21e19acd1` |
| `tools/graphvc-demo.test.ts` | `d00373d370e1fe93617b475219bebddfefdf01f40c1d8bba07289eba057845ee` |
| `package.json` | `12f47b19d8455c7a8432fb67b5227c71a69d75522d9552429712c1967dbb4dc9` |

## Final bounded readback: both P2 findings resolved

Read the current helper and both regression-test files without running tests or compilation. Only this report was changed in this pass.

1. **Corrupt UTF-8 acceptance — resolved in source.** The helper now constructs `expectedBytes` from the serialized receipt and rejects any unequal byte using `some()`. The existing stat-size and read-count checks ensure both sequences have the expected length, so lossy decoding is no longer involved. The write/create flags, private-file checks, close handling and fsync sequence remain intact. The added regression uses U+FFFD in a valid receipt, replaces its three UTF-8 bytes with `F1 80 80`, explicitly demonstrates equal lossy-decoded text, then requires refusal and unchanged raw bytes and file identity. This addresses the precise reported failure without replacing corrupt evidence.
2. **Existing-root demo fixture — resolved in source.** The success test now owns a `mkdtempSync` parent and passes its nonexistent `demo` child as `--root`. Cleanup remains scoped to the test-owned parent. A separate existing-destination test expects failure and verifies a sentinel's contents are preserved. Both use the local `tsx` executable and explicitly disable LKG writes. The success test additionally binds the recorded receipt to the pushed SHA, checks the advisory `checked:false` verdict and compares the stored receipt with the decision. Production fresh-root refusal remains unchanged.

**Evidence attribution:** the parent reported 78 targeted tests passed and a focused UTF-8 regression run still in progress. These are parent-reported status, not independently executed or verified test results in this readback. No passing result is claimed here for that pending focused run. Final disposition closes the source findings; runtime acceptance remains with the parent.

RTD: structure and changed assertion/control-flow content inspected; integration and failure journeys reviewed from source; compilation/tests not repeated; deployment and activation remain unauthorized and unperformed. Existing trusted-local-hook and kernel-containment limitations remain unchanged.

Current SHA-256 fingerprints (earlier tables are retained as historical evidence):

| File | SHA-256 |
| --- | --- |
| `tools/local-verification-store.ts` | `ddedcbf4a2c1406a7dc4c26a433286fa630000ce722575a35b336d5536fd8f26` |
| `tools/local-verification-store.test.ts` | `488c12f022e919f19491c73b5b1754d84cab6ee2c0bcbc4f0fd30e407cd24457` |
| `tools/graphvc-demo.ts` | `2ed4ce2f6e4fc55e057b3d6be8c71c2b8d0aea01686af6abea96e0d21e19acd1` |
| `tools/graphvc-demo.test.ts` | `48cbafcd93c62188da962b319bc18f33ecc92de08d9e8260deed71f35e21074d` |
