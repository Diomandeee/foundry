# Local verification receipt tests — 2026-10-18

**Result: 10 focused tests passed; focused TypeScript compilation passed.** No production defect was reproduced in the requested cases. The parent-owned helper and gate runner were not edited.

## Ownership and authorization

Repository: `/Users/mohameddiomande/Developer/foundry-integration/source`, branch `codex/foundry-integration-20261016`, shared dirty checkout.

This task added only `tools/local-verification-store.test.ts` and this report. Existing work was preserved. Tests and compilation used existing local dependencies. No install, provisioning, cloud request, spend, secrets, service activation, Docker/helper/VM/account execution, deployment, publication, commit, merge, or cron occurred.

Filesystem fixtures were created with this task's own `mkdtemp` calls under the resolved system temporary directory. Cleanup removed only those returned roots, including a separate task-owned temporary compiler configuration. No pre-existing directory or evidence was removed. Existing-target fixtures were asserted unchanged before fixture teardown.

## Helper review

Reviewed `tools/local-verification-store.ts` and the delegation from `JsonlDecisionStore.recordVerification` in `tools/gate-runner.ts`.

The helper checks the receipt body's SHA-256 before filesystem mutation; checks that the receipt directory is a private, owned, non-symlink directory; uses exclusive creation with `O_NOFOLLOW`; and rejects an existing target unless it is an owned, single-link, private regular file with exact size and exact serialized bytes. It syncs and closes the file, then syncs the receipt directory and its parent. A failed or partial target is retained rather than overwritten. The tests call this actual implementation without mocked filesystem operations.

No blocking production bug was found in these bounded checks. This review does not establish safety against concurrent directory/path replacement, interrupted writes, power failure, or every filesystem's durability semantics. Those were not simulated. A successful local sync/readback is not a claim of physical acceptance.

## Cases and evidence

| Case | Assertions |
| --- | --- |
| Fresh creation | Only the expected digest-named JSON file is created; directory mode 0700 and file mode 0600; regular file, current UID, one hardlink; independently read exact bytes, receipt fields, and recomputed digest. |
| Identical retry | Separately deserialized identical receipt succeeds; device/inode/mode/link count/UID/size/mtime and bytes are unchanged; an existing directory and unrelated evidence sentinel are preserved. |
| Same-length tampering | Mutated repository name retains encoded length; two retries reject with `verification receipt not durably confirmed`; existing identity and corrupt bytes remain unchanged. |
| Empty partial target | Rejects with `verification receipt identity mismatch`; zero-byte file is retained unchanged. |
| Truncated target | Missing final byte rejects with identity mismatch; partial file is retained unchanged. |
| Symlink to correct bytes | Actual symlink rejects despite a destination containing the expected receipt; link identity/target and destination identity/bytes are unchanged. |
| Dangling symlink | Actual dangling symlink rejects; symlink is retained and destination is not created. |
| Hardlinked correct receipt | Two actual hardlinks with valid bytes/private permissions reject with identity mismatch; both paths retain the same inode, link count, and bytes. |
| Wrong digest | Syntactically valid but incorrect digest rejects before any receipt directory is created. |
| Mutated body with original digest | Existing valid receipt is retained unchanged after a changed head SHA rejects as `invalid verification receipt`. |

All I/O targets, symlinks, hardlink destinations, and evidence sentinels were inside this task's own temporary roots. There were no external targets or real repository receipts.

## Validation commands

Run from the repository root:

```sh
node_modules/.bin/vitest run tools/local-verification-store.test.ts --maxWorkers 1 --no-cache --configLoader runner
```

Final result: exit 0, **1 file / 10 tests passed**, 204 ms reported duration. An initial run also passed all 10 tests; the final run followed a test-only TypeScript compatibility correction using `TextDecoder` for the independently read bytes. No other suite was run.

The focused compiler invocation used an owned temporary config extending the repository's `tsconfig.json`, preserving its local source path aliases. Its only root input was the new test file, with `include: []`, `noEmit: true`, `incremental: false`, and explicit absolute type roots pointing to this checkout's existing dependencies. Executed:

```text
<repository>/node_modules/.bin/tsc --project <own-mkdtemp>/tsconfig.json
```

Exit 0, no diagnostics. The temporary config and directory were removed in `finally`. Full-repository compilation remains parent-owned.

Compiler setup notes: the installed TypeScript package did not expose the attempted JavaScript compiler API (`ts.sys` was unavailable). A CLI attempt without repository configuration then exposed two test byte-decoding diagnostics and resolved `@foundry/stores` through the shared dependency checkout, where the new receipt type was absent. The test diagnostics were fixed only in the owned test file. Restoring the repository's configured path aliases via the scoped temporary config resolved the type import and compilation passed. No production compiler changes were needed.

## RTD verification

| Level | Outcome |
| --- | --- |
| Structure | Owned test file and requested report exist; no helper/runner edits. |
| Compilation | Focused TypeScript check using repository options and source aliases passed. |
| Integration | Actual helper, OS filesystem calls, receipt serialization/digests, symlinks, and hardlinks exercised. |
| Content | Ten substantive cases assert acceptance/refusal plus preservation of bytes and file identities. |
| User Journey | Local receipt creation, independent readback, exact retry, and refusal paths verified. The GraphVC demo and merge hook were not run by this task. |
| Deployment | Gated; not attempted. No physical or crash-durability acceptance claimed. |

## Source fingerprints

SHA-256 after the final test run:

- `tools/local-verification-store.ts`: `2e380888ac54f277610c054ac77d1f15d928c0b671337aa46c5da5b20b13d715`
- `tools/local-verification-store.test.ts`: `9a41216975bf3ed09543d45a2d508ebcb509b8008f0b4d078f8671daeff92436`
