# Submission and status transport regressions — 2026-10-18

Result: **48 tests passed in two files; scoped strict TypeScript compilation passed.**

Repository: `/Users/mohameddiomande/Developer/foundry-integration/source`.
Branch verified: `codex/foundry-integration-20261016`.

## Ownership and authorization

Read `~/AGENTS.md`, `~/SOUL.md`, `~/PROTOCOLS.md`, and this directory's `AUTHORIZATION.md`. The explicit task restrictions govern this run. Created only these repository files:

- `tools/foundry-pilot/build-submission.test.ts` — original assigned target.
- `tools/foundry-pilot/transport.test.ts` — authorized by the follow-up after the parent added worker status routing.
- This report.

No production source edits, dependency installation, real credentials, cloud activity, spending, service activation, deployment, publishing, commits, merges, cron, or cleanup. Existing shared dirty work was preserved. Each submission test creates a fresh private temporary fixture under the canonical macOS temporary directory, with prefix `foundry-submission-test-`; these fixtures are retained. Synthetic environment variables have unique random names and are removed from the test process afterward. Real credential files and values are never read.

## Submission coverage — 25 tests

Tests call the real `submitBuild`, `listBuildIntents`, `recoverBuild`, and `acknowledgeBuild` handlers, real operator-config validation, and real private-state filesystem journals. Only authority communication is replaced by a fake transport; global fetch is blocked and asserted unused.

- The intent is persisted before the fake authority accepts the command and loses its reply. Directory/file modes are verified as 0700/0600.
- After module reload and a fresh transport instance, list/recover retain the exact request ID, job ID, key, command body, and epoch. Recovery succeeds with busy placement and makes no preview/feed request. Repeated recovery does not dispatch again after success.
- A new page request for the same unacknowledged selection preserves original job/key identity, including when repeat is requested; only the new request alias is recorded.
- Unknown request/job IDs and empty-journal recovery reject without allocating an intent. Changed project/input/profile selections, reused request identity with a changed selection, and forbidden recovery fields reject without changing journal bytes or dispatching another command.
- Changed authority epoch is listed as blocked; recover/resubmit reject. Disabled actions, disallowed profiles, and changed policy binding reject. Mismatched response environment, authority ID, or epoch retains pending state.
- Pending/unknown acknowledgment rejects. Retrying acknowledgment after a discarded UI response and module reload preserves state and does not redispatch. Epoch/policy changes reject acknowledgment.
- Public receipts/list output omit capabilities, command keys, aliases, credential references, credential values, and private binding/selection hashes. Synthetic provider error details are not exposed; raw credential values are absent from the journal.

The fake authority's accepted-command map models idempotency for this handler test; it is not evidence of real authority deduplication or physical execution. The initial run found three failures caused by order-sensitive JSON comparison in this fake. Structural comparison corrected the fixture; no production change was needed.

## Status transport coverage — 23 tests

Uses the real `AuthorityTransport`, real request serialization and response parsing, and mocked global fetch returning native in-memory `Response` objects. Credential references resolve only newly assigned synthetic environment values.

- `workerStatus` posts `{}` exclusively to `/v1/worker/status`, sends the synthetic worker credential, and returns only environment/authority/epoch fields.
- Existing owner `status` continues posting `{}` to `/v1/status` with its captured owner token; discovery also retains `/v1/status`.
- Both status methods require an authority pin. Worker status rejects mismatched environment/authority and non-success replies, and revalidates after a prior successful response.
- Missing, null, zero, negative, fractional, string, and unsafe-integer epochs reject.
- Caller mutation cannot repin the frozen copied target or change the request origin.
- HTTP 401/403/409, including a synthetic stale-epoch response, reject without owner-route fallback or provider-detail exposure.
- Owner status preserves pin/epoch validation and rejects stale captured credentials before fetching. Already aborted worker-status requests do not fetch.

Boundary: `workerStatus` validates a positive safe-integer epoch and returns it; its API has no expected-epoch parameter or monotonic-epoch state. These tests do not claim transport alone rejects every stale positive epoch. Caller-level expected-epoch comparison and physical wrapper behavior are outside this assignment. Server-side authorization enforcement is also outside these mocked transport tests.

## Commands and results

Executed from the repository above, using existing dependencies only:

```sh
node node_modules/vitest/vitest.mjs run tools/foundry-pilot/build-submission.test.ts tools/foundry-pilot/transport.test.ts --maxWorkers=1 --no-file-parallelism --no-cache --configLoader=runner --reporter=verbose
```

Exit 0. Vitest 5.0.3: **2 files passed, 48 tests passed**, reported duration 1.36 seconds. Only the two owned suites were selected; no physical wrapper tests ran. Cache was disabled and config loaded through the runner.

```sh
node node_modules/typescript/bin/tsc --noEmit --ignoreConfig --target ESNext --module ESNext --moduleResolution Bundler --types node --strict --skipLibCheck tools/foundry-pilot/build-submission.test.ts tools/foundry-pilot/transport.test.ts
```

Exit 0, no diagnostics. This checks the two owned tests and their imported TypeScript dependencies, not the entire repository. Parent retains ownership of repository-wide compilation and validation.

## RTD verification

| Level | Evidence / boundary |
| --- | --- |
| Structure | Two test files at their authorized paths; report parent created with `mkdir -p`; report presence verified with `ls -la`. |
| Compilation | Scoped strict TypeScript check passed without emitting files. |
| Integration | Real handler/config/private-journal modules on fresh local filesystem fixtures; real transport with mocked fetch. |
| Content | 48 meaningful assertions-based cases cover durable identity, rejection without journal mutation, redaction, route selection, pins, and epoch validity. |
| User Journey | Local submit → lost reply → module reload → list → recover → acknowledge → reload/retry flow; no browser or physical worker acceptance claimed. |
| Deployment | Gated and not attempted. Passing fixtures do not establish physical, cloud, service, or production acceptance. |

No unresolved failure in the owned suites. Production changes remain owned by the parent.
