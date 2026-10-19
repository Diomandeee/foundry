# Git absence and contract validation — 2026-10-18

Local validation passed: **5 suites, 67 tests, 0 failures**. Scoped TypeScript checking passed with **6 roots, 0 diagnostics**. Repository-wide compilation remains blocked by one diagnostic outside this task's ownership. Deployment remains gated.

## Scope and baseline

- Checkout: `/Users/mohameddiomande/Developer/foundry-integration/source`
- Branch verified before and after: `codex/foundry-integration-20261016`
- HEAD verified before and after: `cf27ac662730bb98a509af8d1d1ebea4342eef7a`
- Existing dirty work was preserved. This task edited only `packages/artifacts-port/src/git.ts`, `packages/artifacts-port/src/git.test.ts`, `packages/artifacts-port/src/cloudflare.test.ts`, `workers/gate/src/merge-iso.test.ts`, and this requested report.
- Preimages: `docs/cloud-workspaces/validation-2026-10-18/preimages/`. The Git implementation delta was reviewed against its preimage, not treated as wholly owned relative to HEAD.
- Captured initial failures: `docs/cloud-workspaces/validation-2026-10-18/vitest-initial.log` records two stale Cloudflare expectations, one stale merge-helper replay expectation, unknown-proposal SHA failure in decide, and empty-repository file lookup failure in orchestrator. The log is in the validation directory, alongside `preimages/`.
- Read `~/AGENTS.md`, `~/SOUL.md`, `~/PROTOCOLS.md`, the artifacts port interfaces, Git/Cloudflare implementations, merge implementation, decision/task callers, and existing tests before editing.

## Changes and safety assertions

Git now resolves a commit before reading history or files. A validated branch name uses `show-ref --verify --quiet`: status 1 means absent; other failures propagate. Subsequent reads use the resolved full branch commit, avoiding a same-named tag. Full SHA lookups use `cat-file --batch-check`: only an exact machine-readable `<sha> missing` record with exit 0 and empty stderr means absent. Spawn failures, nonzero exits, corruption diagnostics, unexpected output, and noncommit objects fail closed. Both command paths use the existing scrubbed Git environment.

`history()` returns `[]` and `readFile()` returns `null` for proven absence. `info()` also uses the resolver, so a broken repository no longer becomes a successful empty-repository timestamp. Existing mode/byte restrictions and merge admission/provenance checks were preserved.

Seven new Git tests cover unborn and missing branches, absent SHAs, existing immutable SHAs including uppercase input, exact whitespace preservation, missing paths, same-name branch/tag ambiguity, repository loss, dangling ref corruption, corrupt object bytes, and blob/tree IDs passed as commits.

Cloudflare implementation was unchanged. Two stale tests now supply the contract's explicit empty-history/null-file values. Nine additional cases assert exception identity for missing-looking errors (including a non-stringifiable object), reject malformed history/file results and invalid UTF-8, and preserve BOM/whitespace. Existing outage tests remain.

The merge-helper replay test now expects refusal for unchanged content without caller-proven replay. Two additional cases cover a different proposal with identical content and a seed commit with no proposal trailer. All refusal cases assert HEAD and history do not advance. This validates the helper boundary; it does not claim to prove the HTTP merger's complete replay protocol.

## Exact validation commands and results

All commands ran from the checkout above, with installed local binaries; no installation or package fetching.

Final focused run:

```sh
node_modules/.bin/vitest run packages/artifacts-port/src/git.test.ts packages/artifacts-port/src/cloudflare.test.ts workers/gate/src/merge-iso.test.ts workers/gate/src/decide.test.ts workers/orchestrator/src/tasks.test.ts --maxWorkers=1 --no-cache --reporter=verbose
```

Vitest 5.0.3; start 13:26:09 local, duration 25.62s; exit 0. No unhandled errors reported.

| Suite | Passed |
| --- | ---: |
| `packages/artifacts-port/src/git.test.ts` | 16 |
| `packages/artifacts-port/src/cloudflare.test.ts` | 13 |
| `workers/gate/src/merge-iso.test.ts` | 6 |
| `workers/gate/src/decide.test.ts` | 21 |
| `workers/orchestrator/src/tasks.test.ts` | 11 |
| Total | 67 |

The first post-edit run used the same command without `--reporter=verbose`: 66 passed, 1 failed, duration 26.42s, exit 1. Its failure was the new corruption fixture attempting to overwrite a read-only Git object. The fixture now makes that object writable inside its own temporary repository before corrupting it. The final run above exercised and passed the corruption assertions. The final suite contains 18 more cases than the captured preimage suites.

Repository-wide typecheck:

```sh
node_modules/.bin/tsc --noEmit --pretty false
```

Exit 1, one diagnostic:

```text
packages/build-runtime/src/linux-isolated-input.test.ts(116,72): error TS2339: Property 'equals' does not exist on type 'Buffer<ArrayBufferLike>'.
```

That file was not edited. This is an observed out-of-scope blocker, not a claim about when it was introduced. No repository-wide compilation success is claimed.

Scoped compilation used the repository's configuration and actual imports, restricting roots to the implementation and five requested suites. The config was passed through stdin, creating no additional project/config file. Explicit type roots make resolution independent of `/dev/stdin`'s directory:

```sh
node --input-type=module <<'NODE'
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
const files = ['packages/artifacts-port/src/git.ts', 'packages/artifacts-port/src/git.test.ts', 'packages/artifacts-port/src/cloudflare.test.ts', 'workers/gate/src/merge-iso.test.ts', 'workers/gate/src/decide.test.ts', 'workers/orchestrator/src/tasks.test.ts'].map(p => resolve(p));
const config = { extends: resolve('tsconfig.json'), files, include: [], compilerOptions: { noEmit: true, incremental: false, typeRoots: [resolve('node_modules/@types'), resolve('node_modules')] } };
const result = spawnSync('node_modules/.bin/tsc', ['--project', '/dev/stdin', '--noEmit', '--pretty', 'false'], { input: JSON.stringify(config), encoding: 'utf8' });
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
if (result.error) throw result.error;
console.log(`Scoped TypeScript: ${files.length} roots, exit ${result.status}`);
process.exitCode = result.status ?? 1;
NODE
```

Result: `Scoped TypeScript: 6 roots, exit 0`, no diagnostics. Two exploratory compilation invocations were unsuccessful tooling setup attempts: the installed TypeScript package did not expose the classic `ts.sys` API, and the first stdin-config attempt lacked explicit type roots. Neither altered project files; the exact successful replacement is above.

Structure/whitespace check (exit 0, no output):

```sh
git diff --check -- packages/artifacts-port/src/git.ts packages/artifacts-port/src/git.test.ts packages/artifacts-port/src/cloudflare.test.ts workers/gate/src/merge-iso.test.ts
```

Report creation/verification:

```sh
mkdir -p /Users/mohameddiomande/Developer/foundry-integration/source/docs/cloud-workspaces/validation-2026-10-18
ls -la /Users/mohameddiomande/Developer/foundry-integration/source/docs/cloud-workspaces/validation-2026-10-18/GIT-VALIDATION.md
```

## RTD and limits

1. Structure: four owned source/test files and this report; scoped diff whitespace check passed. Prior Git merger edits remain intact relative to the supplied preimage.
2. Compilation: six-root dependency closure passes; full repository compilation has the one out-of-scope diagnostic above.
3. Local integration: real Git CLI and isomorphic-git run only in disposable test fixtures; Cloudflare uses mocked bindings. Existing test teardown removes its own fixtures, with no general cleanup operation.
4. Content: tests distinguish positive absence from corrupt/unavailable repositories and wrong object types, preserve bytes, and refuse unproven no-op replay.
5. Caller journey: all 21 decide tests and all 11 task tests pass, including unknown proposal rejection, genesis decisions, missing pushed branches, empty-base task creation, advisory failure handling, and scope enforcement. These are local caller journeys, not deployed service proofs.
6. Deployment: gated and not attempted. No installation, cloud requests, credential access, deployment, provisioning, commits, merges, or service calls were performed against the shared checkout or real infrastructure. Fixture commits/pushes are local test mechanics only. No cleanup of shared files or history occurred.

Full repository tests were not rerun. Live Cloudflare behavior, HTTP clone/push, permissions on real repositories, remote races, and deployed Worker behavior remain outside this evidence. Concurrent edits after this validation require checking the hashes below before relying on this receipt.

## Validated file SHA-256

```text
4937500a7394d95a1eb97eeb36a1dc8a6e3b66d6544c9b8eb1e6b01b6b883a86  packages/artifacts-port/src/git.ts
567f0a6e2feb7e8c0b19612c759a04ebb7303813de014f159b8c48ec7ab25f85  packages/artifacts-port/src/git.test.ts
99f3f102d57ebbb3ddfcf8505627ef2ecc554203ed1e7759e86284b71891420a  packages/artifacts-port/src/cloudflare.test.ts
79a12e531a7bcba6c926fa9fba242406dc23d3086af865c8904775c42d0a4070  workers/gate/src/merge-iso.test.ts
8431b378830dcbaf8bd13050d3e567d26bcd62e1e82683ad737f4bde60f4f717  workers/gate/src/decide.test.ts
02af89624906f0a77a0b7a16866d45ec2b3d79676bb721ea2631b47849a43a24  workers/orchestrator/src/tasks.test.ts
```
